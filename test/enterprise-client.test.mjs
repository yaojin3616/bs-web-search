import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime, WebError } from '@deepseek-ai/dsh-web'
import { createEnterpriseClient } from '../enterprise-client.js'
import { createSearchProvider } from '../provider.js'
import * as plugin from '../index.js'

const signedIn = () => ({ connected: true, sessionVersion: 'session-a', enterpriseId: 'enterprise-a', userId: 'user-a' })
const input = { query: 'news', model: 'company-model' }
const endpoint = '/api/v1/dsh/tools/bs_web_search/invoke'
const tool = 'bs_web_search'
const requestId = '12345678-1234-4234-8234-123456789abc'
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const businessArguments = (id, { query, model } = input) => ({ id, model, commands: { search_query: [{ q: query }] } })

function fixture(handler, options = {}) {
  const calls = []
  let state = signedIn()
  let auth = {
    getState: () => state,
    async request(path, init) {
      const body = JSON.parse(init.body)
      calls.push({ path, ...init, payload: body })
      return handler ? handler(path, init, body) : Response.json({ tool: options.toolKey ?? tool, result: { output: 'answer' } })
    },
  }
  const client = createEnterpriseClient({ getAuth: () => auth, ...options })
  return { client, calls, setState(value) { state = value }, setAuth(value) { auth = value } }
}

test('sends a fresh business UUID and full search protocol inside arguments only, without credentials', async () => {
  const { client, calls } = fixture()
  try {
    assert.equal(client.available(), true)
    assert.deepEqual(await client.search(input), { output: 'answer' })
    await client.search(input)
    assert.notEqual(calls[0].payload.arguments.id, calls[1].payload.arguments.id)
    for (const call of calls) {
      assert.equal(call.path, endpoint)
      assert.equal(call.method, 'POST')
      assert.deepEqual(call.headers, { 'content-type': 'application/json' })
      assert.deepEqual(call.payload, { arguments: businessArguments(call.payload.arguments.id) })
      assert.match(call.payload.arguments.id, uuidV4)
      assert.ok(call.signal instanceof AbortSignal)
      assert.doesNotMatch(call.body, /token|connectionKey|sessionVersion/)
    }
  } finally { client.dispose() }
})

test('concurrent searches generate unique business UUIDs and never forward caller-supplied protocol fields', async () => {
  const { client, calls } = fixture()
  const value = Object.freeze({ ...input, query: '  exact query  ', id: 'caller-id', commands: { unrelated: true }, token: 'caller-secret' })
  try {
    await Promise.all(Array.from({ length: 32 }, () => client.search(value)))
    assert.equal(calls.length, 32)
    assert.equal(new Set(calls.map(call => call.payload.arguments.id)).size, 32)
    for (const { payload, body } of calls) {
      assert.match(payload.arguments.id, uuidV4)
      assert.deepEqual(payload, { arguments: businessArguments(payload.arguments.id, value) })
      assert.doesNotMatch(body, /caller-id|unrelated|caller-secret/)
    }
    assert.equal(value.id, 'caller-id')
    assert.deepEqual(value.commands, { unrelated: true })
  } finally { client.dispose() }
})

test('historical toolKey targets another tool name but rejects URL, traversal, and malformed configuration', async () => {
  const { client, calls } = fixture(undefined, { toolKey: 'search-v2' })
  try { await client.search(input); assert.equal(calls[0].path, '/api/v1/dsh/tools/search-v2/invoke') }
  finally { client.dispose() }
  const longest = fixture(undefined, { toolKey: 'x'.repeat(125) })
  try { await longest.client.search(input); assert.equal(longest.calls[0].path, `/api/v1/dsh/tools/${'x'.repeat(125)}/invoke`) }
  finally { longest.client.dispose() }
  for (const toolKey of ['', '../search', 'https://evil.test', 'x/y', '%2F', 'x?y', 'x#y', 'x'.repeat(126), 'x'.repeat(128), null]) {
    assert.throws(() => createEnterpriseClient({ getAuth: () => ({}), toolKey }), /toolKey/)
  }
  assert.throws(() => createEnterpriseClient(), /resolver/)
})

