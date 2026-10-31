/**
 * The lane's own egress: one switchable outlet every upstream request walks out
 * through.
 *
 * Three call sites make the requests the region gate and the per-IP pools see —
 * `postStreamed` and `getJson` in src/http.js, `detectEgress` in src/probe.js —
 * and all three used to be a bare `fetch`. This module keeps them on `fetch`
 * and moves the routing underneath: with an outlet configured, `egressFetch`
 * rewrites the call to a loopback relay it owns, and the relay opens the real
 * connection through the outlet. The call sites keep their bodies, headers,
 * signals and `redirect: 'error'` policy verbatim, so a proxied turn and a
 * direct one differ in exactly one thing: which socket leaves this machine.
 *
 * Two outlet shapes, one dialer:
 *
 *   - `client`   — an http/https/socks5 proxy address that already exists (the
 *                  user's own client, a LAN gateway). The plugin dials it.
 *   - `subscription` — the plugin spawns mihomo (Clash Verge's core, or any
 *                  mihomo/clash binary found on the machine) with a
 *                  proxy-provider pointing at the subscription URL and a
 *                  url-test group that re-measures every node every five
 *                  minutes. The lowest-latency node wins, a 429 in the
 *                  health-check marks the node dead and takes it out of the
 *                  rotation, and the plugin only ever dials the local mixed
 *                  port — it never parses a vless/vmess/trojan URI itself.
 *
 * Why spawn rather than embed: the light route (parse `http(s)/socks5` entries
 * and dial them in-process) cannot express a vless-REALITY subscription at all,
 * and a 108-byte PROXY-style trick cannot either — the protocol work belongs to
 * a purpose-built binary that already does health scoring and group selection.
 * The plugin's job is the seam: config in, local port out, `egressFetch`
 * unchanged between modes.
 *
 * Security notes that the settings route relies on:
 *
 *   - The relay binds `127.0.0.1` on an ephemeral port and is deliberately not
 *     an open proxy: every start mints a random key, `egressFetch` presents it,
 *     and any other caller — a neighbouring local process, a rebound page — is
 *     refused before a single dial. A keyed caller still needs an absolute
 *     http(s) target, and nothing else in the process rewrites.
 *   - The managed mihomo's mixed port is passworded (`authentication`) with a
 *     per-start credential the plugin is the only holder of, so the outlet
 *     cannot be borrowed by another process on this machine.
 *   - The subscription URL is a bearer credential: it is written to the mihomo
 *     config file (mode 0600-ish, inside the plugin's own data dir), never
 *     logged, and surfaced to the settings page as a hostname only.
 *   - `mihomoPath` comes from local settings, which the trust fence already
 *     gates the same way it gates every other write; there is no download step
 *     anywhere in this file.
 */
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import {
  DEFAULT_COOLDOWN_HOURS, DIRECT_ROUTE, loadNodeTable, noteNode429, noteNodeDelay, noteNodeSuccess,
  oldestLimitedNode, rankNodes, routeCandidates, saveNodeTable,
} from './outlet-nodes.js'
import { spawn } from 'node:child_process'
import { bunFetch, findBunExecutable } from './bun-fetch.js'
import { restrictPermissions } from './open-external.js'

/** The loopback address the relay listens on. Never a routable one. */
const RELAY_HOST = '127.0.0.1'
/** Carries the absolute target URL from `egressFetch` to the relay. */
const TARGET_HEADER = 'x-ofm-egress-target'
/** Carries this start's relay key. Every listen mints one, `egressFetch` is the
 *  only thing that learns it, and a request without it is not the plugin — it
 *  is refused before a single dial, so the loopback port is nobody's open
 *  proxy. Never forwarded upstream: the relay strips it like the target. */
const KEY_HEADER = 'x-ofm-egress-key'
/** One dial (connect, CONNECT response, socks5 handshake, TLS) gets this long. */
const DIAL_TIMEOUT_MS = 10_000
/** A freshly spawned mihomo gets this long to open its mixed port. */
const READY_TIMEOUT_MS = 15_000
/** Schemes a `client` outlet may speak. The subscription path needs none: it
 *  always dials the local mixed port over plain http. */
const CLIENT_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])
/** Hop-by-hop headers never forwarded across the relay boundary, either
 *  direction. `transfer-encoding` is dropped too: Node re-derives framing from
 *  the stream it is handed, and forwarding a foreign `chunked` marker would
 *  double-frame it. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'])

/**
 * The live relay, owned by whichever generation started it. Module-level on
 * purpose: `egressFetch` is imported by src/http.js and src/probe.js, which
 * have no handle on the index fiber, and a hot reload swaps this whole module
 * while the old relay's disposer tears the old one down.
 */
let activeRelay = null

/** True when requests will be rewritten onto the relay instead of going out direct. */
export function egressActive() {
  return activeRelay !== null
}

/**
 * How the running outlet is used, once it is up.
 *
 * `always` is the historical behaviour: the outlet exists, so everything goes
 * through it. `failover` starts it and then leaves it idle — the default route
 * stays direct, and only an attempt that the gateway refused with 429 is moved
 * onto the outlet, where a different exit address may still have pool left.
 */
export function egressPolicy() {
  const relay = activeRelay
  if (relay === null || relay.dead) return 'off'
  return relay.policy?.() === 'failover' ? 'failover' : 'always'
}

/**
 * Which outlets one upstream attempt may use, in order, as route descriptors.
 *
 * One pool, one ordering: `routeCandidates` ranks every path by latency, with
 * the direct connection entered at zero, and leaves out whatever said 429 inside
 * the cooldown window. So a healthy direct always comes first, a refused direct
 * disappears for five hours, and the turn falls through to the fastest node —
 * the same rule for both kinds of exit, which is what makes the behaviour easy
 * to reason about from the log alone.
 *
 * `always` keeps its old meaning (everything through the outlet) and simply
 * takes the best node as its only rung.
 */
