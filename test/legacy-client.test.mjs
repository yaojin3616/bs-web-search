import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEnterpriseClient } from '../enterprise-client.js'

const signedIn = () => ({ connected: true, sessionVersion: 'session-a', enterpriseId: 'enterprise-a', userId: 'user-a' })
const input = { query: 'news', model: 'company-model' }
const requestId = '12345678-1234-4234-8234-123456789abc'
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const envelope = (result = { output: 'answer' }, tool = 'bs_web_search') => ({ tool, result })

function fixture(handler, options = {}) {
  const calls = []
  let state = signedIn()
  const auth = {
    getState: () => state,
    async request(path, init) {
      assert.equal(this, auth, 'Preserve the authenticated service receiver.')
      calls.push({ path, init })
      return handler ? handler(path, init) : Response.json(envelope())
    },
  }
  const client = createEnterpriseClient({ getAuth: () => auth, ...options })
  return { client, auth, calls, setState(value) { state = value } }
}

test('legacy getState + request is available and follows login state', async t => {
  const { client, calls, setState } = fixture()
  t.after(() => client.dispose())
  assert.equal(client.available(), true)
  assert.deepEqual(await client.search(input), { output: 'answer' })
  setState({ connected: false })
  assert.equal(client.available(), false)
  await assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_LOGIN_REQUIRED' })
  assert.equal(calls.length, 1)
  setState(signedIn())
  assert.equal(client.available(), true)
})

test('legacy POST uses the exact tool envelope with fresh UUIDs and no caller extras', async t => {
  const { client, calls } = fixture(() => Response.json(envelope({ output: 'custom' }, 'search-v2')), { toolKey: 'search-v2' })
  t.after(() => client.dispose())
  const value = Object.freeze({ ...input, query: '  exact query  ', id: 'caller-id', token: 'secret', commands: { unrelated: true } })
  await Promise.all(Array.from({ length: 16 }, () => client.search(value)))
  assert.equal(new Set(calls.map(call => JSON.parse(call.init.body).arguments.id)).size, 16)
  for (const { path, init } of calls) {
    const body = JSON.parse(init.body)
    assert.equal(path, '/api/v1/dsh/tools/search-v2/invoke')
    assert.match(body.arguments.id, uuidV4)
    assert.deepEqual(body, { arguments: {
      id: body.arguments.id, model: input.model, commands: { search_query: [{ q: value.query }] },
    } })
    assert.deepEqual(init, { method: 'POST', headers: { 'content-type': 'application/json' }, body: init.body, signal: init.signal })
    assert.ok(init.signal instanceof AbortSignal)
    assert.doesNotMatch(init.body, /caller-id|secret|unrelated/)
  }
})

test('legacy returns the result object without exposing the transport envelope', async t => {
  const result = { output: 'answer', sources: [{ title: 'Example', url: 'https://example.test' }], extra: { count: 2 } }
  const { client } = fixture(() => Response.json({ ...envelope(result), request_id: requestId }))
  t.after(() => client.dispose())
  assert.deepEqual(await client.search(input), result)
})

test('legacy HTTP errors expose only sanitized status and allowlisted diagnostics', async t => {
  for (const [status, code] of [[400, 'WEB_INVALID_REQUEST'], [401, 'WEB_ENTERPRISE_LOGIN_REQUIRED'],
    [403, 'WEB_ENTERPRISE_FORBIDDEN'], [404, 'WEB_ENTERPRISE_TOOL_NOT_FOUND'], [429, 'WEB_PROVIDER_ERROR'], [500, 'WEB_PROVIDER_ERROR']]) {
    const { client } = fixture(() => Response.json({
      error: { code: 'tool_arguments_invalid', message: 'secret body', token: 'secret' }, request_id: requestId,
    }, { status, statusText: 'secret status' }))
    t.after(() => client.dispose())
    await assert.rejects(client.search(input), error => {
      assert.equal(error.code, code)
      assert.equal(error.status, status)
      assert.equal(error.backendCode, 'tool_arguments_invalid')
      assert.equal(error.requestId, requestId)
      assert.ok(error.message.includes('HTTP ' + status + '; code=tool_arguments_invalid; request_id=' + requestId))
      assert.equal(error.cause, undefined)
      assert.doesNotMatch(error.message + JSON.stringify(error), /secret/)
      return true
    })
  }
  for (const payload of [{ error: { code: 'secret_code', message: 'secret' }, request_id: 'secret-id' },
    { error: { code: 'constructor' }, request_id: { secret: true } }]) {
    const { client } = fixture(() => Response.json(payload, { status: 500 }))
    t.after(() => client.dispose())
    await assert.rejects(client.search(input), error => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.equal(error.backendCode, undefined)
      assert.equal(error.requestId, undefined)
      assert.doesNotMatch(error.message + JSON.stringify(error), /secret|constructor/)
      return true
    })
  }
})