test('rejects invalid input before sending any authenticated request', async () => {
  const { client, calls } = fixture()
  try {
    for (const value of [undefined, {}, { ...input, query: '' }, { ...input, query: ' '.repeat(5) },
      { ...input, query: 'x'.repeat(32769) }, { ...input, model: 'x'.repeat(257) }]) {
      await assert.rejects(client.search(value), { code: 'WEB_INVALID_REQUEST' })
    }
    assert.equal(calls.length, 0)
  } finally { client.dispose() }
})

test('limits the complete serialized UTF-8 request to 65536 bytes before dispatch', async () => {
  const { client, calls } = fixture()
  try {
    const overhead = Buffer.byteLength(JSON.stringify({ arguments: businessArguments(requestId, { ...input, query: '' }) }), 'utf8')
    const budget = 65536 - overhead
    const query = '\u00e9'.repeat(Math.floor(budget / 2)) + 'x'.repeat(budget % 2)
    assert.ok(query.length <= 32768)
    await client.search({ ...input, query })
    assert.equal(Buffer.byteLength(calls[0].body, 'utf8'), 65536)
    for (const oversized of [query + 'x', '\u4e2d'.repeat(22000), '\n'.repeat(32768)]) {
      await assert.rejects(client.search({ ...input, query: oversized }), { code: 'WEB_INVALID_REQUEST' })
    }
    assert.equal(calls.length, 1)
  } finally { client.dispose() }
})

test('missing SDK is unavailable without making raw network requests and can recover dynamically', async () => {
  const { client, setAuth } = fixture()
  setAuth(undefined)
  try {
    assert.equal(client.available(), false)
    await assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_AUTH_UNAVAILABLE' })
    setAuth({ getState: signedIn, request: async () => Response.json({ tool, result: { output: 'recovered' } }) })
    assert.equal(client.available(), true)
    assert.equal((await client.search(input)).output, 'recovered')
  } finally { client.dispose() }
})

test('login, logout, and relogin are reflected immediately without polling or reinstallation', async () => {
  const { client, calls, setState } = fixture()
  try {
    setState({ connected: false, sessionVersion: 'logged-out' })
    assert.equal(client.available(), false)
    await assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_LOGIN_REQUIRED' })
    assert.equal(calls.length, 0)
    setState(signedIn())
    assert.equal(client.available(), true)
    await client.search(input)
    setState({ connected: false })
    assert.equal(client.available(), false)
    await assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_LOGIN_REQUIRED' })
    setState({ ...signedIn(), sessionVersion: 'session-b' })
    assert.equal(client.available(), true)
    await client.search(input)
    assert.equal(calls.length, 2)
  } finally { client.dispose() }
})

test('rejects missing or malformed session identity, including asynchronous getState', async () => {
  const { client, setState, setAuth, calls } = fixture()
  try {
    for (const value of [null, {}, { connected: 'true' }, { connected: true }, { ...signedIn(), sessionVersion: '' },
      { ...signedIn(), enterpriseId: 123 }, { ...signedIn(), userId: '' }]) {
      setState(value)
      assert.equal(client.available(), false)
      await assert.rejects(client.search(input), { code: 'WEB_INVALID_RESPONSE' })
    }
    setAuth({ async getState() { return signedIn() }, request() { throw new Error('must not send') } })
    assert.equal(client.available(), false)
    await assert.rejects(client.search(input), { code: 'WEB_INVALID_RESPONSE' })
    assert.equal(calls.length, 0)
  } finally { client.dispose() }
})

test('discards results after logout, enterprise/user switch, or logout-and-relogin to the same account', async () => {
  for (const next of [{ connected: false }, { ...signedIn(), sessionVersion: 'session-b' },
    { ...signedIn(), enterpriseId: 'enterprise-b' }, { ...signedIn(), userId: 'user-b' }]) {
    const { client, setState } = fixture(() => { setState(next); return Response.json({ tool, result: { output: 'private old result' } }) })
    try { await assert.rejects(client.search(input), { code: 'WEB_ENTERPRISE_ACCOUNT_CHANGED' }) }
    finally { client.dispose() }
  }
})