export function outletRoutePlan() {
  const relay = activeRelay
  const cooldownHours = relay?.cooldownHours?.() ?? DEFAULT_COOLDOWN_HOURS
  const attempts = relay?.maxAttempts?.() ?? 3
  if (relay === null || relay.dead) return [{ kind: 'direct' }]
  if (egressPolicy() === 'always') {
    const best = rankNodes(relay.nodes, { cooldownHours })[0]
    return best === undefined ? [{ kind: 'relay' }] : [{ kind: 'node', node: best }]
  }
  const candidates = routeCandidates(relay.nodes, { cooldownHours }).slice(0, Math.max(1, attempts))
  const plan = candidates.map(route => (route.direct ? { kind: 'direct' } : { kind: 'node', node: route.name }))
  if (plan.length > 1) return plan
  // Nothing measured yet (the first seconds after boot): still give the turn one
  // rung it can fall back to, instead of refusing it with no alternative tried.
  const measured = Object.keys(relay.nodes.nodes ?? {}).filter(name => name !== DIRECT_ROUTE).length
  if (measured === 0) return [...plan, { kind: 'relay' }]
  if (plan.length === 0) {
    // Everything, direct included, is cooling: retry the entry whose window is
    // closest to expiring rather than refusing the turn untried.
    const oldest = oldestLimitedNode(relay.nodes)
    return oldest === null ? [] : [{ kind: 'node', node: oldest }]
  }
  return plan
}

/**
 * Pin the managed outlet on one node.
 *
 * Serialized by the caller's single-threaded turn, and skipped when the group is
 * already there: a switch is a controller round-trip and every turn would pay
 * for it. Returns `false` when there is no managed outlet or the controller
 * refused — the caller then skips that rung rather than sending the turn through
 * whatever node happened to be selected.
 */
export async function applyOutletNode(name, relay = activeRelay) {
  const managed = relay?.managed
  if (managed === null || managed === undefined) return false
  const target = typeof name === 'string' ? name : ''
  if (target === '') return false
  if (relay.pinned === target) return true
  try {
    await controllerJson(managed, '/proxies/ofm-outlet', 5000, { method: 'PUT', body: JSON.stringify({ name: target }) })
    relay.pinned = target
    return true
  } catch (error) {
    relay.log?.(`node "${target}" could not be selected (${error?.message ?? error})`)
    return false
  }
}

/** The turn was refused with 429 through `name`: stamp it for the five-hour rule. */
export function markOutlet429(name, relay = activeRelay) {
  if (relay === null || typeof name !== 'string' || name === '') return
  noteNode429(relay.nodes, name)
  persistNodes(relay)
}

/**
 * The turn was served through `name`: clear its failure counter.
 *
 * Memory only, on purpose — this runs once per served turn and the book is
 * already written on every 429 and on every hourly measurement. A per-turn fsync
 * would buy nothing: the counter it clears is a routing hint, not a record.
 */
export function markOutletSuccess(name, relay = activeRelay) {
  if (relay === null || typeof name !== 'string' || name === '') return
  noteNodeSuccess(relay.nodes, name)
}

function persistNodes(relay) {
  try {
    saveNodeTable(relay.dataDir, relay.nodes)
  } catch (error) {
    relay.log?.(`the node book could not be written (${error?.message ?? error})`)
  }
}

/**
 * Measure every node and write the readings into the book.
 *
 * The provider's health-check is the only bulk measurement mihomo offers, and it
 * is also the only one that works for provider nodes (`/proxies/<name>/delay`
 * answers 404 for those). Measured cost on a 71-node subscription: ~13-35 s, so
 * callers run this in the background — never on a turn's path.
 */
export async function refreshOutletNodes(relay = activeRelay, { timeoutMs = 120_000, waitMs = 45_000, now = Date.now() } = {}) {
  const managed = relay?.managed
  if (managed === null || managed === undefined) return null
  // The provider is fetched by mihomo *after* it starts, so the first call after
  // boot can arrive before a single node exists. Waiting is the difference
  // between "the outlet has no nodes" and "the outlet has not read its
  // subscription yet" — the first is a real fault, the second is a few seconds.
  const proxies = await waitForProvider(managed, waitMs)
  if (proxies.length === 0) {
    relay.log?.('the subscription has produced no nodes yet; will measure again on the next interval')
    return null
  }
  const target = encodeURIComponent('http://www.gstatic.com/generate_204')
  await controllerJson(managed, `/providers/proxies/egress/healthcheck?timeout=5000&url=${target}`, timeoutMs).catch(() => null)
  // The health-check rewrites each node's `history`; read it back rather than
  // the pre-check snapshot, or every node keeps whatever it measured last time.
  const measuredList = await controllerJson(managed, '/providers/proxies/egress', 6000).catch(() => null)
  const latest = Array.isArray(measuredList?.proxies) && measuredList.proxies.length > 0 ? measuredList.proxies : proxies
  let measured = 0
  for (const proxy of latest) {
    const name = typeof proxy?.name === 'string' ? proxy.name : ''
    if (name === '') continue
    const delayMs = lastDelay(proxy) ?? 0
    noteNodeDelay(relay.nodes, name, delayMs, now)
    if (delayMs > 0) measured += 1
  }
  relay.nodes.updatedAt = now
  persistNodes(relay)
  relay.log?.(`node measurement: ${measured}/${latest.length} reachable`)
  // `always` has no per-attempt pin, so it needs one good default or the first
  // catalog fetch walks out through whatever node the group happened to hold.
  if (relay.policy?.() !== 'failover') {
    const best = rankNodes(relay.nodes, { cooldownHours: relay.cooldownHours?.() })[0]
    if (best !== undefined) await applyOutletNode(best, relay)
  }
  return { measured, total: latest.length, at: now }
}

/**
 * The subscription's own `dns:` block, taken verbatim.
 *
 * Text, not YAML: the block is already correctly nested, and re-emitting it from
 * a parsed form would mean shipping a YAML writer for one section. `listen:` is
 * dropped — its port is the host's own resolver's business, not ours — and the
 * scan stops at the next key at column zero.
 */
