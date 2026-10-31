/**
 * The one transport failure worth replaying: a gateway that closes a queued
 * request without a status line.
 *
 * The free lane's gateway parks a request and, on its own schedule (~65 s in the
 * 2026-10-31 measurements), drops it before a single byte of answer. Nothing has
 * reached the downstream client at that point and the request body is
 * replayable, so one immediate retry turns a dead turn into a served one. This
 * suite pins that behaviour and, just as important, pins where it must *not*
 * apply: a real refusal, a caller abort and a second reset all keep their own
 * answer instead of being retried into a different failure.
 *
 * `http.js` freezes `UPSTREAM_BASE` when it is imported, so the whole file runs
 * against one loopback gateway whose behaviour each test swaps out.
 *
 * Run: node scripts/http-retry-test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

/** Answers the next requests with `plan`; every attempt's URL and body are recorded. */
const attempts = []
let plan = () => {}

const server = http.createServer((req, res) => {
  const slot = { url: req.url, body: '' }
  attempts.push(slot)
  req.setEncoding('utf8')
  req.on('data', chunk => { slot.body += chunk })
  req.on('end', () => plan(req, res, attempts.length - 1))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })

process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`
const { postStreamed } = await import('../src/http.js')

const reset = req => req.socket.destroy()
const answer = frames => (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(frames)
}
const request = (extra = {}) => ({
  path: '/chat/completions', session: 'fixture', onData: () => {},
  body: { model: 'fixture', messages: [{ role: 'user', content: 'OK' }], stream: true },
  ...extra,
})

test.beforeEach(() => { attempts.length = 0; plan = () => {} })

test('a reset before the response head is replayed exactly once', async () => {
  const chunks = []
  plan = (req, res, slot) => {
    if (slot === 0) { reset(req); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n')
  }
  await postStreamed(request({ onData: data => chunks.push(String(data)) }))
  assert.equal(attempts.length, 2, 'the replay is a second attempt')
  assert.match(chunks.join(''), /recovered/)
})

test('the replay carries the same body, not an empty one', async () => {
  // Serializing once before the first send is what makes the replay safe: a
  // request stream would already be consumed and the retry would post nothing.
  plan = (req, res, slot) => { if (slot === 0) reset(req); else answer('data: [DONE]\n\n')(req, res) }
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'payload survives' }], stream: true }
  await postStreamed(request({ body }))
  assert.equal(attempts.length, 2)
  assert.deepEqual(JSON.parse(attempts[1].body), body)
})

test('a second reset is reported instead of looping', async () => {
  plan = reset
  await assert.rejects(postStreamed(request()), error => {
    assert.equal(error.code, 'TRANSPORT')
    // The caller is told the connection failed and nothing else; the fact that
    // it was the *first* reset, and that a replay already happened, is detail
    // for the log (`rawMessage`), not for the wire.
    assert.equal(error.message, 'the connection to the model service failed')
    assert.match(error.rawMessage, /reset the connection before answering/)
    // The product name never reaches a client-facing message.
    assert.doesNotMatch(error.message, /\bfree\b/i)
    return true
  })
  assert.equal(attempts.length, 2, 'one retry, never more')
})

test('a status line is an answer, so it is not retried', async () => {
  plan = (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
    res.end(JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'usage limit reached' } }))
  }
  await assert.rejects(postStreamed(request()), error => error.code === 'RATE_LIMIT')
  assert.equal(attempts.length, 1)
})

test('a caller abort is not a reset, so it is never replayed', async () => {
  const controller = new AbortController()
  plan = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    controller.signal.addEventListener('abort', () => res.end())
    res.write(': waiting\n\n')
  }
  const pending = postStreamed(request({ signal: controller.signal }))
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, error => error.code === 'ABORTED')
  assert.equal(attempts.length, 1, 'a cancelled turn is not a transport failure')
})