test('does not dispatch a queued query after logout or enterprise/session switch', async () => {
  for (const next of [{ connected: false }, { ...signedIn(), sessionVersion: 'session-b' },
    { ...signedIn(), enterpriseId: 'enterprise-b' }]) {
    const { client, calls, setState } = fixture()
    try {
      const pending = client.search(input)
      setState(next)
      await assert.rejects(pending, { code: 'WEB_ENTERPRISE_ACCOUNT_CHANGED' })
      assert.equal(calls.length, 0)
    } finally { client.dispose() }
  }
})

test('cancellation before queued dispatch cannot send a generated business request', async () => {
  const { client, calls } = fixture()
  const controller = new AbortController()
  try {
    const pending = client.search(input, controller.signal)
    const rejected = assert.rejects(pending, { code: 'WEB_ABORTED' })
    controller.abort()
    await rejected
    assert.equal(calls.length, 0)
    await client.search(input)
    assert.equal(calls.length, 1)
    assert.match(calls[0].payload.arguments.id, uuidV4)
    assert.deepEqual(calls[0].payload, { arguments: businessArguments(calls[0].payload.arguments.id) })
  } finally { client.dispose() }
})

test('an already aborted request cannot dispatch through the host channel', async () => {
  const { client, calls } = fixture()
  const controller = new AbortController()
  controller.abort()
  try {
    await assert.rejects(client.search(input, controller.signal), { code: 'WEB_ABORTED' })
    assert.equal(calls.length, 0)
  } finally { client.dispose() }
})

test('maps upstream statuses without exposing bodies and keeps login usable after permission or transient errors', async () => {
  for (const [status, code] of [[400, 'WEB_INVALID_REQUEST'], [401, 'WEB_ENTERPRISE_LOGIN_REQUIRED'], [403, 'WEB_ENTERPRISE_FORBIDDEN'],
    [404, 'WEB_ENTERPRISE_TOOL_NOT_FOUND'], [429, 'WEB_PROVIDER_ERROR'], [500, 'WEB_PROVIDER_ERROR']]) {
    const { client } = fixture(() => new Response('secret upstream token', { status }))
    try {
      await assert.rejects(client.search(input), error => {
        assert.equal(error.code, code)
        assert.equal(error.status, status)
        assert.ok(error.message.includes(String(status)))
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret/)
        return true
      })
      assert.equal(client.available(), true)
    } finally { client.dispose() }
  }
})

test('preserves only safe backend diagnostic metadata through the search provider', async () => {
  const { client } = fixture(() => Response.json({
    error: { code: 'tool_arguments_invalid', message: 'secret-message', type: 'secret-type', details: { token: 'secret-details' } },
    request_id: requestId, details: 'secret-envelope',
  }, { status: 400, headers: { 'x-request-id': 'secret-header', 'x-error': 'secret-header' } }))
  const provider = createSearchProvider(client, input.model)
  try {
    await assert.rejects(provider.search({ query: input.query }), error => {
      assert.equal(error.code, 'WEB_INVALID_REQUEST')
      assert.equal(error.status, 400)
      assert.equal(error.backendCode, 'tool_arguments_invalid')
      assert.equal(error.requestId, requestId)
      for (const value of ['400', 'tool_arguments_invalid', requestId]) assert.ok(error.message.includes(value))
      assert.doesNotMatch(error.message + JSON.stringify(error), /secret/)
      assert.equal(error.cause, undefined)
      return true
    })
  } finally { provider.dispose(); client.dispose() }
})

