/**
 * Downstream-conversation → upstream-session affinity, for the forward listener.
 *
 * The OpenCode free lane accounts its quota **per upstream session** and a
 * session is identified by the `ses_…` id this plugin mints. Before this module
 * the listener had one seed (`forward:shared`) for every request that did not
 * carry a `user` field, so every client on the machine — and every conversation
 * of every client — drew from the same quota bucket and shared the same upstream
 * KV state.
 *
 * The policy here is the one new-api calls channel affinity: extract a stable key
 * from the request (a header first, then a few well-known JSON-body paths),
 * remember the upstream session chosen for that key, and keep handing the same
 * one back while the key stays active. An idle key expires after `ttlMinutes`;
 * the next request under that key mints a fresh upstream session. The store is
 * bounded (`maxEntries`, LRU) and persisted next to the rest of the product's
 * state, so a restart does not silently collapse every conversation back onto
 * one session.
 *
 * Key precedence, highest first:
 *
 * 1. explicit headers — `session-id` / `session_id` / `x-session-id`,
 *    `conversation-id` / `conversation_id` / `x-conversation-id` (Codex sends
 *    the underscore form, some proxies rewrite it to the hyphen form);
 * 2. explicit body fields — `metadata.session_id`, `session_id`,
 *    `conversation_id`, `conversation`, `chat_id`, `prompt_cache_key` (also
 *    under `metadata`);
 * 3. Claude Code's `metadata.user_id`, whose trailing `_session_<uuid>` names
 *    the conversation even though the field is called user id;
 * 4. OpenAI's `user` field (per end-user, not per conversation — still narrower
 *    than one bucket for the whole host);
 * 5. a fingerprint of the API key + model + first user message. Clients that
 *    send no identifier at all (bare OpenAI SDK scripts, most chat UIs) still
 *    get one session per conversation because the first user turn is stable
 *    across the turns of that conversation;
 * 6. the API key alone, when there is no user text to fingerprint (tool-only or
 *    empty turns).
 *
 * Nothing about the caller's identity is stored: entries are keyed by a SHA-256
 * of `api key + kind + value`, and the value only lives in memory for the hash.
 *
 * @module src/session-affinity.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { configureSessionStore, forgetSession } from './upstream.js'

const FILE = 'session-affinity.json'
const SEED_RE = /^aff:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ID_RE = /^[0-9a-f]{64}$/
const DEFAULT_TTL_MINUTES = 30
const DEFAULT_MAX_ENTRIES = 1024
const MAX_VALUE = 1024
const FLUSH_MS = 1000

/** Header names in precedence order. Node lowercases inbound header names. */
const HEADER_KEYS = [
  'session-id', 'session_id', 'x-session-id', 'x-session_id',
  'x-claude-code-session-id',
  'conversation-id', 'conversation_id', 'x-conversation-id', 'x-conversation_id',
]

/** JSON-body paths in precedence order; every segment is a plain object key. */
const BODY_PATHS = [
  ['metadata', 'session_id'], ['metadata', 'sessionId'],
  ['metadata', 'conversation_id'], ['metadata', 'conversationId'],
  ['session_id'], ['sessionId'],
  ['conversation_id'], ['conversationId'],
  ['conversation'], ['chat_id'], ['prompt_cache_key'],
]

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    return part?.text ?? part?.input_text ?? part?.output_text ?? ''
  }).join('')
}

/** The first user turn, which stays byte-stable across the turns of one chat. */
function firstUserText(body) {
  if (typeof body?.input === 'string') return body.input
  const rows = Array.isArray(body?.messages) ? body.messages
    : Array.isArray(body?.input) ? body.input
      : Array.isArray(body?.contents) ? body.contents
        : []
  for (const row of rows) {
    if (row?.role !== 'user') continue
    const text = textOf(row.content ?? row.parts)
    if (text.trim() !== '') return text
  }
  return ''
}

/** `user_…_account_…_session_<uuid>` → `<uuid>`, else ''. */
function claudeSession(userId) {
  if (typeof userId !== 'string') return ''
  return /(?:^|[_-])session[_-]([0-9a-f][0-9a-f-]{7,})/i.exec(userId)?.[1] ?? ''
}

function readPath(body, keys) {
  let current = body
  for (const key of keys) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return ''
    current = current[key]
  }
  return typeof current === 'string' ? current.trim() : ''
}

function headerValue(value) {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  return text === '' || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text) ? '' : text
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * The conversation identity carried by one request, or undefined when the
 * request offers nothing better than a per-key session.
 *
 * `kind` is part of the entry key, so a header `abc` and a body field `abc` are
 * different conversations — a client that rotates its header must not inherit the
 * session of a different client's body field.
 */