function dnsBlockFrom(text) {
  const lines = String(text).split('\n')
  const start = lines.findIndex(line => /^dns:/.test(line))
  if (start === -1) return ''
  const block = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (index > start && line !== '' && !line.startsWith(' ')) break
    if (/^\s*listen:/.test(line)) continue
    block.push(line)
  }
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
  return block.length > 1 ? block.join('\n') : ''
}

/** Poll until the provider has nodes; the subscription load is asynchronous. */
async function waitForProvider(managed, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    const provider = await controllerJson(managed, '/providers/proxies/egress', 6000).catch(() => null)
    const proxies = Array.isArray(provider?.proxies) ? provider.proxies : []
    if (proxies.length > 0) return proxies
    if (Date.now() >= deadline) return []
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

/** Best effort: a subscription that cannot be read leaves the system resolver in place. */
async function subscriptionDns(url, log) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'clash.meta', accept: 'application/yaml, text/yaml, text/plain, */*' },
    })
    if (!response.ok) {
      log(`the subscription answered ${response.status}; node hostnames will use the system resolver`)
      return ''
    }
    const text = await response.text()
    const block = text.length > 4_000_000 ? '' : dnsBlockFrom(text)
    if (block === '') log('the subscription carries no dns block; node hostnames will use the system resolver')
    return block
  } catch (error) {
    log(`the subscription could not be read for its dns block (${error?.message ?? error}); node hostnames will use the system resolver`)
    return ''
  }
}

/** Resolve the relay an attempt should use, honouring an explicit choice. */
function outletRelayFor(outlet) {
  if (activeRelay === null || activeRelay.dead) return null
  if (outlet === 'direct') return null
  if (outlet === 'relay') return activeRelay
  // No explicit choice: under failover the direct path is the default, so an
  // unannotated caller (catalog refresh, exit-IP probe) keeps going straight out.
  return egressPolicy() === 'failover' ? null : activeRelay
}

/**
 * `fetch`, through the outlet when one is running and straight out when not.
 *
 * The rewrite is deliberately boring: same method, same body, same signal, plus
 * the target and this start's key in headers, and the path replaced by the
 * origin-form the loopback relay serves. Call sites keep `redirect: 'error'` in
 * `init`, so a 3xx is a response, never a second hop that would dodge the outlet.
 */
export async function egressFetch(url, init, { outlet } = {}) {
  const relay = outletRelayFor(outlet)
  const targetUrl = new URL(url instanceof Request ? url.url : String(url))
  // Only the official OC inference lane uses Bun. Kilo/EAC/catalogs and local
  // test endpoints keep their existing fetch path. Never retry a failed turn
  // through a second transport: a prior request may already have spent tokens.
  const officialFreeLane = targetUrl.protocol === 'https:' && targetUrl.hostname === 'opencode.ai'
    && (targetUrl.port === '' || targetUrl.port === '443') && targetUrl.pathname.startsWith('/inference/')
  const transport = process.env.OUR_FREE_MODEL_FREE_TRANSPORT ?? 'auto'
  if (officialFreeLane && transport !== 'node') {
    if (transport !== 'auto' && transport !== 'bun') throw new Error('OUR_FREE_MODEL_FREE_TRANSPORT must be auto, bun, or node')
    const executable = findBunExecutable()
    if (!executable) throw new Error('OpenCode free inference requires a local Bun executable; install Bun or set OUR_FREE_MODEL_BUN to its executable path (OUR_FREE_MODEL_FREE_TRANSPORT=node restores the legacy transport)')
    const proxy = relay ? `http://ofm:${relay.key}@${RELAY_HOST}:${relay.port}` : undefined
    if (url instanceof Request) {
      const request = new Request(url, init)
      const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
      return bunFetch(request.url, { ...init, method: request.method, headers: request.headers, body, signal: request.signal, redirect: request.redirect }, { executable, proxy })
    }
    return bunFetch(url, init, { executable, proxy })
  }
  if (relay === null) return fetch(url, init)
  const request = url instanceof Request ? new Request(url, init) : null
  const target = new URL(request ? request.url : String(url))
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`the egress relay only carries http(s) targets, got "${target.protocol}"`)
  }
  const headers = new Headers(request?.headers ?? init?.headers ?? {})
  headers.set(TARGET_HEADER, target.href)
  headers.set(KEY_HEADER, relay.key)
  const outgoing = request ? {
    ...init, method: request.method, body: request.body, signal: request.signal,
    redirect: request.redirect, ...(request.body ? { duplex: 'half' } : {}),
  } : init
  return fetch(`http://${RELAY_HOST}:${relay.port}${target.pathname}${target.search}`, { ...outgoing, headers })
}

/**
 * Start the relay for the current settings; throws with a message the settings
 * page can show when the configuration cannot run.
 *
 * Mirrors `startForwardServer`'s contract: the caller (`syncEgress`) owns the
 * idempotence — close the old one first — and this function only builds the
 * new one or fails.
 */