test('never echoes unknown, malformed, uppercase, or non-string backend diagnostic codes and ids', async () => {
  for (const [code, id] of [['secret_unknown_code', 'secret-id'], ['TOOL_ARGUMENTS_INVALID', 'secret-id'],
    ['tool_arguments_invalid\nsecret', 'secret-id'], [123, { token: 'secret-id' }],
    [null, '12345678-1234-4234-8234-123456789abc-secret']]) {
    const { client } = fixture(() => Response.json({
      error: { code, message: 'secret-message', type: 'secret-type' }, request_id: id,
    }, { status: 500, headers: { 'x-request-id': requestId } }))
    try {
      await assert.rejects(client.search(input), error => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR')
        assert.equal(error.status, 500)
        assert.equal(error.backendCode, undefined)
        assert.equal(error.requestId, undefined)
        assert.ok(error.message.includes('500'))
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret|TOOL_ARGUMENTS_INVALID|12345678/)
        return true
      })
    } finally { client.dispose() }
  }
})

test('validates backend code and request id independently', async () => {
  for (const [backendCode, id, expectedCode, expectedId] of [
    ['tool_arguments_invalid', 'secret-invalid-id', 'tool_arguments_invalid', undefined],
    ['secret_unknown_code', requestId, undefined, requestId],
  ]) {
    const { client } = fixture(() => Response.json({
      error: { code: backendCode, message: 'secret-message' }, request_id: id,
    }, { status: 400 }))
    try {
      await assert.rejects(client.search(input), error => {
        assert.equal(error.code, 'WEB_INVALID_REQUEST')
        assert.equal(error.status, 400)
        assert.equal(error.backendCode, expectedCode)
        assert.equal(error.requestId, expectedId)
        if (expectedCode) assert.ok(error.message.includes(expectedCode))
        if (expectedId) assert.ok(error.message.includes(expectedId))
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret/)
        return true
      })
    } finally { client.dispose() }
  }
})

test('malformed, non-JSON, empty, or oversized error bodies retain the original HTTP status', async () => {
  const oversized = JSON.stringify({ error: { code: 'tool_arguments_invalid', message: 'secret'.repeat(4000) }, request_id: requestId })
  assert.ok(Buffer.byteLength(oversized) > 16 * 1024)
  for (const body of ['{', '<html>secret</html>', null, oversized]) {
    for (const [status, code] of [[400, 'WEB_INVALID_REQUEST'], [403, 'WEB_ENTERPRISE_FORBIDDEN'], [503, 'WEB_PROVIDER_ERROR']]) {
      const { client } = fixture(() => new Response(body, { status }))
      try {
        await assert.rejects(client.search(input), error => {
          assert.equal(error.code, code)
          assert.equal(error.status, status)
          assert.ok(error.message.includes(String(status)))
          assert.equal(error.backendCode, undefined)
          assert.equal(error.requestId, undefined)
          assert.doesNotMatch(error.message + JSON.stringify(error), /secret|tool_arguments_invalid|12345678/)
          return true
        })
      } finally { client.dispose() }
    }
  }
})

test('stalled error diagnostics have a short deadline independent of the search timeout', { timeout: 4000 }, async () => {
  let cancelled = false
  const keepAlive = setTimeout(() => {}, 4000)
  const { client } = fixture(() => new Response(new ReadableStream({
    cancel() { cancelled = true },
  }), { status: 503 }), { timeoutMs: 30000 })
  const started = performance.now()
  try {
    await assert.rejects(client.search(input), error => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.equal(error.status, 503)
      assert.ok(error.message.includes('503'))
      return true
    })
    assert.ok(performance.now() - started < 2500, 'diagnostic reads must not wait for the search timeout')
    assert.equal(cancelled, true)
  } finally { clearTimeout(keepAlive); client.dispose() }
})

test('retains a received HTTP failure when the overall search timeout expires during stalled diagnostics', { timeout: 2000 }, async () => {
  let cancelled = false
  const keepAlive = setTimeout(() => {}, 2000)
  const { client } = fixture(() => new Response(new ReadableStream({
    cancel() { cancelled = true },
  }), { status: 503 }), { timeoutMs: 20 })
  try {
    await assert.rejects(client.search(input), error => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.equal(error.status, 503)
      assert.ok(error.message.includes('503'))
      return true
    })
    assert.equal(cancelled, true)
  } finally { clearTimeout(keepAlive); client.dispose() }
})

