/**
 * Failover: direct first, and only a 429 moves the turn onto the outlet.
 *
 * The free lane's quota is counted per exit address, so a 429 says nothing about
 * the request — the same body from another address is a fresh question. The
 * outlet is therefore kept running but idle (`policy: 'failover'`), and the
 * second attempt is what goes through the proxy. This suite proves both halves:
 * that the retry reaches the proxy, and that a 429 still loops nowhere when the
 * proxy is refused too.
 *
 * The proxy here is a real CONNECT proxy counting its own tunnels, so "the retry
 * went out through the outlet" is observed rather than inferred.
 *
 * Run: node scripts/egress-failover-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- the upstream: 429 until `refuseAll` is cleared -------------------------
let upstreamHits = 0
/** The session id each attempt presented, in order. */
const sessionIds = []
let refuseAll = false
/** When set, the upstream answers every request with this status. */
let forceStatus = 0
const upstream = http.createServer((req, res) => {
  upstreamHits += 1
  sessionIds.push(String(req.headers['x-opencode-session'] ?? ''))
  req.resume()
  req.on('end', () => {
    if (forceStatus !== 0) {
      res.writeHead(forceStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'refused' } }))
      return
    }
    if (refuseAll || upstreamHits === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
      res.end(JSON.stringify({
        error: { type: 'FreeUsageLimitError', message: 'usage limit reached. subscribe to OpenCode Go: https://opencode.ai/go' },
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n')
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))

// --- the outlet: a CONNECT proxy that counts tunnels ------------------------
let proxyTunnels = 0
const proxy = http.createServer((req, res) => { res.writeHead(405); res.end() })
proxy.on('connect', (req, clientSocket, head) => {
  proxyTunnels += 1
  const [host, port] = String(req.url).split(':')
  const dialed = net.connect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) dialed.write(head)
    dialed.pipe(clientSocket)
    clientSocket.pipe(dialed)
  })
  dialed.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => dialed.destroy())
})
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))

