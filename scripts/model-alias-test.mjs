/**
 * Paid-looking model names alias onto the free lane.
 *
 * The gateway only routes `deepseek-v4.1-flash-free`, but a caller that asks for
 * `deepseek-v4.1-flash` should get that sibling and see the name it asked for in
 * the response. These checks drive the real listener with a stub lane so both
 * halves are covered: what the adapter is asked to run, and what the client sees
 * on every wire (chat, chat stream, Responses, Messages).
 *
 * Run: node scripts/model-alias-test.mjs
 */
import assert from 'node:assert/strict'
import { startForwardServer } from '../src/forward.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}\n${error.stack?.split('\n').slice(1, 3).join('\n') ?? ''}`) }
}

const rows = [
  { id: 'deepseek-v4.1-flash-free', object: 'model', created: 0, owned_by: 'test' },
  { id: 'glm-5.3-flash-free', object: 'model', created: 0, owned_by: 'test' },
  { id: 'kilo-auto/free', object: 'model', created: 0, owned_by: 'test' },
  { id: 'real-model', object: 'model', created: 0, owned_by: 'test' },
  { id: 'real-model-free', object: 'model', created: 0, owned_by: 'test' },
]
const seen = []
const outcome = () => ({
  text: 'ok', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})
const server = await startForwardServer({
  config: () => ({ host: '127.0.0.1', port: 0, enabled: true, key: 'test-key' }),
  complete: async request => {
    // The real completion resolves the id against the catalog and throws 404;
    // mirror that so the unroutable-id check exercises the same surface.
    if (!rows.some(row => row.id === request.model)) {
      throw Object.assign(new Error(`model "${request.model}" not found`), { statusCode: 404 })
    }
    seen.push(request.model)
    return outcome()
  },
  modelRows: () => rows,
})
const base = `http://127.0.0.1:${server.port}`
const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

try {
  await checkAsync('chat non-stream routes to the -free sibling and labels the alias', async () => {
    seen.length = 0
    const { status, body } = await post('/v1/chat/completions', {
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    })
    assert.equal(status, 200)
    assert.deepEqual(seen, ['deepseek-v4.1-flash-free'])
    assert.equal(body.model, 'deepseek-v4.1-flash')
    assert.equal(body.choices[0].message.content, 'ok')
  })

  await checkAsync('every streamed chat frame carries the alias', async () => {
    seen.length = 0
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8, stream: true }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    const frames = text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map(line => JSON.parse(line.slice(6)))
    assert.ok(frames.length >= 2, 'expected at least the opening and closing frames')
    for (const frame of frames) assert.equal(frame.model, 'deepseek-v4.1-flash')
    assert.deepEqual(seen, ['deepseek-v4.1-flash-free'])
  })

  await checkAsync('Responses routes to the sibling and reports the alias', async () => {
    seen.length = 0
    const { status, body } = await post('/v1/responses', {
      model: 'deepseek-v4.1-flash',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      max_output_tokens: 8,
    })
    assert.equal(status, 200)
    assert.deepEqual(seen, ['deepseek-v4.1-flash-free'])
    assert.equal(body.model, 'deepseek-v4.1-flash')
  })

  await checkAsync('Messages routes to the sibling and reports the alias', async () => {
    seen.length = 0
    const { status, body } = await post('/v1/messages', {
      model: 'deepseek-v4.1-flash',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(status, 200)
    assert.deepEqual(seen, ['deepseek-v4.1-flash-free'])
    assert.equal(body.model, 'deepseek-v4.1-flash')
  })

  await checkAsync('an explicit -free id is passed through untouched', async () => {
    seen.length = 0
    const { status, body } = await post('/v1/chat/completions', {
      model: 'deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    })
    assert.equal(status, 200)
    assert.deepEqual(seen, ['deepseek-v4.1-flash-free'])
    assert.equal(body.model, 'deepseek-v4.1-flash-free')
  })

  await checkAsync('a real id wins over its -free sibling', async () => {
    seen.length = 0
    const { status, body } = await post('/v1/chat/completions', {
      model: 'real-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    })
    assert.equal(status, 200)
    assert.deepEqual(seen, ['real-model'])
    assert.equal(body.model, 'real-model')
  })

  await checkAsync('an unroutable id still fails as not-found', async () => {
    seen.length = 0
    const { status, body } = await post('/v1/chat/completions', {
      model: 'no-such-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    })
    assert.equal(status, 404)
    assert.match(String(body.error?.message ?? ''), /not found/)
    assert.deepEqual(seen, [])
  })
} finally {
  await server.close()
}

check('alias helper only strips an existing -free sibling', () => {
  // The listener owns the helper; this check keeps the contract visible here.
  const known = new Set(rows.map(row => row.id))
  const mapping = id => known.has(id) ? id : known.has(`${id}-free`) ? `${id}-free` : id
  assert.equal(mapping('deepseek-v4.1-flash'), 'deepseek-v4.1-flash-free')
  assert.equal(mapping('real-model'), 'real-model')
  assert.equal(mapping('no-such-model'), 'no-such-model')
})

if (failures > 0) {
  console.error(`\n${failures} model-alias check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nmodel alias: all checks passed')
}