test('caller cancellation during error diagnostic parsing still returns WEB_ABORTED and closes the stream', async () => {
  let entered, cancelled = false
  const reading = new Promise(resolve => { entered = resolve })
  const { client } = fixture(() => new Response(new ReadableStream({
    pull() { entered() }, cancel() { cancelled = true },
  }), { status: 400 }))
  const controller = new AbortController()
  try {
    const pending = client.search(input, controller.signal)
    const rejected = assert.rejects(pending, { code: 'WEB_ABORTED' })
    await reading
    controller.abort()
    await rejected
    assert.equal(cancelled, true)
  } finally { client.dispose() }
})

test('sanitizes host exceptions, including host WebError messages and causes', async () => {
  for (const error of [new Error('secret-token'), new WebError('secret-token', 'HOST_FAILURE'),
    Object.assign(new Error('secret-token'), { code: 'ENTERPRISE_PERMISSION_DENIED' })]) {
    const { client } = fixture(() => { throw error })
    try { await assert.rejects(client.search(input), value => !value.message.includes('secret') && value.cause === undefined) }
    finally { client.dispose() }
  }
  const client = createEnterpriseClient({ getAuth: () => { throw new WebError('secret-token', 'HOST_FAILURE') } })
  try {
    assert.equal(client.available(), false)
    await assert.rejects(client.search(input), error => error.code === 'WEB_ENTERPRISE_AUTH_UNAVAILABLE' && !error.message.includes('secret'))
  } finally { client.dispose() }
})

test('maps host authentication and session errors without exposing details', async () => {
  for (const [hostCode, code] of [['ENTERPRISE_LOGIN_REQUIRED', 'WEB_ENTERPRISE_LOGIN_REQUIRED'],
    ['ENTERPRISE_SESSION_CHANGED', 'WEB_ENTERPRISE_ACCOUNT_CHANGED'], ['ENTERPRISE_PERMISSION_DENIED', 'WEB_ENTERPRISE_FORBIDDEN']]) {
    const { client } = fixture(() => { throw Object.assign(new Error('private details'), { code: hostCode }) })
    try { await assert.rejects(client.search(input), { code }) } finally { client.dispose() }
  }
})

test('maps current SDK errorCode values without trusting host messages or status metadata', async () => {
  for (const [errorCode, code] of [['not_connected', 'WEB_ENTERPRISE_LOGIN_REQUIRED'],
    ['session_changed', 'WEB_ENTERPRISE_ACCOUNT_CHANGED'], ['authorization_denied', 'WEB_ENTERPRISE_FORBIDDEN'],
    ['request_aborted', 'WEB_ABORTED'], ['secret_unknown_error', 'WEB_PROVIDER_ERROR']]) {
    const hostError = Object.assign(new Error('secret-host-message'), {
      errorCode, status: 418, backendCode: 'secret-backend-code', requestId: 'secret-request-id',
      cause: new Error('secret-cause'), details: 'secret-details',
    })
    const { client } = fixture(() => { throw hostError })
    try {
      await assert.rejects(client.search(input), error => {
        assert.equal(error.code, code)
        assert.equal(error.status, undefined)
        assert.equal(error.backendCode, undefined)
        assert.equal(error.requestId, undefined)
        assert.equal(error.cause, undefined)
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret|418/)
        return true
      })
    } finally { client.dispose() }
  }
})