export async function startEgressRelay({ config, dataDir, log = () => {}, onDead }) {
  const cfg = { mode: 'subscription', url: '', mihomoPath: '', ...config() }
  const mode = cfg.mode === 'client' ? 'client' : 'subscription'
  const url = String(cfg.url ?? '').trim()
  if (url === '') throw new Error('the egress outlet is enabled but empty — paste a proxy address or a subscription link')
  // Minted per start, not per process: a key that leaked from a previous relay
  // must not open this one. Lives in the handle only, and is never written down.
  const key = randomBytes(16).toString('hex')
  let child = null
  let managed = null
  let outlet
  if (mode === 'client') {
    const parsed = new URL(url)
    if (!CLIENT_SCHEMES.has(parsed.protocol)) {
      throw new Error(`unsupported proxy scheme "${parsed.protocol}" — use http, https, socks5 or socks5h`)
    }
    outlet = { kind: 'url', url: parsed }
  } else {
    const binary = findMihomoBinary(cfg.mihomoPath)
    const dir = path.join(dataDir, 'egress')
    fs.mkdirSync(dir, { recursive: true })
    const mixedPort = await freePort()
    const apiPort = await freePort()
    const secret = randomBytes(16).toString('hex')
    // The mixed port is passworded for the same reason the relay is keyed: an
    // outlet any local process can borrow is an outlet that will be borrowed.
    // Only this module's dialer ever learns this credential — it rides in the
    // outlet URL below, never in the rendered config the user can read.
    const outletAuth = `ofm:${randomBytes(12).toString('hex')}`
    const configPath = path.join(dir, 'mihomo.yaml')
    // Read the subscription once, for its resolver only: the node hostnames are
    // not in public DNS and the provider steers the answers through a
    // per-account DoH. mihomo still owns the node list (the provider refresh).
    const dnsBlock = await subscriptionDns(url, log)
    fs.writeFileSync(configPath, renderMihomoConfig({
      subscription: url,
      mixedPort,
      apiPort,
      secret,
      auth: outletAuth,
      logFile: path.join(dir, 'mihomo.log'),
      dnsBlock,
    }), { mode: 0o600 })
    restrictPermissions(configPath)
    child = spawn(binary, ['-d', dir, '-f', configPath], { windowsHide: true, stdio: 'ignore' })
    let spawnError = null
    let exited = null
    child.on('error', error => { spawnError = error })
    child.on('exit', (code, signal) => { if (exited === null && spawnError === null) exited = `mihomo exited (${signal ?? code})` })
    // The provider URL is fetched by mihomo itself on startup, so readiness is
    // "the mixed port answers", not "the subscription parsed" — a bad link
    // still opens the port and then reports zero nodes through the API, which
    // the first health-check surfaces as a dead group rather than a hang here.
    try {
      await waitForPort(RELAY_HOST, mixedPort, READY_TIMEOUT_MS, () => {
        if (spawnError !== null) throw new Error(`mihomo could not start (${spawnError.message})`)
        if (exited !== null) throw new Error(`${exited} — see ${path.join(dir, 'mihomo.log')}`)
      })
    } catch (error) {
      // Nothing owns this child yet — the handle that would kill it is not built
      // until the listener is up — so a start that fails here has to reap it
      // itself, or a wedged mihomo outlives the attempt holding the mixed port.
      await killChild(child)
      throw error
    }
    log(`managed mihomo on ${RELAY_HOST}:${mixedPort} (controller ${RELAY_HOST}:${apiPort})`)
    outlet = { kind: 'url', url: new URL(`http://${outletAuth}@${RELAY_HOST}:${mixedPort}`) }
    managed = { mixedPort, apiPort, secret, dir }
  }

  const sockets = new Set()
  const server = http.createServer(relayRequest)
  server.on('connect', relayConnect)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, RELAY_HOST, () => { server.removeListener('error', reject); resolve() })
    })
  } catch (error) {
    // The listener is what turns `child` into an owned handle; without it the
    // started mihomo would outlive the failed start holding its ports.
    await killChild(child)
    throw error
  }
  const port = server.address().port
  const handle = {
    port,
    key,
    mode,
    url,
    outlet,
    managed,
    child,
    log,
    dataDir,
    /** What each node measured, and when it last said 429 (src/outlet-nodes.js). */
    nodes: loadNodeTable(dataDir),
    /** The node currently pinned on the select group, if any. */
    pinned: '',
    // Read through to the live settings rather than frozen at start: flipping
    // between "everything through the outlet" and "direct first" re-routes the
    // next attempt without taking the outlet (and its mihomo) down.
    policy: () => (config().policy === 'failover' ? 'failover' : 'always'),
    cooldownHours: () => {
      const hours = Number(config().nodeCooldownHours)
      return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_COOLDOWN_HOURS
    },
    maxAttempts: () => {
      const attempts = Number(config().maxAttempts)
      return Number.isInteger(attempts) && attempts > 0 ? Math.min(attempts, 5) : 3
    },
    /** Set when the managed child dies after startup; the settings page shows it. */
    dead: '',
    close: async () => {
      if (activeRelay === handle) activeRelay = null
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      await killChild(child)
    },
  }
  if (child !== null) {
    child.on('exit', () => {
      handle.dead = 'the managed mihomo process exited'
      log(`${handle.dead}; a restart has been scheduled`)
      // A dead managed mihomo otherwise stays dead until the user touches the
      // settings page: every upstream request would hard-fail through the
      // relay's closed dial port. The owner decides the retry policy (backoff,
      // give-up) — this only reports the death once, on the way down.
      try { onDead?.() } catch { /* a diagnostics callback cannot resurrect or worsen the relay */ }
    })
  }
  activeRelay = handle
  return handle
}

/**
 * One proxied request: open the tunnel, hand the socket to a one-shot agent,
 * pipe both directions.
 *
 * The dial is awaited before the outgoing request is built because the
 * agent's `createConnection` override is synchronous — the same seam the LAN
 * relay uses to stamp a PROXY v1 line, proven against this http stack. Both
 * bodies and the SSE response stream through as bytes; nothing is buffered
 * beyond Node's own flow control, so a streaming turn keeps its chunk cadence.
 */
