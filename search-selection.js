import { WebRuntime } from '@deepseek-ai/dsh-web'

async function waitForWeb(ctx) {
  if (ctx.get('web')) return
  let probe, cancel
  try {
    await new Promise((resolve, reject) => {
      // Disposal waits for startup, so cancel on the immediate lifecycle event.
      cancel = ctx.on('internal/plugin', fiber => {
        if (fiber === ctx.fiber && fiber.uid === null) {
          reject(new Error('bs-web-search was disabled before web became ready.'))
        }
      }, { global: true })
      probe = ctx.inject(['web'], () => { resolve() })
    })
  } finally {
    cancel?.()
    await probe?.dispose()
  }
}

/** Change the owning web fiber's config, not the runtime's private selector fields. */
export async function selectSearchProvider(ctx, id) {
  await waitForWeb(ctx)
  const web = ctx.get('web')
  const fibers = [...ctx.registry.get(WebRuntime)?.fibers ?? []]
  // Service proxies differ by caller; the registry identity survives those proxies.
  const fiber = fibers.find(candidate => candidate.state === 2 &&
    candidate.context.get('web')?.searchProviders === web?.searchProviders)
  if (!fiber) throw new Error('bs-web-search requires an active configurable BISHENG web runtime.')
  const override = process.env.DSH_WEB_SEARCH_PROVIDER?.trim()
  if (override && override !== id) {
    throw new Error('DSH_WEB_SEARCH_PROVIDER overrides search selection; remove the override before enabling bs-web-search.')
  }
  const before = fiber.config.searchProvider
  if (before === id) return

  const restore = async () => {
    if (fiber.uid === null) return
    // A concurrent fetch/config change may still be restarting web. A failed
    // restart must also allow recovery to the previously working selection.
    if (fiber.state !== 2) await fiber.await().catch(() => {})
    if (fiber.uid !== null && fiber.config.searchProvider === id) {
      // Preserve later changes to fetch and any explicit choice of another search provider.
      fiber.update({ ...fiber.config, searchProvider: before }, true)
      await fiber.await()
    }
  }
  // The caller must not inject web: changing its configuration restarts that service.
  ctx.effect(() => restore, 'bs-web-search selection')
  fiber.update({ ...fiber.config, searchProvider: id }, true)
  await fiber.await()
  if (fiber.state !== 2 || fiber.config.searchProvider !== id) {
    throw new Error('BISHENG could not select bs-web-search as the search provider.')
  }
}
