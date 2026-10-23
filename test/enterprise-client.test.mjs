import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime, WebError } from '@deepseek-ai/dsh-web'
import { createEnterpriseClient } from '../enterprise-client.js'
import * as plugin from '../index.js'

const signedIn = () => ({ connected: true, sessionVersion: 'session-a' })
const input = { query: 'news', model: 'company-model' }
const requestId = '12345678-1234-4234-8234-123456789abc'
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function fixture(handler, options = {}) {
  const calls = []
  let state = signedIn()
  let auth = {
    getState: () => state,
    request() { assert.fail('Search adapter must use invokeTool, never raw HTTP.') },
    async invokeTool(toolName, args, init) {
      assert.equal(this, auth, 'Preserve the service receiver for instance authorization.')
      calls.push({ toolName, args, init })
      if (!state.connected) throw Object.assign(new Error('private'), { errorCode: 'not_connected' })
      return handler ? handler(toolName, args, init) : { output: 'answer' }
    },
  }
  const client = createEnterpriseClient({ getAuth: () => auth, ...options })
  return { client, calls, setState(value) { state = value }, setAuth(value) { auth = value } }
}

test('delegates tool transport to the host and generates fresh search business arguments', async t => {
  const { client, calls } = fixture()
  t.after(() => client.dispose())
  const value = Object.freeze({ ...input, query: '  exact query  ', id: 'caller-id', commands: { unrelated: true }, token: 'secret' })
  await Promise.all(Array.from({ length: 32 }, () => client.search(value)))
  assert.equal(new Set(calls.map(call => call.args.id)).size, 32)
  for (const { toolName, args, init } of calls) {
    assert.equal(toolName, 'bs_web_search')
    assert.match(args.id, uuidV4)
    assert.deepEqual(args, { id: args.id, model: input.model, commands: { search_query: [{ q: value.query }] } })
    assert.deepEqual(init, { signal: init.signal, timeoutMs: 60000, maxInputBytes: 65536, maxResponseBytes: 4194304 })
    assert.ok(init.signal instanceof AbortSignal)
    assert.doesNotMatch(JSON.stringify(args), /caller-id|unrelated|secret/)
  }
})

test('preserves configured tool name and rejects malformed plugin configuration', async t => {
  const { client, calls } = fixture(undefined, { toolKey: 'search-v2' })
  t.after(() => client.dispose())
  await client.search(input)
  assert.equal(calls[0].toolName, 'search-v2')
  for (const toolKey of ['', '../search', 'https://evil.test', 'x/y', '%2F', 'x?y', 'x#y', 'x'.repeat(126), null]) {
    assert.throws(() => createEnterpriseClient({ getAuth: () => ({}), toolKey }), /toolKey/)
  }
  assert.throws(() => createEnterpriseClient(), /resolver/)
})

test('rejects invalid search input before calling the host SDK', async t => {
  const { client, calls } = fixture()
  t.after(() => client.dispose())
  for (const value of [undefined, {}, [], { ...input, query: '' }, { ...input, query: '   ' },
    { ...input, query: 'x'.repeat(32769) }, { ...input, model: '' }, { ...input, model: '   ' }, { ...input, model: 'x'.repeat(257) }]) {
    await assert.rejects(client.search(value), { code: 'WEB_INVALID_REQUEST' })
  }
  assert.equal(calls.length, 0)
})

test('missing SDK stays unavailable and can recover through legacy or current transport', async t => {
  const { client, setAuth } = fixture()
  t.after(() => client.dispose())
  for (const auth of [undefined, { getState: signedIn }, { request() {} }, { invokeTool() {} }]) {
    setAuth(auth)
    assert.equal(client.available(), false)
    await assert.rejects(client.search(input), error => {
      assert.equal(error.code, 'WEB_ENTERPRISE_AUTH_UNAVAILABLE')
      return true
    })
  }
  setAuth({ getState: signedIn, async request() {
    return Response.json({ tool: 'bs_web_search', result: { output: 'legacy recovered' } })
  } })
  assert.equal(client.available(), true)
  assert.equal((await client.search(input)).output, 'legacy recovered')
  setAuth({ getState: signedIn, async invokeTool() { return { output: 'recovered' } } })
  assert.equal(client.available(), true)
  assert.equal((await client.search(input)).output, 'recovered')
})

test('login availability follows the host state snapshot', async t => {
  const { client, setState } = fixture()
  t.after(() => client.dispose())
  setState({ connected: false })
  assert.equal(client.available(), false)
  await assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_LOGIN_REQUIRED' })
  setState(signedIn())
  assert.equal(client.available(), true)
  assert.equal((await client.search(input)).output, 'answer')
})