function relayRequest(req, res) {
  const key = String(req.headers[KEY_HEADER] ?? '')
  delete req.headers[KEY_HEADER]
  if (!sameSecret(key, activeRelay?.key ?? '')) {
    // Not the plugin: a neighbouring local process, a page that guessed the
    // port, a fetch left over from a previous generation. Refused before any
    // dial happens, and the caller learns nothing about the outlet.
    activeRelay?.log?.('relay: refused a caller without this start’s key')
    sendLocal(res, 403, 'the egress relay answers its own plugin only')
    return
  }
  const targetHeader = req.headers[TARGET_HEADER]
  delete req.headers[TARGET_HEADER]
  let upstream
  try {
    upstream = new URL(String(targetHeader ?? ''))
  } catch {
    sendLocal(res, 400, `the egress relay needs a full ${TARGET_HEADER} target URL`)
    return
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    sendLocal(res, 400, `the egress relay carries http(s) targets only, got "${upstream.protocol}"`)
    return
  }
  const outlet = activeRelayOutlet()
  // Host only, never the href: query strings routinely carry credentials
  // (Gemini's ?key=… being the canonical case), and this line runs per request.
  activeRelay?.log?.(`relay: ${req.method} → ${upstream.protocol}//${upstream.host} (outlet ${outlet === null ? 'none' : 'ok'})`)
  if (outlet === null) {
    sendLocal(res, 502, 'the egress relay is not running')
    return
  }
  void (async () => {
    const socket = await openTunnel(upstream, outlet)
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => socket
    const headers = { ...req.headers, host: upstream.host }
    delete headers['transfer-encoding']
    const outgoing = http.request({
      method: req.method,
      path: `${upstream.pathname}${upstream.search}`,
      headers,
      agent,
    })
    outgoing.on('response', upstreamRes => {
      const responseHeaders = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
      activeRelay?.log?.(`relay: response ${upstreamRes.statusCode} for ${upstream.host} started`)
      upstreamRes.on('error', error => {
        activeRelay?.log?.(`egress relay: upstream body for ${upstream.host} failed: ${error?.message ?? error}`)
        res.destroy()
      })
      upstreamRes.pipe(res)
    })
    outgoing.on('error', error => {
      activeRelay?.log?.(`egress relay: tunnel to ${upstream.host} failed: ${error?.message ?? error}`)
      failOnce(res, error)
    })
    // A client abort (the harness aborts a dead turn) must tear the upstream
    // side down too, or the socket idles until the outlet times it out. On a
    // completed response only the one-shot tunnel socket goes: destroying the
    // client connection while its body is still in flight reads as a reset to
    // fetch(). The per-request tunnel is never reused (keepAlive: false).
    res.on('close', () => {
      outgoing.destroy()
      socket.destroy()
      if (!res.writableFinished) {
        activeRelay?.log?.(`relay: response for ${upstream.host} closed before finish (writableEnded=${res.writableEnded})`)
        try { res.destroy() } catch { /* already gone */ }
      }
    })
    req.on('error', () => { outgoing.destroy() })
    req.pipe(outgoing)
  })().catch(error => {
    activeRelay?.log?.(`egress relay: ${upstream.host} failed: ${error?.message ?? error}`)
    failOnce(res, error)
  })
}

/**
 * Authenticated TLS passthrough for the Bun worker. The existing HTTP relay
 * terminates TLS in Node; CONNECT instead preserves Bun's upstream handshake
 * while retaining the configured HTTP/HTTPS/SOCKS/managed-mihomo outlet.
 * This intentionally accepts the OC host only, not an arbitrary proxy target.
 */
