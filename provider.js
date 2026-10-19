import { WebError } from '@deepseek-ai/dsh-web'

const object = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const optionalText = value => typeof value === 'string' && value.trim() ? value : undefined

/** Adapt structured citations without inventing sources from opaque/encrypted output. */
export function normalizeSearchResult(value) {
  if (!object(value) || (value.output !== undefined && typeof value.output !== 'string') ||
      (value.results !== undefined && !Array.isArray(value.results))) {
    throw new WebError('Enterprise search returned an invalid response.', 'WEB_INVALID_RESPONSE')
  }
  const content = optionalText(value.output)
  const sources = [], seen = new Set()
  for (const item of value.results ?? []) {
    if (!object(item) || typeof item.url !== 'string') continue
    let url
    try { url = new URL(item.url) } catch { continue }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue
    seen.add(url.href)
    sources.push({ url: url.href,
      ...(optionalText(item.title) ? { title: item.title } : {}),
      ...(optionalText(item.snippet) ? { snippet: item.snippet } : {}),
      ...(optionalText(item.published_at) ? { publishedAt: item.published_at } : {}) })
  }
  if (value.output === undefined && value.results === undefined) throw new WebError('Enterprise search returned no readable search output.', 'WEB_INVALID_RESPONSE')
  return { ...(content ? { content } : {}), sources, truncated: value.truncated === true }
}

/** Provider lifecycle and result caps are owned by ctx.web. */
export function createSearchProvider(enterprise, model) {
  const lifetime = new AbortController()
  return {
    id: 'bs-web-search',
    dispose: () => lifetime.abort(),
    available: () => !lifetime.signal.aborted && enterprise.available(),
    async search(request, signal) {
      const execution = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      try {
        execution.throwIfAborted()
        const result = await enterprise.search({ query: request.query, model }, execution)
        execution.throwIfAborted()
        return normalizeSearchResult(result)
      } catch (error) {
        if (execution.aborted) throw new WebError('Enterprise search cancelled.', 'WEB_ABORTED', { cause: error })
        if (error instanceof WebError) throw error
        throw new WebError('Enterprise search failed. Check your enterprise connection and search authorization.', 'WEB_PROVIDER_ERROR', { cause: error })
      }
    }
  }
}