test('maps shared SDK error codes without forwarding raw host messages or causes', async t => {
  for (const [errorCode, code] of Object.entries({
    invalid_request: 'WEB_INVALID_REQUEST', invalid_response: 'WEB_INVALID_RESPONSE',
    not_connected: 'WEB_ENTERPRISE_LOGIN_REQUIRED', authorization_denied: 'WEB_ENTERPRISE_FORBIDDEN',
    session_changed: 'WEB_ENTERPRISE_ACCOUNT_CHANGED', request_aborted: 'WEB_ABORTED',
    request_timeout: 'WEB_TIMEOUT', tool_not_found: 'WEB_ENTERPRISE_TOOL_NOT_FOUND',
    request_failed: 'WEB_PROVIDER_ERROR', unknown_secret: 'WEB_PROVIDER_ERROR', constructor: 'WEB_PROVIDER_ERROR',
  })) {
    const { client } = fixture(() => { throw Object.assign(new Error('secret-message'), {
      errorCode, status: 418, backendCode: 'secret-code', requestId: 'secret-id', cause: new Error('secret'),
    }) })
    t.after(() => client.dispose())
    await assert.rejects(client.search(input), error => {
      assert.equal(error.code, code)
      assert.equal(error.status, undefined)
      assert.equal(error.cause, undefined)
      assert.doesNotMatch(error.message + JSON.stringify(error), /secret|418/)
      return true
    })
  }
})

test('preserves sanitized shared tool diagnostics, not the raw error message', async t => {
  const { client } = fixture(() => { throw Object.assign(new Error('secret upstream body'), {
    name: 'EnterpriseToolError', errorCode: 'invalid_request', status: 400,
    backendCode: 'tool_arguments_invalid', requestId,
  }) })
  t.after(() => client.dispose())
  await assert.rejects(client.search(input), error => {
    assert.equal(error.code, 'WEB_INVALID_REQUEST')
    assert.equal(error.status, 400)
    assert.equal(error.backendCode, 'tool_arguments_invalid')
    assert.equal(error.requestId, requestId)
    assert.match(error.message, /HTTP 400; code=tool_arguments_invalid/)
    assert.doesNotMatch(error.message + JSON.stringify(error), /secret/)
    return true
  })
})

test('sanitizes arbitrary exceptions including WebError from the host', async t => {
  for (const hostError of [new Error('secret'), new WebError('secret', 'HOST_ERROR')]) {
    const { client } = fixture(() => { throw hostError })
    t.after(() => client.dispose())
    await assert.rejects(client.search(input), error => error.code === 'WEB_PROVIDER_ERROR' && !error.message.includes('secret') && !error.cause)
  }
  const client = createEnterpriseClient({ getAuth() { throw new Error('secret') } })
  t.after(() => client.dispose())
  assert.equal(client.available(), false)
  await assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_AUTH_UNAVAILABLE' })
})

test('search requires an object result even though the generic host permits any JSON result', async t => {
  for (const value of [undefined, null, [], 'answer', 42, true]) {
    const { client } = fixture(() => value)
    t.after(() => client.dispose())
    await assert.rejects(client.search(input), { code: 'WEB_INVALID_RESPONSE' })
  }
})

test('an already aborted call never reaches invokeTool', async t => {
  const { client, calls } = fixture()
  t.after(() => client.dispose())
  await assert.rejects(client.search(input, AbortSignal.abort()), { code: 'WEB_ABORTED' })
  assert.equal(calls.length, 0)
})

test('caller cancellation propagates to shared SDK and permits another search', async t => {
  let first = true, entered
  const started = new Promise(resolve => { entered = resolve })
  const { client, calls } = fixture((toolName, args, { signal }) => {
    if (!first) return { output: 'retry' }
    first = false
    entered()
    return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  })
  t.after(() => client.dispose())
  const controller = new AbortController()
  const pending = assert.rejects(client.search(input, controller.signal), { code: 'WEB_ABORTED' })
  await started
  controller.abort()
  await pending
  assert.equal(calls[0].init.signal.aborted, true)
  assert.equal(client.available(), true)
  assert.equal((await client.search(input)).output, 'retry')
})

test('disposal cancels shared SDK work and disables future calls', async () => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const { client, calls } = fixture((toolName, args, { signal }) => {
    entered()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const pending = assert.rejects(client.search(input), { code: 'WEB_ABORTED' })
  await started
  client.dispose()
  await pending
  assert.equal(calls[0].init.signal.aborted, true)
  assert.equal(client.available(), false)
  await assert.rejects(client.search(input), { code: 'WEB_ABORTED' })
  assert.equal(calls.length, 1)
})

test('discards a late business result after disposal', async () => {
  let finish
  const { client } = fixture(() => new Promise(resolve => { finish = resolve }))
  const pending = assert.rejects(client.search(input), { code: 'WEB_ABORTED' })
  client.dispose()
  finish({ output: 'late' })
  await pending
})

test('adding the new SDK later enables native web search without reinstalling the plugin', async () => {
  const ctx = new Context()
  const web = await ctx.plugin(WebRuntime, { searchProvider: 'original' })
  const scope = await ctx.plugin(plugin, {})
  try {
    assert.equal(scope.state, 2)
    await assert.rejects(ctx.get('web').search({ query: 'test' }), { code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
    ctx.provide('enterpriseAuth', { getState: signedIn, async invokeTool() { return { output: 'ready' } } })
    assert.equal((await ctx.get('web').search({ query: 'test' })).content, 'ready')
  } finally { await scope.dispose(); await web.dispose() }
})