function relayConnect(req, client, head) {
  const relay = activeRelay
  const authorization = String(req.headers['proxy-authorization'] ?? '')
  let credential = ''
  if (/^Basic /i.test(authorization)) credential = Buffer.from(authorization.slice(6), 'base64').toString('utf8')
  if (!relay || relay.dead || !sameSecret(credential, `ofm:${relay.key}`)) {
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nProxy-Authenticate: Basic realm="ofm"\r\n\r\n')
    return
  }
  if (String(req.url).toLowerCase() !== 'opencode.ai:443') {
    client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  // http: here is deliberate: openTunnel must return raw TCP, not Node TLS.
  let upstream
  const close = () => { client.destroy(); upstream?.destroy() }
  client.on('error', close)
  client.on('close', () => upstream?.destroy())
  // CONNECT sockets can remain half-open after the worker sends FIN. Before
  // piping begins there is no stream handler to finish that half-close.
  client.once('end', close)
  // Own the socket from the initial dial, not just after CONNECT/SOCKS/TLS
  // succeeds: cancellation and relay.close() can happen during any stage.
  void openTunnel(new URL('http://opencode.ai:443'), relay.outlet, socket => {
    upstream = socket
    if (client.destroyed) socket.destroy()
  }).then(socket => {
    client.off('end', close)
    upstream = socket
    if (client.destroyed) { socket.destroy(); return }
    socket.on('error', close)
    socket.on('close', () => client.destroy())
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) socket.write(head)
    client.pipe(socket).pipe(client)
  }).catch(() => {
    if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
}

/** The outlet the running relay dials; `null` between generations. */
function activeRelayOutlet() {
  return activeRelay?.outlet ?? null
}

/** The relay is loopback-only: a non-2xx here is a local misconfiguration, answered as JSON like every other local refusal. */
function sendLocal(res, status, message) {
  if (res.headersSent) { activeRelay?.log?.(`relay: sendLocal(${status}) after headers, destroying`); res.destroy(); return }
  const body = JSON.stringify({ error: message })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** Last-word failure: 502 before headers, a dead socket after. */
function failOnce(res, error) {
  if (res.headersSent) { res.destroy(); return }
  sendLocal(res, 502, `egress tunnel failed: ${error?.message ?? error}`)
}

/**
 * Connect to `upstream` through `outlet` and return a socket ready for plain
 * http framing — already TLS-wrapped when the target is https.
 */
async function openTunnel(upstream, outlet, onSocket) {
  const isTls = upstream.protocol === 'https:'
  const host = upstream.hostname
  const port = Number(upstream.port) || (isTls ? 443 : 80)
  let socket
  if (outlet.kind === 'url') {
    const proxy = outlet.url
    if (proxy.protocol === 'http:' || proxy.protocol === 'https:') socket = await httpConnect(proxy, host, port, onSocket)
    else if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') socket = await socks5Connect(proxy, host, port, proxy.protocol === 'socks5h:', onSocket)
    else throw new Error(`unsupported proxy scheme "${proxy.protocol}"`)
  } else {
    socket = await netConnect(host, port, onSocket)
  }
  if (!isTls) return socket
  return await withTimeout(new Promise((resolve, reject) => {
    const secured = tls.connect({
      socket,
      // An IP literal has no name to assert; the lane's hosts are names.
      servername: net.isIP(host) === 0 ? host : undefined,
      ALPNProtocols: ['http/1.1'],
    })
    secured.once('secureConnect', () => resolve(secured))
    secured.once('error', error => { secured.destroy(); reject(error) })
    onSocket?.(secured)
  }), DIAL_TIMEOUT_MS, 'target TLS handshake', socket)
}

/** Plain TCP with the dial budget applied. */
function netConnect(host, port, onSocket) {
  const socket = net.connect({ host, port })
  return withTimeout(new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
    onSocket?.(socket)
  }), DIAL_TIMEOUT_MS, 'tcp connect', socket)
}

/**
 * HTTP CONNECT through an http(s) proxy — including the local mixed port a
 * managed mihomo opens, which speaks CONNECT like any other proxy.
 */
async function httpConnect(proxy, targetHost, targetPort, onSocket) {
  let socket = await netConnect(proxy.hostname, Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80), onSocket)
  try {
    if (proxy.protocol === 'https:') {
      socket = await withTimeout(new Promise((resolve, reject) => {
        const secured = tls.connect({ socket, servername: net.isIP(proxy.hostname) === 0 ? proxy.hostname : undefined })
        secured.once('secureConnect', () => resolve(secured))
        secured.once('error', error => { secured.destroy(); reject(error) })
        onSocket?.(secured)
      }), DIAL_TIMEOUT_MS, 'proxy TLS handshake', socket)
    }
    const auth = proxy.username === '' ? '' : `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
    socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`)
    const { rest } = await readUntil(socket, DIAL_TIMEOUT_MS, 'CONNECT response', buffer => {
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return null
      const head = buffer.subarray(0, end).toString('latin1')
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(head)
      if (match === null) throw new Error(`the proxy answered "${head.split('\r\n')[0] ?? ''}" to CONNECT`)
      if (Number(match[1]) < 200 || Number(match[1]) >= 300) throw new Error(`the proxy refused CONNECT with ${match[1]}`)
      return end + 4
    })
    if (rest.length > 0) socket.unshift(rest)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/**
 * SOCKS5 CONNECT (RFC 1928, optional RFC 1929 credentials).
 *
 * `socks5h` sends the hostname and lets the proxy resolve it — the airport
 * exit must see the name, not this machine's DNS answer. Plain `socks5`
 * resolves locally first, per the scheme's definition.
 */
async function socks5Connect(proxy, targetHost, targetPort, resolveAtProxy, onSocket) {
  const socket = await netConnect(proxy.hostname, Number(proxy.port) || 1080, onSocket)
  try {
    const withAuth = proxy.username !== ''
    socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
    // Each stage consumes exactly the bytes of its message (parsed from
    // `head`) and pushes any bytes past the mark back — a coalesced TCP read
    // must not swallow the next stage.
    const greeting = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 greeting', buffer => (buffer.length < 2 ? null : 2 + buffer[1]))
    if (greeting.rest.length > 0) socket.unshift(greeting.rest)
    if (greeting.head[0] !== 0x05) throw new Error(`the socks5 proxy answered version ${greeting.head[0] ?? 'nothing'}`)
    const selected = greeting.head[1]
    if (selected === 0x02) {
      if (!withAuth) throw new Error('the socks5 proxy demands credentials this outlet does not have')
      const user = Buffer.from(decodeURIComponent(proxy.username), 'utf8')
      const pass = Buffer.from(decodeURIComponent(proxy.password), 'utf8')
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
      const auth = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 auth', buffer => (buffer.length >= 2 ? 2 : null))
      if (auth.rest.length > 0) socket.unshift(auth.rest)
      if (auth.head[0] !== 0x01 || auth.head[1] !== 0x00) throw new Error('the socks5 proxy rejected the credentials')
    } else if (selected !== 0x00) {
      throw new Error(`the socks5 proxy selected method ${selected}, expected 0 (none) or 2 (user/pass)`)
    }
    let address
    if (resolveAtProxy) {
      // RFC 1928: atyp 3 is [1-byte length][domain], unlike the raw IP forms.
      address = { type: 0x03, bytes: Buffer.concat([Buffer.from([Buffer.byteLength(targetHost)]), Buffer.from(targetHost, 'utf8')]) }
    } else {
      address = encodeAddress(await lookup(targetHost))
    }
    const request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, address.type]),
      address.bytes,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ])
    socket.write(request)
    const reply = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 connect reply', buffer => {
      if (buffer.length < 4) return null
      if (buffer[0] !== 0x05) throw new Error(`the socks5 reply started with ${buffer[0]}`)
      if (buffer[1] !== 0x00) throw new Error(`the socks5 proxy refused the connection (code ${buffer[1]})`)
      const atyp = buffer[3]
      if (atyp === 0x01) return buffer.length >= 10 ? 10 : null
      if (atyp === 0x04) return buffer.length >= 22 ? 22 : null
      if (atyp === 0x03) {
        if (buffer.length < 5) return null
        const full = 4 + 1 + buffer[4] + 2
        return buffer.length >= full ? full : null
      }
      throw new Error(`the socks5 reply used unknown address type ${atyp}`)
    })
    if (reply.rest.length > 0) socket.unshift(reply.rest)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/** DNS answer → SOCKS5 address block (type byte + encoded bytes). */
function encodeAddress(resolved) {
  if (resolved.family !== 6) {
    return { type: 0x01, bytes: Buffer.from(resolved.address.split('.').map(part => Number(part) & 0xff)) }
  }
  // Expand the `::` run before splitting: a compressed literal has empty
  // groups in the middle that must be counted, not parsed.
  const [head, tail, ...extra] = resolved.address.split('::')
  if (extra.length > 0) throw new Error(`unexpected IPv6 literal "${resolved.address}"`)
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups = tail === undefined
    ? headGroups
    : [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups]
  const bytes = Buffer.alloc(16)
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = (value >> 8) & 0xff
    bytes[index * 2 + 1] = value & 0xff
  })
  return { type: 0x04, bytes }
}

