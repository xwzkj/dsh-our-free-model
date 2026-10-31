/**
 * The words a caller is allowed to read for each failure class.
 *
 * Deliberately a table rather than a scrubber. The previous approach rewrote the
 * upstream's own sentence — its product name, its signup URL, its upsell — and a
 * word list can only ever chase the last leak it was told about: today's 429
 * still reached callers as "usage limit reached. no-cost models work in OpenCode
 * (https://opencode.ai); subscribe to OpenCode Go to keep going". Upstream prose
 * is now untrusted input that never crosses the boundary; this table is the
 * whole vocabulary of what a caller learns. The raw sentence is not discarded —
 * `rawMessage` carries it to the log, where the operator can read it.
 *
 * The HTTP status stays in front (`429 usage limit reached`) because clients and
 * gateways retry on it, and dropping it would make a retryable turn look final.
 */
const PUBLIC_TEXT = {
  RATE_LIMIT: 'usage limit reached',
  QUOTA_EXHAUSTED: 'usage limit reached',
  INVALID_CREDENTIAL: 'authentication failed',
  AUTHORIZATION_REQUIRED: 'permission denied',
  LANE_LOCKED: 'this client is not allowed to use the model',
  REGION_BLOCKED: 'the model is not available from this network',
  PERMISSION_DENIED: 'permission denied',
  CLIENT_ERROR: 'the request was rejected',
  ABORTED: 'request aborted',
  TIMEOUT: 'the model did not answer in time',
  TRANSPORT: 'the connection to the model service failed',
  EMPTY_RESPONSE: 'the model returned an empty response',
  NO_PROGRESS: 'the model stopped making progress',
  SERVER: 'the upstream gateway failed',
  EAC_UPSTREAM_FAILED: 'the upstream gateway failed',
}

/** Statuses that carry a meaning of their own when no class does. */
const BY_STATUS = {
  400: 'the request was rejected',
  401: 'authentication failed',
  403: 'permission denied',
  404: 'the request was rejected',
  408: 'the gateway timed out, please retry',
  413: 'the request was too large',
  425: 'the gateway timed out, please retry',
  429: 'usage limit reached',
}

/**
 * What a caller learns about a failure: a leading status when the upstream sent
 * one, then a fixed phrase. Never the upstream's sentence, never a hostname.
 *
 * An unknown failure is not an excuse to fall back to the raw text: an
 * unrecognised class still answers with `the model request failed`, because the
 * one thing that must never cross this boundary is prose we did not write.
 */
export function publicMessageFor({ code, status } = {}) {
  const known = typeof code === 'string' ? PUBLIC_TEXT[code] : undefined
  const numbered = Number.isInteger(status) && status >= 400 && status <= 599
  // With no class and no table entry the status band still carries meaning: a
  // 5xx blames the hop, any other 4xx blames the request. Only a failure with
  // no status at all (a local timeout, an aborted socket) falls back to the
  // generic phrase.
  const band = !numbered ? undefined : status >= 500 ? 'the upstream gateway failed' : 'the request was rejected'
  const phrase = known ?? BY_STATUS[status] ?? band ?? 'the model request failed'
  return numbered ? `${status} ${phrase}` : phrase
}

/** Remove internal product/channel names from messages that cross an API boundary. */
export function sanitizeErrorMessage(message) {
  let value = String(message ?? '')
    .replace(/FreeUsageLimitError/gi, 'UsageLimitError')
    .replace(/FreeTierError/gi, 'TierError')
    .replace(/dsh[-_ ]?our[-_ ]free[-_ ]model/gi, 'the model service')
    .replace(/our[-_ ]free[-_ ]model/gi, 'the model service')
    .replace(/\bfree[-_ ]tier\b/gi, 'service tier')
    .replace(/\bfree[-_ ]usage[-_ ]limit\b/gi, 'usage limit')
    .replace(/\bfree[-_ ]pool\b/gi, 'available pool')
    .replace(/\bfree[-_ ]model\b/gi, 'model')
    // Model ids keep the caller-facing spelling: `foo-free` → `foo` and
    // `org/model:free` → `org/model`, matching the alias the gateway routes on
    // and leaving no `free` token in an error.
    .replace(/(?<=[A-Za-z0-9._-])[/:_-]free\b/gi, '')
    // Remaining prose ("a free thing") becomes grammatical and still avoids the
    // word; the known phrases above already carry the specific meaning.
    .replace(/\bfree\b/gi, 'no-cost')
  value = value.replace(/\s{2,}/g, ' ').trim()
  return value || 'the model service failed the request'
}