export function affinityIdentity(req, body, { apiKey = '' } = {}) {
  const headers = req?.headers ?? {}
  for (const name of HEADER_KEYS) {
    const value = headerValue(headers[name])
    if (value !== '') return { kind: `header:${name}`, value }
  }
  for (const keys of BODY_PATHS) {
    const value = readPath(body, keys)
    if (value !== '' && value.length <= MAX_VALUE) return { kind: `body:${keys.join('.')}`, value }
  }
  const session = claudeSession(readPath(body, ['metadata', 'user_id']))
  if (session !== '') return { kind: 'claude-user-id', value: session }
  const user = readPath(body, ['user'])
  if (user !== '' && user.length <= MAX_VALUE) return { kind: 'user', value: user }

  const first = firstUserText(body).replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE)
  if (first !== '') {
    const model = String(body?.model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
    return { kind: 'fingerprint', value: `${model}\n${first}` }
  }
  if (apiKey !== '') return { kind: 'api-key', value: '' }
  return undefined
}

function envNumber(name) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return undefined
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * @param {object} options
 * @param {string|undefined} options.dataDir - where the affinity table lives;
 *   without it the store stays in memory (unit tests, non-forward callers).
 * @param {boolean} [options.enabled]
 * @param {number} [options.ttlMinutes]
 * @param {number} [options.maxEntries]
 * @param {() => number} [options.now] - injectable clock for tests.
 */
export function createSessionAffinity({
  dataDir,
  enabled = true,
  ttlMinutes,
  maxEntries,
  now = Date.now,
} = {}) {
  const envEnabled = process.env.OFM_SESSION_AFFINITY
  const active = envEnabled === '0' || envEnabled === 'false' ? false : enabled !== false
  const ttl = (envNumber('OFM_SESSION_TTL_MINUTES') ?? (Number.isFinite(Number(ttlMinutes)) ? Number(ttlMinutes) : DEFAULT_TTL_MINUTES)) * 60_000
  const max = Math.max(1, envNumber('OFM_SESSION_MAX') ?? (Number.isFinite(Number(maxEntries)) ? Math.trunc(Number(maxEntries)) : DEFAULT_MAX_ENTRIES))
  const file = typeof dataDir === 'string' && dataDir !== '' ? path.join(dataDir, FILE) : undefined
  const entries = new Map()
  let dirty = false
  let timer

  if (file !== undefined) {
    // The session map must land in this product's data directory, not under
    // ~/.dsh — a standalone service does not share state with the plugin.
    configureSessionStore(dataDir)
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const current = now()
      for (const [id, row] of Object.entries(parsed?.entries ?? {})) {
        if (!ID_RE.test(id) || !SEED_RE.test(String(row?.seed ?? '')) || !Number.isFinite(row?.at)) continue
        if (current - row.at >= ttl) { forgetSession(row.seed); continue }
        entries.set(id, { seed: row.seed, at: row.at })
      }
      while (entries.size > max) {
        const [oldId, old] = entries.entries().next().value
        entries.delete(oldId)
        forgetSession(old.seed)
      }
    } catch { /* first run or unreadable table: start empty */ }
  }

  function persist() {
    if (file === undefined || !dirty) return
    dirty = false
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const body = JSON.stringify({
        version: 1,
        at: now(),
        entries: Object.fromEntries(entries),
      }, undefined, 2)
      const temp = `${file}.tmp`
      fs.writeFileSync(temp, body, { mode: 0o600 })
      fs.renameSync(temp, file)
    } catch { /* non-fatal: a conversation may get a new session after a restart */ }
  }

  function schedule() {
    if (file === undefined || timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; persist() }, FLUSH_MS)
    timer.unref?.()
  }

  function evictOldest() {
    const [oldId, old] = entries.entries().next().value ?? []
    if (oldId === undefined) return
    entries.delete(oldId)
    forgetSession(old.seed)
  }

  function touch(id, entry) {
    // Map insertion order is the LRU order: re-insert on use.
    entries.delete(id)
    entries.set(id, entry)
    dirty = true
    schedule()
  }

  /**
   * Resolve the upstream session seed for one downstream request.
   *
   * The returned value is a seed, not a `ses_…` id: the adapter's
   * `sessionForConversation` mints and remembers the id (with a real creation
   * timestamp, which the upstream validates). Expiry drops both the seed and its
   * remembered `ses_…` id, so a stale conversation cannot camp on one bucket.
   *
   * @returns {string|undefined} `aff:<uuid>`, or undefined when affinity is off
   *   or the request carries nothing to key on.
   */
  function resolve(req, body, { apiKey = '' } = {}) {
    if (!active) return undefined
    const identity = affinityIdentity(req, body, { apiKey })
    if (identity === undefined) return undefined
    const id = sha256(`${apiKey}\u0000${identity.kind}\u0000${identity.value}`)
    const at = now()
    const existing = entries.get(id)
    if (existing !== undefined && at - existing.at < ttl) {
      existing.at = at
      touch(id, existing)
      return existing.seed
    }
    if (existing !== undefined) {
      entries.delete(id)
      forgetSession(existing.seed)
    }
    while (entries.size >= max) evictOldest()
    const seed = `aff:${crypto.randomUUID()}`
    entries.set(id, { seed, at })
    dirty = true
    schedule()
    return seed
  }

  return {
    resolve,
    enabled: active,
    ttlMs: ttl,
    maxEntries: max,
    get size() { return entries.size },
    stats: () => ({ enabled: active, ttlMs: ttl, maxEntries: max, size: entries.size }),
    flush: persist,
    close() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      persist()
    },
  }
}
