import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const host = process.argv[2]
if (!host) throw new Error('Usage: node scripts/check-host.mjs <enterprise-auth.js>')
const { applyEnterpriseAuth, bindEnterpriseAuth } = await import(pathToFileURL(resolve(host)).href)
import * as plugin from '../index.js'

const wire = []
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  wire.push({ path: request.url, body, authorization: request.headers.authorization })
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ tool: 'bs_web_search', result: { output: 'joint host/plugin answer', results: [{ url: 'https://example.com', title: 'Example' }] } }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const ctx = new Context()
applyEnterpriseAuth(ctx)
const web = await ctx.plugin(WebRuntime, { searchProvider: 'original', fetchProvider: 'original-fetch' })
const scope = ctx.plugin(plugin, {})
let revoke
try {
  await scope
  const state = { connected: true, sessionVersion: 'session-a' }
  revoke = await bindEnterpriseAuth(scope.context, {
    async state() { return state },
    async request(path, init) {
      return fetch(new URL(path, origin), { ...init, headers: { ...init.headers, authorization: 'Bearer mock-host-credential' } })
    },
  })
  const result = await ctx.get('web').search({ query: 'joint search' })
  assert.equal(result.content, 'joint host/plugin answer')
  assert.equal(result.sources[0].url, 'https://example.com/')
  assert.equal(wire.length, 1)
  assert.equal(wire[0].path, '/api/v1/dsh/tools/bs_web_search/invoke')
  assert.equal(wire[0].authorization, 'Bearer mock-host-credential')
  assert.deepEqual(Object.keys(wire[0].body), ['arguments'])
  assert.equal(wire[0].body.arguments.model, 'gpt-5.6-terra')
  assert.deepEqual(wire[0].body.arguments.commands, { search_query: [{ q: 'joint search' }] })
  assert.throws(() => ctx.get('enterpriseAuth').getState(), { errorCode: 'authorization_denied' })
  revoke()
  assert.equal(scope.context.get('enterpriseAuth') !== undefined, true)
  assert.equal(ctx.get('web').searchProviders.get('bs-web-search').available(), false)
  await scope.dispose()
  assert.equal(web.config.searchProvider, 'original')
  assert.equal(web.config.fetchProvider, 'original-fetch')
  console.log('PASS: real Cordis host SDK + search plugin + HTTP tool request; unauthorized root/revoked instance denied; selection restored')
} finally {
  revoke?.()
  await scope.dispose()
  await web.dispose()
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
