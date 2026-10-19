import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import * as plugin from '../index.js'

async function fixture(t, selection = 'original') {
  const calls = []
  const ctx = new Context()
  ctx.provide('enterpriseAuth', {
    getState() { return { connected: true, sessionVersion: 'session-a', enterpriseId: 'enterprise-a', userId: 'user-a' } },
    async request(path, init) {
      calls.push({ path, init })
      return Response.json({ tool: 'bs_web_search', result: { output: 'enterprise answer' } })
    }
  })
  const web = await ctx.plugin(WebRuntime, { ...(selection ? { searchProvider: selection } : {}), fetchProvider: 'local-fetch' })
  await web.await()
  const originalCalls = [], fetchCalls = []
  const upstream = ctx.inject(['web'], scope => {
    for (const id of ['original', 'other']) scope.web.registerSearchProvider({ id, available: () => true,
      async search(request) { originalCalls.push(id); return { content: id, sources: [], truncated: false } } })
    for (const id of ['local-fetch', 'other-fetch']) scope.web.registerFetchProvider({ id, available: () => true,
      async fetch(request) { fetchCalls.push(id); return { url: request.url, status: 200, content: id } } })
  })
  await upstream
  t.after(async () => { await upstream.dispose(); await web.dispose() })
  return { ctx, web, calls, originalCalls, fetchCalls }
}

test('installation replaces native web.search, preserves fetch, and restores the old search on disposal', async t => {
  const { ctx, web, calls, originalCalls, fetchCalls } = await fixture(t)
  assert.equal((await ctx.get('web').search({ query: 'before' })).content, 'original')
  originalCalls.length = 0
  const scope = ctx.plugin(plugin, {})
  try {
    await scope
    assert.equal(scope.state, 2)
    assert.equal(web.config.searchProvider, 'bs-web-search')
    assert.equal((await ctx.get('web').search({ query: 'news' })).content, 'enterprise answer')
    assert.equal(originalCalls.length, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, '/api/v1/dsh/tools/bs_web_search/invoke')
    const body = JSON.parse(calls[0].init.body)
    assert.deepEqual(body, { arguments: { id: body.arguments.id, model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'news' }] } } })
    assert.match(body.arguments.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' })
    await ctx.get('web').fetch({ url: 'https://example.com' })
    assert.deepEqual(fetchCalls, ['local-fetch'])
  } finally { await scope.dispose() }
  assert.equal(web.config.searchProvider, 'original')
  assert.equal(web.config.fetchProvider, 'local-fetch')
  assert.equal((await ctx.get('web').search({ query: 'after' })).content, 'original')
})

test('disposal does not overwrite a later explicit user search selection', async t => {
  const { ctx, web } = await fixture(t)
  const scope = ctx.plugin(plugin, {})
  try {
    await scope
    web.update({ ...web.config, searchProvider: 'other' }, true)
    await web.await()
    assert.equal((await ctx.get('web').search({ query: 'news' })).content, 'other')
  } finally { await scope.dispose() }
  assert.equal(web.config.searchProvider, 'other')
})

test('restoration retains a fetch selection changed while the plugin was active', async t => {
  const { ctx, web } = await fixture(t)
  const scope = ctx.plugin(plugin, {})
  try {
    await scope
    web.update({ ...web.config, fetchProvider: 'other-fetch' }, true)
    await web.await()
    // The child provider re-registers against the new web service without reselecting.
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) {
      if (fiber !== scope) await fiber.await()
    }
    assert.equal((await ctx.get('web').search({ query: 'news' })).content, 'enterprise answer')
  } finally { await scope.dispose() }
  assert.equal(web.config.searchProvider, 'original')
  assert.equal(web.config.fetchProvider, 'other-fetch')
})

test('disable during a web restart restores search while retaining the concurrent fetch change', async t => {
  const { ctx, web } = await fixture(t)
  const scope = await ctx.plugin(plugin, {})
  web.update({ ...web.config, fetchProvider: 'other-fetch' }, true)
  await scope.dispose()
  await web.await()
  assert.equal(web.config.searchProvider, 'original')
  assert.equal(web.config.fetchProvider, 'other-fetch')
  assert.equal(ctx.get('web').searchProviders.has('bs-web-search'), false)
})

test('disable during a user search change preserves the new explicit choice', async t => {
  const { ctx, web } = await fixture(t)
  const scope = await ctx.plugin(plugin, {})
  web.update({ ...web.config, searchProvider: 'other' }, true)
  await scope.dispose()
  await web.await()
  assert.equal(web.config.searchProvider, 'other')
})

test('plugin can start before the native web service and takes over once it is ready', async t => {
  const ctx = new Context()
  const pending = ctx.plugin(plugin, {})
  await new Promise(setImmediate)
  const web = await ctx.plugin(WebRuntime, { searchProvider: 'original', fetchProvider: 'local' })
  try {
    const scope = await pending
    assert.equal(scope.state, 2)
    assert.equal(web.config.searchProvider, 'bs-web-search')
    assert.equal(web.config.fetchProvider, 'local')
  } finally { await pending.dispose(); await web.dispose() }
})

test('disabling while waiting for web does not leave startup hanging', async t => {
  const ctx = new Context()
  const pending = ctx.plugin(plugin, {})
  const rejected = assert.rejects(Promise.resolve(pending), /disabled before web became ready/)
  await new Promise(setImmediate)
  await pending.dispose()
  await rejected
})

test('repeated enable and disable restores an initially unset search selection', async t => {
  const { ctx, web } = await fixture(t, null)
  for (let i = 0; i < 2; i++) {
    const scope = ctx.plugin(plugin, {})
    try {
      await scope
      assert.equal(web.config.searchProvider, 'bs-web-search')
      assert.equal((await ctx.get('web').search({ query: 'news' })).content, 'enterprise answer')
    } finally { await scope.dispose() }
    assert.equal(web.config.searchProvider, undefined)
  }
})

test('an explicit environment override fails clearly instead of silently using the old provider', async t => {
  const { web } = await fixture(t)
  const previous = process.env.DSH_WEB_SEARCH_PROVIDER
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER
    else process.env.DSH_WEB_SEARCH_PROVIDER = previous
  })
  process.env.DSH_WEB_SEARCH_PROVIDER = 'original'
  const { selectSearchProvider } = await import('../search-selection.js')
  const owner = web.context.plugin(async ctx => { await selectSearchProvider(ctx, 'bs-web-search') })
  try {
    await assert.rejects(Promise.resolve(owner), /DSH_WEB_SEARCH_PROVIDER/)
    assert.equal(web.config.searchProvider, 'original')
  } finally { await owner.dispose() }
})
