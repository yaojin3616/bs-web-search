import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
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

test('registers and disposes through the real Cordis lifecycle', async () => {
  const ctx = new Context()
  let provider, active = false
  ctx.provide('enterpriseSearch', { available: () => true, async search() { return { output: 'answer' } } })
  ctx.provide('web', { registerSearchProvider(value) { provider = value; active = true } })
  const scope = ctx.plugin(plugin, { model: 'company-search' })
  try {
    await scope
    assert.equal(active, true)
    assert.equal((await provider.search({ query: 'news' })).content, 'answer')
  } finally {
    await scope.dispose()
  }
  await assert.rejects(provider.search({ query: 'news' }), { code: 'WEB_ABORTED' })
})

test('builds a complete enterprise archive without bundling host peers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bs-search-pack-'))
  try {
    const entries = unzipSync(await readFile(await packPlugin(directory)))
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString())
    assert.equal(manifest.plugin.name, 'bs-web-search')
    assert.equal(Object.keys(manifest.targets).length, 6)
    for (const [target, inventory] of Object.entries(manifest.targets)) {
      assert.ok(inventory['node_modules/bs-web-search/index.js'])
      for (const [file, digest] of Object.entries(inventory)) {
        assert.equal(createHash('sha256').update(entries[`bundles/${target}/${file}`]).digest('hex'), digest)
      }
    }
    assert.equal(Object.keys(entries).some(path => path.includes('node_modules/@deepseek-ai/')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