test('validates the configured response tool and object result, malformed JSON, and oversized results', async () => {
  const responses = [() => Response.json({ output: 'legacy unwrapped result' }),
    () => Response.json({ result: { output: 'missing tool' } }),
    () => Response.json({ tool: 'other_tool', result: { output: 'wrong tool' } }),
    () => Response.json({ tool: null, result: { output: 'invalid tool' } }),
    () => Response.json({ tool }), () => Response.json({ tool, result: null }),
    () => Response.json({ tool, result: [] }), () => Response.json({ tool, result: 'answer' }),
    () => new Response('{'), () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    () => new Response(null, { status: 204 })]
  for (const response of responses) {
    const { client } = fixture(response)
    try { await assert.rejects(client.search(input), { code: 'WEB_INVALID_RESPONSE' }) } finally { client.dispose() }
  }
  const { client } = fixture(() => Response.json({ tool, error: { message: 'secret' } }))
  try { await assert.rejects(client.search(input), { code: 'WEB_PROVIDER_ERROR' }) } finally { client.dispose() }
})

test('ignores extraneous response ids rather than correlating them to requests', async () => {
  for (const id of [undefined, 'unrelated-id', requestId, null, 123, { unrelated: true }]) {
    const { client } = fixture(() => Response.json({ tool, id, result: { output: 'answer' } }))
    try { assert.deepEqual(await client.search(input), { output: 'answer' }) }
    finally { client.dispose() }
  }
  const { client } = fixture(() => Response.json({ tool, result: { output: 'wrong configured tool' } }), { toolKey: 'search-v2' })
  try { await assert.rejects(client.search(input), { code: 'WEB_INVALID_RESPONSE' }) }
  finally { client.dispose() }
})

test('caller cancellation permits an immediate native web retry even if the host ignores abort', async () => {
  let entered, searches = 0
  const started = new Promise(resolve => { entered = resolve })
  const { client, calls } = fixture(() => {
    if (++searches > 1) return Response.json({ tool, result: { output: 'retry answer' } })
    entered()
    return new Promise(() => {})
  })
  const ctx = new Context()
  const web = await ctx.plugin(WebRuntime, { searchProvider: 'bs-web-search' })
  const provider = createSearchProvider(client, input.model)
  const registration = await ctx.inject(['web'], scope => { scope.web.registerSearchProvider(provider) })
  try {
    const controller = new AbortController()
    const pending = ctx.get('web').search({ query: input.query }, controller.signal)
    const rejected = assert.rejects(pending, { code: 'WEB_ABORTED' })
    await started
    controller.abort()
    await rejected
    assert.equal(provider.available(), true)
    assert.equal((await ctx.get('web').search({ query: input.query })).content, 'retry answer')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].signal.aborted, true)
    assert.notEqual(calls[0].payload.arguments.id, calls[1].payload.arguments.id)
    for (const call of calls) {
      assert.match(call.payload.arguments.id, uuidV4)
      assert.deepEqual(call.payload, { arguments: businessArguments(call.payload.arguments.id) })
    }
  } finally { provider.dispose(); client.dispose(); await registration.dispose(); await web.dispose() }
})

test('disposal aborts a pending request and closes a late response from a noncompliant host', async () => {
  let entered, finish, cancelled = false, observedSignal
  const started = new Promise(resolve => { entered = resolve })
  const { client } = fixture((path, init) => {
    observedSignal = init.signal
    entered()
    return new Promise(resolve => { finish = resolve })
  })
  const provider = createSearchProvider(client, input.model)
  const pending = provider.search({ query: input.query })
  const rejected = assert.rejects(pending, { code: 'WEB_ABORTED' })
  await started
  client.dispose()
  await rejected
  assert.equal(observedSignal.aborted, true)
  assert.equal(provider.available(), false)
  finish(new Response(new ReadableStream({ cancel() { cancelled = true } })))
  await new Promise(setImmediate)
  assert.equal(cancelled, true)
  provider.dispose()
})

test('cancellation closes an in-progress response body instead of hanging in the stream', async () => {
  let entered, cancelled = false
  const reading = new Promise(resolve => { entered = resolve })
  const { client } = fixture(() => new Response(new ReadableStream({
    pull() { entered() }, cancel() { cancelled = true },
  })))
  const provider = createSearchProvider(client, input.model)
  const controller = new AbortController()
  const pending = provider.search({ query: input.query }, controller.signal)
  const rejected = assert.rejects(pending, { code: 'WEB_ABORTED' })
  await reading
  controller.abort()
  await rejected
  assert.equal(cancelled, true)
  provider.dispose(); client.dispose()
})