/** Preserve classified failures across the three local forwarding protocols. */
export function carryFailure(failure, kind = 'error') {
  const source = failure && typeof failure === 'object' ? failure : {}
  const code = kind === 'aborted' ? 'ABORTED' : source.code
  const status = source.status ?? source.statusCode
  return {
    message: sanitizeErrorMessage(typeof source.message === 'string' && source.message ? source.message : kind === 'aborted' ? 'request aborted' : 'the model service failed the turn'),
    ...typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {},
    ...Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {},
    ...Number.isFinite(source.providerRetryAfterMs) && source.providerRetryAfterMs > 0 ? { providerRetryAfterMs: source.providerRetryAfterMs } : {},
    // Not on the wire — `forwardFailure` drops it — but carried so the layer
    // that writes the log still has the upstream's own words to write.
    ...typeof source.rawMessage === 'string' && source.rawMessage !== '' ? { rawMessage: source.rawMessage } : {},
  }
}

/** Wire error metadata; no arbitrary provider properties are forwarded. */
export function forwardFailure(outcome, anthropic = false) {
  const failure = carryFailure(outcome.failure ?? { message: String(outcome.error) })
  const classes = {
    INVALID_CREDENTIAL: [401, 'authentication_error'],
    AUTHORIZATION_REQUIRED: [403, 'permission_error'],
    LANE_LOCKED: [403, 'permission_error'],
    REGION_BLOCKED: [403, 'permission_error'],
    PERMISSION_DENIED: [403, 'permission_error'],
    QUOTA_EXHAUSTED: [429, 'insufficient_quota'],
    RATE_LIMIT: [429, 'rate_limit_error'],
    CLIENT_ERROR: [400, 'invalid_request_error'],
    ABORTED: [400, 'invalid_request_error'],
    TIMEOUT: [504, 'server_error'],
    EAC_UPSTREAM_FAILED: [502, 'server_error'],
    NO_PROGRESS: [504, 'server_error'],
  }
  const byStatus = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'invalid_request_error', 429: 'rate_limit_error' }
  const [fallbackStatus, type] = classes[failure.code] ?? [502, byStatus[failure.status] ?? 'server_error']
  return {
    status: failure.status ?? fallbackStatus,
    error: { message: failure.message, type: anthropic && type === 'server_error' ? 'api_error' : type, ...(failure.code ? { code: failure.code } : {}) },
    retryAfterMs: failure.providerRetryAfterMs,
    classified: Boolean(failure.code || failure.status),
  }
}

/**
 * Where the upstream's own words go, now that callers no longer see them.
 *
 * A sink rather than a direct import: this module is a leaf (it is imported by
 * the wire, the adapter and the relays), and the logger lives in the fiber that
 * owns them. Unset means silent, which is what the tests want.
 */
let failureSink = null

export function setFailureLog(sink) {
  failureSink = typeof sink === 'function' ? sink : null
}

/**
 * One line per upstream failure, carrying what the caller was not told.
 *
 * Redaction is limited to the shape of the line: newlines collapse, the value is
 * truncated, and only the upstream's `message` is ever included — never a
 * header, a credential or our own request body. A gateway HTML page is the one
 * case where that text is bulky, which is what the truncation is for.
 */
/** A one-line note on the same channel, for events that are not a raw refusal. */
export function logFailureNote(text) {
  if (failureSink === null) return
  failureSink(`our-free-model: ${text}`)
}

export function logUpstreamFailure(error, context = {}) {
  if (failureSink === null) return
  const raw = String(error?.rawMessage ?? error?.message ?? error ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
  const fields = [
    `code=${error?.code ?? 'unknown'}`,
    error?.status === undefined ? '' : `status=${error.status}`,
    context.route === undefined ? '' : `route=${context.route}`,
    context.outlet === undefined ? '' : `outlet=${context.outlet}`,
    context.model === undefined ? '' : `model=${context.model}`,
  ].filter(part => part !== '')
  failureSink(`our-free-model: ${fields.join(' ')} raw="${raw}"`)
}
