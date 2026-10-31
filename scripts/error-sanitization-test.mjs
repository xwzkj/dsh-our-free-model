/** Regression checks for API-facing error-message redaction. */
import assert from 'node:assert/strict'
import { sanitizeErrorMessage, carryFailure, forwardFailure } from '../src/failure.js'

const samples = [
  'our free model failed the turn',
  'our-free-model: upstream stream idle past its deadline',
  'This model is not on the free pool: FreeUsageLimitError',
  'OUR_FREE_MODEL is unavailable',
  'OpenCode free tier rejected this request',
  'Free usage limit reached. Try again later.',
  'model "deepseek-v4.1-flash-free" not found',
  'model "nvidia/nemotron-3.5-super-vl:free" not found',
]
for (const sample of samples) {
  const result = sanitizeErrorMessage(sample)
  // The word is what leaks product context; model ids are rewritten instead.
  assert.doesNotMatch(result, /free/i, `leaked "free" from: ${sample}`)
  assert.doesNotMatch(result, /Our Free Model/i)
}
assert.equal(sanitizeErrorMessage('model "deepseek-v4.1-flash-free" not found'), 'model "deepseek-v4.1-flash" not found')
assert.equal(sanitizeErrorMessage('OpenCode free tier rejected this request'), 'OpenCode service tier rejected this request')
assert.equal(carryFailure({ message: 'our-free-model: upstream returned no body' }).message, 'the model service: upstream returned no body')
assert.equal(forwardFailure({ failure: { message: 'our free model failed the turn', code: 'SERVER_ERROR' } }).error.message, 'the model service failed the turn')
console.log('error sanitization: all checks passed')