test('enforces a search timeout without exposing internal SDK details', async () => {
  const keepAlive = setTimeout(() => {}, 1000)
  const { client } = fixture(() => new Promise(() => {}), { timeoutMs: 10 })
  try { await assert.rejects(client.search(input), { code: 'WEB_TIMEOUT' }) }
  finally { clearTimeout(keepAlive); client.dispose() }
})

test('missing authentication service does not block activation, and adding it later enables search', async () => {
  const ctx = new Context()
  const web = await ctx.plugin(WebRuntime, { searchProvider: 'original' })
  const scope = await ctx.plugin(plugin, {})
  try {
    assert.equal(scope.state, 2)
    assert.equal(web.config.searchProvider, 'bs-web-search')
    await assert.rejects(ctx.get('web').search({ query: 'test' }), { code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
    ctx.provide('enterpriseAuth', { getState: signedIn, request: async () => Response.json({ tool, result: { output: 'ready' } }) })
    assert.equal((await ctx.get('web').search({ query: 'test' })).content, 'ready')
  } finally { await scope.dispose(); await web.dispose() }
})

test('mock host adapter attaches token outside the plugin and exercises the tool API over real HTTP', async () => {
  const calls = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({ path: request.url, authorization: request.headers.authorization, body })
    response.setHeader('content-type', 'application/json')
    if (Object.keys(body).length !== 1 || !body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) {
      response.statusCode = 400
      response.end(JSON.stringify({ error: { code: 'tool_arguments_invalid', message: 'Top-level extras forbidden', type: 'ValidationError' }, request_id: requestId }))
      return
    }
    const args = body.arguments
    if (typeof args.id !== 'string' || !uuidV4.test(args.id) || !isDeepStrictEqual(args, businessArguments(args.id))) {
      response.statusCode = 400
      response.end(JSON.stringify({ error: { code: 'tool_arguments_invalid', message: 'Declared search shape required', type: 'ValidationError' }, request_id: requestId }))
      return
    }
    response.end(JSON.stringify({ tool, result: { output: 'http answer', results: [{ url: 'https://example.com' }] } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const pluginCalls = []
  const auth = { getState: signedIn, async request(path, init) {
    pluginCalls.push({ path, ...init })
    // Only this mock host adapter owns the credential. The plugin cannot access it.
    return fetch(new URL(path, origin), { ...init, redirect: 'error', headers: { ...init.headers, authorization: 'Bearer host-owned-token' } })
  } }
  const client = createEnterpriseClient({ getAuth: () => auth })
  const provider = createSearchProvider(client, input.model)
  try {
    const result = await provider.search({ query: input.query })
    assert.equal(result.content, 'http answer')
    assert.equal(result.sources[0].url, 'https://example.com/')
    assert.equal(calls[0].path, endpoint)
    assert.equal(calls[0].authorization, 'Bearer host-owned-token')
    assert.deepEqual(calls[0].body, { arguments: businessArguments(calls[0].body.arguments.id) })
    assert.match(calls[0].body.arguments.id, uuidV4)
    assert.deepEqual(pluginCalls[0].headers, { 'content-type': 'application/json' })
    // Probe the strict backend mock directly, outside the plugin's valid request path.
    for (const extra of [{ id: 'legacy-id' }, { tool }, { query: input.query }]) {
      const rejected = await auth.request(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ arguments: input, ...extra }),
      })
      assert.equal(rejected.status, 400)
      assert.deepEqual(await rejected.json(), {
        error: { code: 'tool_arguments_invalid', message: 'Top-level extras forbidden', type: 'ValidationError' }, request_id: requestId,
      })
    }
  } finally {
    provider.dispose(); client.dispose()
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  }
})