test('legacy rejects malformed JSON, response envelopes, and non-object results', async t => {
  for (const payload of [null, [], {}, { ...envelope(), tool: 'another-tool' },
    ...[undefined, null, [], 'answer', 42, true].map(result => ({ tool: 'bs_web_search', result }))]) {
    const { client } = fixture(() => Response.json(payload))
    t.after(() => client.dispose())
    await assert.rejects(client.search(input), { code: 'WEB_INVALID_RESPONSE' })
  }
  for (const response of [new Response('not JSON'), new Response(null), undefined, { status: 200, ok: 'yes' }]) {
    const { client } = fixture(() => response)
    t.after(() => client.dispose())
    await assert.rejects(client.search(input), { code: 'WEB_INVALID_RESPONSE' })
  }
  const { client } = fixture(() => Response.json({ ...envelope(), error: { message: 'secret' } }))
  t.after(() => client.dispose())
  await assert.rejects(client.search(input), error => error.code === 'WEB_PROVIDER_ERROR' && !error.message.includes('secret'))
})

test('legacy prevents dispatch when the session changes before the request microtask', async t => {
  const { client, calls, setState } = fixture()
  t.after(() => client.dispose())
  const pending = assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_ACCOUNT_CHANGED' })
  setState({ ...signedIn(), sessionVersion: 'session-b' })
  await pending
  assert.equal(calls.length, 0)
})

test('legacy discards results when session, enterprise, user, or login changes in flight', async t => {
  for (const state of [{ ...signedIn(), sessionVersion: 'session-b' }, { ...signedIn(), enterpriseId: 'enterprise-b' },
    { ...signedIn(), userId: 'user-b' }, { connected: false }]) {
    const { client, setState } = fixture(() => {
      setState(state)
      return Response.json(envelope())
    })
    t.after(() => client.dispose())
    await assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_ACCOUNT_CHANGED' })
  }
})

test('legacy caller cancellation aborts ignored host work and permits retry', async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let first = true
  const { client, calls } = fixture(() => {
    if (!first) return Response.json(envelope({ output: 'retry' }))
    first = false
    entered()
    return new Promise(() => {})
  })
  t.after(() => client.dispose())
  await assert.rejects(client.search(input, AbortSignal.abort()), { code: 'WEB_ABORTED' })
  assert.equal(calls.length, 0)
  const controller = new AbortController()
  const pending = assert.rejects(client.search(input, controller.signal), { code: 'WEB_ABORTED' })
  await started
  controller.abort(new Error('secret cancellation'))
  await pending
  assert.equal(calls[0].init.signal.aborted, true)
  assert.equal(client.available(), true)
  assert.deepEqual(await client.search(input), { output: 'retry' })
})

test('legacy rejects UTF-8 arguments over 65536 bytes before dispatch', async t => {
  const { client, calls } = fixture()
  t.after(() => client.dispose())
  // Within the character limit, but over the encoded byte limit.
  await assert.rejects(client.search({ ...input, query: '\u4e2d'.repeat(24000) }), { code: 'WEB_INVALID_REQUEST' })
  assert.equal(calls.length, 0)
})

test('legacy rejects oversized streamed responses and cancels the reader', async t => {
  let cancelled = false
  const { client } = fixture(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024))
      controller.enqueue(new Uint8Array(1))
    },
    cancel() { cancelled = true },
  })))
  t.after(() => client.dispose())
  await assert.rejects(client.search(input), { code: 'WEB_INVALID_RESPONSE' })
  assert.equal(cancelled, true)
})

test('invokeTool failure never retries through the legacy request channel', async t => {
  const { client, auth, calls } = fixture()
  t.after(() => client.dispose())
  let invoked = 0
  auth.invokeTool = async () => {
    invoked++
    throw Object.assign(new Error('secret'), { errorCode: 'tool_not_found' })
  }
  await assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_TOOL_NOT_FOUND' })
  assert.equal(invoked, 1)
  assert.equal(calls.length, 0)
})
