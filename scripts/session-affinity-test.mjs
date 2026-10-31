/**
 * Session affinity for the forward listener.
 *
 * The free lane accounts quota per upstream session, and before this module the
 * listener pinned every id-less caller to one seed (`forward:shared`). These
 * checks keep the replacement honest: same conversation → same seed, different
 * conversations → different seeds, the first-turn fingerprint catches clients
 * that send no identifier at all, and an idle key really does get a new session.
 *
 * The listener test drives the real `startForwardServer` with a stub completion,
 * so the wiring (header → thunk → request.sessionKey) is covered too, not just
 * the store.
 *
 * Run: node scripts/session-affinity-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSessionAffinity } from '../src/session-affinity.js'
import { configureSessionStore, sessionForConversation } from '../src/upstream.js'
import { startForwardServer } from '../src/forward.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}\n${error.stack?.split('\n').slice(1, 3).join('\n') ?? ''}`) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-affinity-'))
configureSessionStore(dir)
const req = headers => ({ headers })
const body = (text = 'hello') => ({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: text }] })
const readMap = () => JSON.parse(fs.readFileSync(path.join(dir, 'session-map.json'), 'utf8')).sessions

check('header identity is sticky across turns and distinct across conversations', () => {
  let now = 1_000_000
  const affinity = createSessionAffinity({ dataDir: dir, ttlMinutes: 30, maxEntries: 64, now: () => now })
  const a1 = affinity.resolve(req({ 'session-id': 'conv-a' }), body('first'), { apiKey: 'k' })
  const a2 = affinity.resolve(req({ 'session-id': 'conv-a' }), body('second'), { apiKey: 'k' })
  const b = affinity.resolve(req({ 'session-id': 'conv-b' }), body('first'), { apiKey: 'k' })
  assert.match(a1, /^aff:[0-9a-f-]{36}$/)
  assert.equal(a1, a2, 'same header must keep the same session')
  assert.notEqual(a1, b, 'different conversations must not share a session')
  const idA = sessionForConversation(a1)
  const idB = sessionForConversation(b)
  assert.notEqual(idA, idB)
  assert.equal(readMap()[a1], idA, 'seed and upstream id are persisted together')
  now += 1
  affinity.close()
})

check('no identifier falls back to the first user turn, not one global seed', () => {
  const affinity = createSessionAffinity({ dataDir: dir, ttlMinutes: 30, maxEntries: 64 })
  const one = affinity.resolve(req({}), body('write a haiku'), { apiKey: 'k' })
  const same = affinity.resolve(req({}), body('write a haiku'), { apiKey: 'k' })
  const other = affinity.resolve(req({}), body('summarise a diff'), { apiKey: 'k' })
  assert.equal(one, same, 'a conversation must keep its seed as the history grows')
  assert.notEqual(one, other, 'a new conversation must get a new seed')
  affinity.close()
})

check('claude-code metadata.user_id session segment is honoured', () => {
  const affinity = createSessionAffinity({ dataDir: dir, ttlMinutes: 30, maxEntries: 64 })
  const meta = { model: 'x', messages: [], metadata: { user_id: 'user_ab12_account_cd34_session_99999999-1111-2222-3333-444444444444' } }
  const one = affinity.resolve(req({}), meta, { apiKey: 'k' })
  const two = affinity.resolve(req({}), meta, { apiKey: 'k' })
  assert.equal(one, two)
  affinity.close()
})

check('an idle conversation expires and forgets its old upstream id', () => {
  let now = 5_000_000
  const affinity = createSessionAffinity({ dataDir: dir, ttlMinutes: 30, maxEntries: 64, now: () => now })
  const before = affinity.resolve(req({ 'session-id': 'idle' }), body(), { apiKey: 'k' })
  const id = sessionForConversation(before)
  now += 31 * 60 * 1000
  const after = affinity.resolve(req({ 'session-id': 'idle' }), body(), { apiKey: 'k' })
  assert.notEqual(after, before, 'expired seed must not be reused')
  assert.equal(readMap()[before], undefined, 'expired seed must be removed from the session map')
  const fresh = sessionForConversation(after)
  assert.equal(readMap()[after], fresh, 'new seed gets a fresh id')
  assert.notEqual(fresh, id)
  affinity.close()
})

check('the affinity table survives a restart while the TTL is running', () => {
  const now = 9_000_000
  const first = createSessionAffinity({ dataDir: dir, ttlMinutes: 30, maxEntries: 64, now: () => now })
  const seed = first.resolve(req({ 'session-id': 'restart' }), body(), { apiKey: 'k' })
  first.close()
  const second = createSessionAffinity({ dataDir: dir, ttlMinutes: 30, maxEntries: 64, now: () => now })
  assert.equal(second.resolve(req({ 'session-id': 'restart' }), body(), { apiKey: 'k' }), seed)
  second.close()
})

check('affinity disabled keeps the historical per-user seed', async () => {
  const disabled = createSessionAffinity({ dataDir: dir, enabled: false })
  assert.equal(disabled.resolve(req({ 'session-id': 'x' }), body(), { apiKey: 'k' }), undefined)
  disabled.close()
})

await checkAsync('listener passes one affinity seed per conversation to the lane', async () => {
  const seen = []
  const server = await startForwardServer({
    dataDir: dir,
    config: () => ({ host: '127.0.0.1', port: 0, enabled: true, key: 'test-key', sessionAffinity: { enabled: true, ttlMinutes: 30, maxEntries: 64 } }),
    complete: async request => {
      seen.push(request.sessionKey?.())
      return { text: 'ok', toolCalls: [], usage: undefined }
    },
    modelRows: () => [{ id: 'deepseek-v4.1-flash-free', object: 'model', created: 0, owned_by: 'test' }],
  })
  try {
    const post = async header => {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-key', 'content-type': 'application/json', ...header },
        body: JSON.stringify({
          model: 'deepseek-v4.1-flash-free',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 8,
          stream: false,
        }),
      })
      assert.equal(response.status, 200)
    }
    await post({ 'x-session-id': 'listener-a' })
    await post({ 'x-session-id': 'listener-a' })
    await post({ 'x-session-id': 'listener-b' })
    assert.equal(seen.length, 3)
    assert.equal(seen[0], seen[1], 'same header → same seed through the listener')
    assert.notEqual(seen[0], seen[2], 'different header → different seed through the listener')
  } finally {
    await server.close()
  }
})

fs.rmSync(dir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} session-affinity check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nsession affinity: all checks passed')
}
