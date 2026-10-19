import z from '@deepseek-ai/schemastery'
import { createSearchProvider } from './provider.js'
import { createEnterpriseClient } from './enterprise-client.js'
import { selectSearchProvider } from './search-selection.js'

export const name = 'bs-web-search'
export const inject = []
export const Config = z.object({
  model: z.string().default('gpt-5.6-terra'),
  toolKey: z.string().default('bs_web_search'),
})

export async function apply(ctx, config) {
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 256) throw new Error('bs-web-search requires a search model.')
  const enterprise = createEnterpriseClient({ getAuth: () => ctx.get('enterpriseAuth'), toolKey: config.toolKey })
  ctx.effect(() => () => enterprise.dispose(), 'bs-web-search enterprise login')
  await selectSearchProvider(ctx, name)
  const registration = ctx.inject(['web'], scope => {
    const provider = createSearchProvider(enterprise, config.model.trim())
    scope.effect(() => () => provider.dispose(), 'bs-web-search requests')
    scope.web.registerSearchProvider(provider)
  })
  await registration
  if (registration.state !== 2) throw new Error('BISHENG could not register the enterprise search provider.')
}