/**
 * Accumulate socket bytes until `matcher` is happy; resolve with the bytes
 * past the mark so the caller can push them back with `unshift`.
 */
function readUntil(socket, timeoutMs, what, matcher) {
  if (socket.destroyed) return Promise.reject(new Error(`the proxy closed during the ${what}`))
  return withTimeout(new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const onData = chunk => {
      chunks.push(chunk)
      size += chunk.length
      const buffer = Buffer.concat(chunks, size)
      let mark
      try {
        mark = matcher(buffer)
      } catch (error) {
        cleanup()
        reject(error)
        return
      }
      if (mark === null) {
        if (size > 16 * 1024) {
          cleanup()
          reject(new Error(`the proxy sent more than 16KB without finishing the ${what}`))
        }
        return
      }
      cleanup()
      resolve({ head: buffer.subarray(0, mark), rest: buffer.subarray(mark) })
    }
    const onError = error => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); reject(new Error(`the proxy closed during the ${what}`)) }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    // The socket was paused until now (connect-stage listeners only), so the
    // first byte arrives after this switch and nothing is lost in between.
    socket.resume()
  }), timeoutMs, what, socket)
}

/** Reject after `ms`, tearing the socket down so nothing leaks half-open. */
function withTimeout(promise, ms, what, socket) {
  let timer
  let onClose
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      onClose = () => reject(new Error(`the socket closed during the ${what}`))
      if (socket?.destroyed) onClose()
      else socket?.once('close', onClose)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        socket?.destroy?.()
        reject(new Error(`timed out after ${ms}ms: ${what}`))
      }, ms)
      timer.unref?.()
    }),
  ]).finally(() => {
    clearTimeout(timer)
    socket?.off('close', onClose)
  })
}

/** A free loopback port. Small bind/close race is acceptable — a collision surfaces as a clean startup error, not a corrupt state. */
async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, RELAY_HOST, resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Poll a TCP port until it answers or the budget runs out; `check` rethrows why early. */
async function waitForPort(host, port, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    check?.()
    const open = await new Promise(resolve => {
      const socket = net.connect({ host, port })
      const settle = ok => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(ok)
      }
      socket.once('connect', () => settle(true))
      socket.once('error', () => settle(false))
    })
    if (open) return
    if (Date.now() > deadline) throw new Error(`the port ${host}:${port} never opened within ${timeoutMs}ms`)
    await new Promise(resolve => { const t = setTimeout(resolve, 250); t.unref?.() })
  }
}

/**
 * Stop a spawned outlet child: ask nicely, then insist. Shared by `close()` and
 * by a failed start — a mihomo that never opened its port still holds it, and
 * once the attempt has given up nothing else can reach that child.
 */
async function killChild(proc) {
  if (proc === null || proc.exitCode !== null || proc.signalCode !== null) return
  proc.removeAllListeners('exit')
  try { proc.kill() } catch { /* already gone */ }
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3_000)
    proc.once('exit', () => { clearTimeout(timer); resolve() })
  })
  if (proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }
}

/** Constant-time relay-key comparison; the length check keeps `timingSafeEqual` from throwing. */
function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(String(expected ?? ''))
  return a.length >= 16 && a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The mihomo configuration this plugin runs: subscription as a proxy-provider,
 * a url-test group that re-measures on an interval, and MATCH routed through
 * it — so every connection the plugin makes leaves via the freshest
 * lowest-latency node without the plugin choosing one itself.
 *
 * `expected-status: 204` sits on the provider's health-check: the target is
 * gstatic's `generate_204`, so a 429 (or any error page) marks the node dead
 * and url-test excludes it. That is the 429-penalty half of the health score,
 * delegated to the component that already measures every node anyway.
 *
 * `auth` (when the caller supplies one) password-protects the mixed port, the
 * same way the relay key protects the loopback port in front of it: a listener
 * every local process can borrow is a listener that will be borrowed.
 */
export function renderMihomoConfig({ subscription, mixedPort, apiPort, secret, auth, logFile, dnsBlock }) {
  return [
    '# Managed by dsh-our-free-model. Edits are overwritten on the next sync.',
    `mixed-port: ${mixedPort}`,
    // The outlet serves this plugin alone: a private loopback listener with no
    // LAN exposure, no system proxy and no TUN — only `egressFetch` reroutes.
    'bind-address: 127.0.0.1',
    'allow-lan: false',
    ...(auth === undefined ? [] : [
      'authentication:',
      `  - ${JSON.stringify(auth)}`,
    ]),
    'mode: rule',
    'log-level: warning',
    ...(logFile === undefined ? [] : [`log-file: ${JSON.stringify(logFile)}`]),
    `external-controller: ${RELAY_HOST}:${apiPort}`,
    `secret: ${JSON.stringify(secret)}`,
    // The subscription's own resolver, verbatim. Node hostnames are not in
    // public DNS: the provider answers them through a per-account DoH, and the
    // system resolver returns addresses that do not accept the node ports
    // (measured: 0/71 reachable with system DNS, 65/71 with this block). The
    // block is copied rather than re-derived because the answers are steered per
    // account; `listen:` is stripped by the extractor so we never fight the
    // host's own resolver for a port.
    ...(dnsBlock === undefined || dnsBlock === '' ? ['dns:', '  enable: false'] : dnsBlock.split('\n')),
    'proxy-providers:',
    '  egress:',
    '    type: http',
    `    url: ${JSON.stringify(subscription)}`,
    '    interval: 86400',
    '    path: ./egress-provider.yaml',
    '    health-check:',
    '      enable: true',
    '      url: "http://www.gstatic.com/generate_204"',
    '      interval: 300',
    '      timeout: 5000',
    '      expected-status: 204',
    'proxy-groups:',
    '  - name: ofm-outlet',
    // `select`, not `url-test`: the choice is made by src/outlet-nodes.js from a
    // table that remembers 429s, and a url-test group would re-rank every few
    // minutes and overwrite the pin. The provider's own health-check still runs
    // (it is what fills in `history` for the hourly measurement).
    '    type: select',
    '    use:',
    '      - egress',
    'rules:',
    '  - MATCH,ofm-outlet',
    '',
  ].join('\n')
}

