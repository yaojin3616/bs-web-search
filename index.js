import z from '@deepseek-ai/schemastery'
import { createSearchProvider } from './provider.js'

export const name = 'bs-web-search'
export const inject = ['web', 'enterpriseSearch']
export const Config = z.object({ model: z.string().default('gpt-5.6-sol') })

export function apply(ctx, config) {
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 256) throw new Error('bs-web-search requires a search model.')
  const provider = createSearchProvider(ctx.enterpriseSearch, config.model.trim())
  ctx.effect(() => () => provider.dispose(), 'bs-web-search requests')
  ctx.web.registerSearchProvider(provider)
}
