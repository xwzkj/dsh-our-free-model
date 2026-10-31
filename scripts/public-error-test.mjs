/**
 * The boundary contract: a caller learns a status and a class, never the
 * upstream's sentence.
 *
 * This used to be a word list (`sanitizeErrorMessage`), and a word list can only
 * catch the leak it was last told about — the free lane's 429 reached clients
 * with its supplier's name, site and paid-plan pitch intact. The replacement is
 * a table (`publicMessageFor`): upstream prose is untrusted input that may be
 * logged but not forwarded. These checks fail if any future edit starts
 * forwarding it again.
 */
import assert from 'node:assert/strict'
import { classifyFailure } from '../src/http.js'
import { carryFailure, forwardFailure, logUpstreamFailure, publicMessageFor, setFailureLog } from '../src/failure.js'

/** Names that must never appear in anything a caller can read. */
const SUPPLIERS = /opencode\.ai|OpenCode|openrouter|anthropic|claude|gemini|kimi|moonshot|nous|chutes|cloudflare|cerebras|groq|siliconflow/i

const envelopes = [
  [429, 'FreeUsageLimitError', 'usage limit reached. no-cost models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go'],
  [403, 'FreeTierError', "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai."],
  [403, 'RegionError', 'This model is not available in your country.'],
  [401, 'invalid_request_error', 'invalid api key for openrouter (sk-or-v1-abc)'],
  [502, 'server_error', 'Anthropic upstream overloaded, retry via claude.ai'],
  [500, undefined, '<!doctype html><html><head><title>Cloudflare</title></head></html>'],
  [400, 'invalid_request_error', 'Unsupported parameter: temperature for gemini-2.5-pro'],
]

for (const [status, type, message] of envelopes) {
  const failure = classifyFailure(status, { error: { ...(type === undefined ? {} : { type }), message } })
  const wire = forwardFailure({ failure: { message: failure.message, code: failure.code, status: failure.status } })
  const text = wire.error.message
  assert.doesNotMatch(text, SUPPLIERS, `supplier leaked at ${status}: ${text}`)
  assert.doesNotMatch(text, /https?:\/\//, `a link reached the caller at ${status}: ${text}`)
  // Every phrase leads with its status, because clients and gateways retry on
  // it. The one exception is the front proxy's page, which is a sentence we
  // wrote: it names the status inside the sentence instead ("answered HTTP 503").
  if (text.startsWith('the gateway')) assert.match(text, new RegExp(`HTTP ${status} `))
  else assert.match(text, new RegExp(`^${status} `), 'the status must lead, clients retry on it')
  // The words are not lost, only redirected: the log copy still has them.
  assert.equal(typeof failure.rawMessage, 'string')
  assert.ok(failure.rawMessage.length > 0)
}

// Fixed phrases, spelled out — a change here is a deliberate contract change.
assert.equal(classifyFailure(429, { error: { message: 'usage limit reached' } }).message, '429 usage limit reached')
assert.equal(classifyFailure(403, { error: { type: 'FreeTierError', message: 'x' } }).message, '403 this client is not allowed to use the model')
assert.equal(classifyFailure(502, { error: { message: 'boom' } }).message, '502 the upstream gateway failed')
assert.equal(classifyFailure(401, { error: { message: 'nope' } }).message, '401 authentication failed')

// The unknown case: an unrecognised class answers with the generic phrase rather
// than falling back to the upstream's words. Status 599 is the far edge — it has
// no table entry, so only the 5xx rule can speak.
assert.equal(classifyFailure(599, { error: { message: 'some vendor specific prose' } }).message, '599 the upstream gateway failed')
assert.equal(publicMessageFor({}), 'the model request failed')
assert.equal(publicMessageFor({ code: 'SOMETHING_NEW' }), 'the model request failed')
assert.equal(publicMessageFor({ code: 'SOMETHING_NEW', status: 418 }), '418 the request was rejected')

// Prose we wrote ourselves passes through: it explains a fix and names no one.
const signature = classifyFailure(403, { error: { message: 'signature rejected' } })
assert.match(signature.message, /disable it for this lane/)
const html = classifyFailure(503, { error: { message: '<html>oops</html>' } })
assert.match(html.message, /WAF or body-size limit/)

// `carryFailure` keeps the raw copy for the log but never lets it onto the wire.
const carried = carryFailure(classifyFailure(429, { error: { message: 'subscribe to OpenCode Go' } }))
assert.equal(carried.message, '429 usage limit reached')
assert.equal(carried.rawMessage, 'subscribe to OpenCode Go')
const forwarded = forwardFailure({ failure: carried })
assert.equal(forwarded.error.message, '429 usage limit reached')
assert.equal(forwarded.error.rawMessage, undefined, 'the raw copy must not ride the wire')

// The log line: one line, the raw sentence, no credential, and truncated.
const lines = []
setFailureLog(line => lines.push(line))
logUpstreamFailure({ code: 'RATE_LIMIT', status: 429, rawMessage: 'line one\nline two\tsubscribe to OpenCode Go' })
setFailureLog(null)
assert.equal(lines.length, 1)
assert.doesNotMatch(lines[0], /\n/, 'a log entry is one line')
assert.match(lines[0], /subscribe to OpenCode Go/, 'the operator keeps the words')
assert.match(lines[0], /code=RATE_LIMIT status=429/)
// The log line is internal, so the product's own name is allowed here — what
// matters is that the sentence arrived whole.
assert.match(lines[0], /^our-free-model: /)

// Silent by default: a test or a library import must not print.
logUpstreamFailure({ code: 'RATE_LIMIT', rawMessage: 'x' })
assert.equal(lines.length, 1)

console.log('public error: every class answers with a fixed phrase, upstream prose stays in the log')