/**
 * Locate a mihomo-family binary: the explicit setting first, then PATH, then
 * the install directories of the clients that are actually common (Clash
 * Verge ships `verge-mihomo.exe` beside its GUI). No downloads here — a missing
 * binary is an error the settings page can explain, not a silent fetch.
 */
export function findMihomoBinary(explicit) {
  const given = String(explicit ?? '').trim()
  if (given !== '') {
    const stat = statOrNull(given)
    if (stat === null) throw new Error(`the mihomo path "${given}" does not exist`)
    const found = stat.isDirectory()
      ? scanMihomo([given, path.join(given, 'bin'), path.join(given, 'resources')], mihomoNames())
      : scanMihomo([path.dirname(given)], [path.basename(given)])
    if (found === null) throw new Error(`the mihomo path "${given}" holds no mihomo binary`)
    if (!found.executable) throw notExecutable(found.path)
    return found.path
  }
  const found = scanMihomo(mihomoSearchRoots(), mihomoNames())
  if (found === null) {
    throw new Error('no mihomo binary found - set its path in the egress settings (Clash Verge installs one, or get it from MetaCubeX/mihomo)')
  }
  if (!found.executable) throw notExecutable(found.path)
  return found.path
}

function mihomoNames() {
  return process.platform === 'win32'
    ? ['mihomo.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe', 'clash-meta.exe', 'clash.exe']
    : ['mihomo', 'clash-meta', 'clash']
}

function mihomoSearchRoots() {
  const roots = []
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry.trim() !== '') roots.push(entry)
  }
  let home = ''
  try { home = os.homedir() } catch { /* no home in this environment */ }
  if (typeof home !== 'string' || !path.isAbsolute(home)) home = ''
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || (home === '' ? '' : path.join(home, 'AppData', 'Local'))
    const installs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    if (local !== '' && path.isAbsolute(local)) installs.push(path.join(local, 'Programs'))
    for (const root of installs) {
      if (typeof root !== 'string' || !path.isAbsolute(root)) continue
      roots.push(path.join(root, 'Clash Verge'), path.join(root, 'clash-verge'), path.join(root, 'mihomo'))
    }
    return roots
  }
  // Missing home/prefix values must not turn fallback roots into cwd searches.
  if (home !== '') roots.push(path.join(home, '.local', 'bin'), path.join(home, 'bin'))
  const prefix = String(process.env.PREFIX ?? '').trim()
  if (prefix !== '' && path.isAbsolute(prefix)) roots.push(path.join(prefix, 'bin'))
  roots.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  return roots
}

/** Keep searching past a non-executable hit, but retain its actionable error. */
function scanMihomo(dirs, names) {
  let blocked = null
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (statOrNull(candidate)?.isFile() !== true) continue
      try {
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK)
        return { path: candidate, executable: true }
      } catch {
        blocked ??= candidate
      }
    }
  }
  return blocked === null ? null : { path: blocked, executable: false }
}

function statOrNull(target) {
  try { return fs.statSync(target) } catch { return null }
}

function notExecutable(target) {
  return new Error(`the mihomo at "${target}" is not executable - run: chmod +x "${target}"`)
}

/** Hostname of a URL, for display: the path of a subscription link is its credential. */
export function outletLabel(url) {
  try {
    const parsed = new URL(String(url))
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return ''
  }
}

/**
 * What the outlet is carrying traffic on right now, straight from mihomo's own
 * controller: the node its url-test picked and the delay that won it the rank.
 *
 * Returns `null` for a `client` outlet (there is no controller to ask) or while
 * url-test has not settled on a node yet. A controller that cannot answer at all
 * throws: the caller keeps its last reading rather than reporting a bare outlet.
 */
export async function readOutletSelection(relay, { timeoutMs = 4000 } = {}) {
  const managed = relay?.managed
  if (managed === null || managed === undefined) return null
  const group = await controllerJson(managed, '/proxies/ofm-outlet', timeoutMs)
  const node = typeof group?.now === 'string' ? group.now : ''
  if (node === '') return null
  // The winner's own reading is the number url-test ranked on. Nodes that came
  // from the provider are not addressable as `/proxies/<name>` (mihomo answers
  // 404 for those), so the delay is read out of the provider's own table; the
  // group's history is the last fallback, and in some builds it stays empty.
  const provider = await controllerJson(managed, '/providers/proxies/egress', timeoutMs).catch(() => null)
  const ranked = Array.isArray(provider?.proxies) ? provider.proxies.find(item => item?.name === node) : undefined
  return { node, delayMs: lastDelay(ranked) ?? lastDelay(group) ?? 0 }
}

function lastDelay(proxy) {
  const history = proxy?.history
  if (!Array.isArray(history) || history.length === 0) return undefined
  const delay = history[history.length - 1]?.delay
  return typeof delay === 'number' && delay > 0 ? delay : undefined
}

function controllerJson(managed, path, timeoutMs, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${managed.secret}` }
    if (body !== null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }
    const request = http.request(
      {
        host: RELAY_HOST,
        port: managed.apiPort,
        path,
        method,
        headers,
        timeout: timeoutMs,
      },
      response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => {
          // 204 is the controller's "done, nothing to say" (a group switch, a
          // health-check trigger); an empty 200 body is the same thing spelled
          // differently by some builds.
          if (response.statusCode === 204 || (response.statusCode === 200 && body.trim() === '')) {
            resolve(null)
            return
          }
          if (response.statusCode !== 200) {
            reject(new Error(`mihomo controller ${path} answered ${response.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error(`mihomo controller ${path} sent unparsable JSON`))
          }
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error(`mihomo controller ${path} timed out`)))
    request.on('error', reject)
    // The body has to be written, not just declared: a PUT carrying a
    // `content-length` and no bytes makes the controller wait for the rest of
    // the request until the timeout kills it.
    request.end(body === null ? undefined : body)
  })
}
