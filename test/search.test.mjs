import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { normalizeSearchResult, createSearchProvider } from '../provider.js'
import * as plugin from '../index.js'
import { packPlugin } from '../scripts/pack.mjs'

test('normalizes citations, strips opaque output, and rejects invalid responses', () => {
  assert.deepEqual(normalizeSearchResult({ output: 'answer', encrypted_output: 'opaque', results: [
    { url: 'https://example.com', title: 'Example', snippet: 'excerpt', published_at: '2026-10-15' },
    { url: 'https://example.com/' }, { url: 'javascript:alert(1)' },
    { url: 'https://user:secret@example.com' }, { ref_id: 'turn0search0' }
  ] }), { content: 'answer', sources: [{ url: 'https://example.com/', title: 'Example', snippet: 'excerpt', publishedAt: '2026-10-15' }], truncated: false })
  assert.deepEqual(normalizeSearchResult({ output: 'text only' }).sources, [])
  assert.deepEqual(normalizeSearchResult({ results: [] }), { sources: [], truncated: false })
  for (const value of [{ encrypted_output: 'opaque' }, {}, { output: {} }, { results: 'wrong' }]) {
    assert.throws(() => normalizeSearchResult(value))
  }
})

test('uses host enterprise service, propagates cancellation, and stops on disposal', async () => {
  const calls = []
  const provider = createSearchProvider({ available: () => true, async search(input) {
    calls.push(input)
    return { output: 'answer' }
  } }, 'company-search')
  assert.equal(provider.available(), true)
  assert.equal((await provider.search({ query: 'news' })).content, 'answer')
  assert.deepEqual(calls, [{ query: 'news', model: 'company-search' }])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider.search({ query: 'news' }, controller.signal), { code: 'WEB_ABORTED' })
  provider.dispose()
  await assert.rejects(provider.search({ query: 'news' }), { code: 'WEB_ABORTED' })
  assert.equal(calls.length, 1)
  const failing = createSearchProvider({ async search() { throw new Error('private upstream details') } }, 'model')
  await assert.rejects(failing.search({ query: 'news' }), { code: 'WEB_PROVIDER_ERROR' })
  failing.dispose()
})

test('registers without enterpriseSearch and invokes the host enterprise tool', async () => {
  const ctx = new Context()
  let provider
  assert.deepEqual(plugin.inject, [])
  const calls = []
  ctx.provide('enterpriseAuth', {
    getState() { return { connected: true, sessionVersion: 'session-a', enterpriseId: 'enterprise-a', userId: 'user-a' } },
    async request(path, init) {
      calls.push({ path, init })
      return Response.json({ tool: 'bs_web_search', result: { output: 'answer' } })
    }
  })
  const web = ctx.plugin(WebRuntime, { searchProvider: 'original-search', fetchProvider: 'original-fetch' })
  await web
  const scope = ctx.plugin(plugin, {})
  try {
    await scope
    assert.equal(scope.state, 2)
    assert.equal(web.config.searchProvider, 'bs-web-search')
    assert.equal(web.config.fetchProvider, 'original-fetch')
    provider = ctx.get('web').searchProviders.get('bs-web-search')
    assert.equal(provider.available(), true)
    assert.equal((await ctx.get('web').search({ query: 'news' })).content, 'answer')
    assert.equal(calls.length, 1)
    const [{ path, init }] = calls
    assert.equal(path, '/api/v1/dsh/tools/bs_web_search/invoke')
    assert.deepEqual(Object.keys(init).sort(), ['body', 'headers', 'method', 'signal'])
    assert.equal(init.method, 'POST')
    assert.deepEqual(init.headers, { 'content-type': 'application/json' })
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(init.signal.aborted, false)
    const body = JSON.parse(init.body)
    assert.deepEqual(body, { arguments: { id: body.arguments.id, model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'news' }] } } })
    assert.match(body.arguments.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    assert.doesNotMatch(JSON.stringify(calls), /token|authorization|connectionKey|\/v1\/(?:state|search)/i)
  } finally {
    await scope.dispose()
    assert.equal(web.config.searchProvider, 'original-search')
    assert.equal(web.config.fetchProvider, 'original-fetch')
    await web.dispose()
  }
  await assert.rejects(provider.search({ query: 'news' }), { code: 'WEB_ABORTED' })
})

for (const state of ['missing SDK', 'logged out']) {
  test(`stays active with web.search unavailable when ${state}`, async () => {
    const ctx = new Context()
    if (state === 'logged out') ctx.provide('enterpriseAuth', {
      getState() { return { connected: false } },
      async request() { assert.fail('logged-out search must not invoke the host') }
    })
    const web = await ctx.plugin(WebRuntime, { searchProvider: 'original-search', fetchProvider: 'original-fetch' })
    const scope = ctx.plugin(plugin, {})
    try {
      await scope
      assert.equal(scope.state, 2)
      assert.equal(web.config.searchProvider, 'bs-web-search')
      assert.equal(web.config.fetchProvider, 'original-fetch')
      assert.equal(ctx.get('web').searchProviders.get('bs-web-search').available(), false)
      await assert.rejects(ctx.get('web').search({ query: 'news' }))
    } finally {
      await scope.dispose()
      assert.equal(web.config.searchProvider, 'original-search')
      await web.dispose()
    }
  })
}

test('builds a complete enterprise archive without bundling host peers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bs-search-pack-'))
  try {
    const entries = unzipSync(await readFile(await packPlugin(directory)))
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString())
    assert.equal(manifest.plugin.name, 'bs-web-search')
    assert.equal(manifest.plugin.version, '0.2.2')
    // services lists fixed HTTPS origins, not Cordis injection names.
    // This provider uses the host's current enterprise connection instead.
    assert.deepEqual(manifest.plugin.services, [])
    assert.match(manifest.plugin.version, /^\d+\.\d+\.\d+$/)
    assert.equal(Object.keys(manifest.targets).length, 6)
    for (const [target, inventory] of Object.entries(manifest.targets)) {
      assert.ok(inventory['node_modules/bs-web-search/index.js'])
      assert.ok(inventory['node_modules/bs-web-search/enterprise-client.js'])
      assert.ok(inventory['node_modules/bs-web-search/search-selection.js'])
      const patch = Buffer.from(entries[`bundles/${target}/node_modules/bs-web-search/cordis.patch.yml`]).toString()
      assert.doesNotMatch(patch, /searchProvider|fetchProvider/)
      const entry = Buffer.from(entries[`bundles/${target}/node_modules/bs-web-search/index.js`]).toString()
      assert.doesNotMatch(entry, /enterpriseSearch/)
      assert.match(entry, /enterpriseAuth/)
      const client = Buffer.from(entries[`bundles/${target}/node_modules/bs-web-search/enterprise-client.js`]).toString()
      for (const source of [entry, client]) {
        assert.doesNotMatch(source, /process\.env|DSH_DESKTOP_ENTERPRISE_BROKER|connectionKey|\/v1\/(?:state|search)|\bfetch\s*\(/)
      }
      for (const [file, digest] of Object.entries(inventory)) {
        assert.equal(createHash('sha256').update(entries[`bundles/${target}/${file}`]).digest('hex'), digest)
      }
    }
    assert.equal(Object.keys(entries).some(path => path.includes('node_modules/@deepseek-ai/')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