process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${upstream.address().port}`
const { postStreamed } = await import('../src/http.js')
const { egressPolicy, outletRoutePlan, startEgressRelay } = await import('../src/egress.js')
const { setFailureLog } = await import('../src/failure.js')
const { noteNodeDelay } = await import('../src/outlet-nodes.js')

const notes = []
setFailureLog(line => notes.push(line))

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-failover-'))
let policy = 'failover'
/** The live settings the relay reads through; `undefined` means "not configured". */
let maxAttempts
let relay = null

const request = (extra = {}) => ({
  path: '/chat/completions', session: 'fixture', onData: () => {},
  body: { model: 'fixture', messages: [{ role: 'user', content: 'OK' }], stream: true },
  ...extra,
})
const reset = () => { upstreamHits = 0; proxyTunnels = 0; notes.length = 0; sessionIds.length = 0 }

try {
  relay = await startEgressRelay({
    config: () => ({ mode: 'client', policy, url: `http://127.0.0.1:${proxy.address().port}`, mihomoPath: '', maxAttempts }),
    dataDir,
  })
  assert.equal(egressPolicy(), 'failover', 'the handle reads the live policy')
  // Nothing measured yet, so the outlet rung is "whatever mihomo holds" — the
  // named-node plan appears once the hourly measurement has filled the book.
  assert.deepEqual(outletRoutePlan(), [{ kind: 'direct' }, { kind: 'relay' }], 'direct first, outlet second')

  // 1. The path the plan describes: the first attempt goes straight out.
  reset()
  assert.equal(upstreamHits, 0)
  await postStreamed(request())
  assert.deepEqual([upstreamHits, proxyTunnels], [2, 1], 'first attempt direct, the 429 retried over the outlet')
  // A new exit gets a new session id; the two must not be the same string.
  assert.equal(sessionIds.length, 2)
  assert.notEqual(sessionIds[0], sessionIds[1], 'the retry presents a fresh session')
  assert.match(sessionIds[1], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'and it is still a canonical gateway session')

  // 2. The direct refusal is remembered: the next turn starts on the outlet and
  //    does not pay for another refused direct attempt.
  reset()
  refuseAll = true
  await assert.rejects(postStreamed(request()), error => {
    assert.equal(error.status, 429)
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.message, '429 usage limit reached', 'the supplier prose stays out of the reply')
    return true
  })
  assert.deepEqual([upstreamHits, proxyTunnels], [1, 1], 'a cooling direct is skipped, so only the outlet is tried')
  assert.ok(notes.some(line => /starting on the outlet \(the direct route is cooling\)/.test(line)),
    'the reordering is visible in the log')
  refuseAll = false

  // Back to a healthy direct, so the remaining cases describe the switch, not
  // the cooling pool.
  relay.nodes.nodes.direct.last429At = 0

  // 3. A non-429 refusal is not a routing problem: one attempt, no outlet.
  reset()
  forceStatus = 400
  await assert.rejects(postStreamed(request()), error => error.status === 400)
  assert.deepEqual([upstreamHits, proxyTunnels], [1, 0], 'a 4xx is the request, not the route')
  forceStatus = 0

  // 4. `policy: 'always'` keeps the historical route: everything over the outlet.
  policy = 'always'
  assert.deepEqual(outletRoutePlan(), [{ kind: 'relay' }])
  reset()
  await assert.rejects(postStreamed(request()), error => error.status === 429)
  assert.deepEqual([upstreamHits, proxyTunnels], [1, 1], 'the outlet is the only rung under `always`')

  // 5. The switch is visible in the log, without repeating the raw sentence.
  policy = 'failover'
  reset()
  await postStreamed(request())
  assert.ok(notes.some(line => /RATE_LIMIT from the direct route; retrying over the outlet/.test(line)),
    `the route change is logged, got: ${notes.join(' | ')}`)
  assert.ok(notes.some(line => /subscribe to OpenCode Go/.test(line)), 'the raw sentence is in the log')
  assert.ok(!notes.some(line => /retrying over the outlet.*subscribe to OpenCode Go/.test(line)))

  // 6. A ladder is bounded in time, not only in rungs: once the switching budget
  //    is gone the turn reports the refusal instead of walking the rest of the
  //    list. Without this, ten rungs of a slow, refused exit outlast the caller.
  //    Three named nodes give the plan enough rungs for a budget to bite; with
  //    no managed controller a node rung still leaves over the same relay, so
  //    each one is a real refused attempt.
  policy = 'failover'
  for (const [name, delay] of [['n1', 100], ['n2', 200], ['n3', 300]]) noteNodeDelay(relay.nodes, name, delay)
  relay.nodes.nodes.direct.last429At = 0
  assert.equal(outletRoutePlan().length, 4, 'direct plus three nodes: a ladder long enough to be capped')
  reset()
  refuseAll = true
  const before = upstreamHits
  await assert.rejects(
    postStreamed(request({ ladderBudgetMs: 1 })),
    error => error.status === 429,
    'an exhausted ladder budget reports the last refusal',
  )
  assert.ok(upstreamHits - before <= 2, `the budget stops the walk early, got ${upstreamHits - before} attempts`)
  assert.ok(notes.some(line => /spent its .* budget after .* reporting the last refusal/.test(line)),
    `the cut-off is in the log, got: ${notes.join(' | ')}`)
  refuseAll = false

  // 7. The width of the ladder itself. Ten by default, because about two exits
  //    in three are out of quota at any moment: three rungs handed the caller a
  //    429 that a wider ladder serves, and new-api then retried the whole turn
  //    and burned three more. Twelve is the ceiling — an operator may widen the
  //    ladder, not make a turn unbounded.
  // Case 6 refused real requests, so those exits now carry a 429 stamp: the plan
  // is capped by the pool as well, which is why the width is asserted on the
  // accessor and the plan only for "more than one rung".
  maxAttempts = undefined
  assert.equal(relay.maxAttempts(), 10, 'the default is ten exits per turn')
  assert.ok(outletRoutePlan().length >= 2, 'and the plan offers every candidate it has')
  maxAttempts = 12
  assert.equal(relay.maxAttempts(), 12, 'twelve is allowed')
  maxAttempts = 99
  assert.equal(relay.maxAttempts(), 12, 'and is the ceiling')
  maxAttempts = 1
  assert.equal(relay.maxAttempts(), 1, 'a narrow ladder is still the operator\'s call')
  // 8. A probe asks a narrower question, so it gets a narrower ladder: three
  //    exits answer "is this model servable", and one probe round is a request
  //    per model — a ten-rung ladder there multiplies refusals, not answers.
  reset()
  refuseAll = true
  const probeBefore = upstreamHits
  const stampedBefore = relay.nodes.nodes.direct.last429At
  await assert.rejects(postStreamed(request({ probe: true, maxRungs: 3 })), error => error.status === 429)
  assert.ok(upstreamHits - probeBefore <= 3, `a probe stops after three rungs, got ${upstreamHits - probeBefore}`)
  assert.equal(relay.nodes.nodes.direct.last429At, stampedBefore, 'and still stamps nothing')
  refuseAll = false
  maxAttempts = undefined
} finally {
  if (relay !== null) await relay.close().catch(() => {})
  proxy.closeAllConnections?.()
  await new Promise(resolve => proxy.close(resolve))
  upstream.closeAllConnections?.()
  await new Promise(resolve => upstream.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('egress failover: direct first, one 429 retry over the outlet, no supplier prose on the wire')
