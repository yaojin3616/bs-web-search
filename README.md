# bs-web-search

BISHENG Work search provider, installed through the enterprise plugin market.
This plugin uses the host's enterprise HTTP service. It does not use MCP.

## Ownership and installation

This repository owns the plugin source, tests and offline ZIP packaging. DSH Work
does not depend on or clone this repository. Build a ZIP here, upload it through
enterprise market administration, then install and authorize it in Work.

The host must provide `web` and `enterpriseSearch` services and enterprise market
support for selecting this provider. A Desktop version number alone does not
prove those services are installed. Missing host capabilities prevent activation.
The host owns enterprise origin, credentials, refresh, account isolation and HTTP
requests. Neither an API key nor an upstream URL is accepted by this plugin.

When loading the authorized market plugin, the compatible host temporarily selects
`bs-web-search` as its search provider, retaining the fetch provider. Disposal
restores the previous selection unless the user selected another provider later.
The included `cordis.patch.yml` is an alternative for ordinary Profile composition;
do not install both copies. Safe Mode does not load market generations.

## Current service contract

Version 0.1.0 retains the extracted host service contract:

```js
ctx.enterpriseSearch.available()
ctx.enterpriseSearch.search({ query: 'search terms', model: 'company-search' }, signal)
```

The `model` plugin setting defaults to `gpt-5.6-sol`. The host service returns:

```json
{
  "output": "Readable summary",
  "results": [{"url":"https://example.com","title":"Title","snippet":"Excerpt"}],
  "truncated": false
}
```

`published_at` is optional on each result. The provider maps these fields to DSH's
`content`, `sources` and `truncated`, rejects invalid/credential-bearing URLs and
deduplicates citations. It ignores `encrypted_output`; opaque-only responses fail.
Only search input is sent, not conversation history. The native tool may run
multiple queries, with the host web service enforcing result limits.

The enterprise tool publishing API is being developed separately. Moving to
`/api/v1/dsh/tools/bs_web_search/invoke` requires a coordinated host-service update
that wraps `arguments` and unwraps `result`. This extraction does not claim that
endpoint is deployed. The old host adapter uses `/v1/alpha/search` and needs an
upstream request `id` fix before direct Codex use; raw Codex requests also require
`model` and `commands.search_query`. Those HTTP details belong to the host/server,
not to this provider. Version 0.1.0 is a development package, not production-ready.

## Develop and package

Use Node.js 22+ and npm:

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

`npm run build` creates `.build/bs-web-search-0.1.0.zip`, with the existing enterprise
manifest and SHA-256 inventories for six targets. The same pure-JS source is used
for each target, without bundling host peers. ZIPs, dependencies and tarballs are
generated artifacts and are not committed. Creating a ZIP does not publish a
catalog entry, activate a plugin or validate an installed Desktop application.

Tests cover result normalization, errors/cancellation, Cordis activation/disposal,
and offline archive completeness. Native Windows and installed-app acceptance
must be performed with the target host/server versions before release.

## License

MIT. Extracted from the BISHENG Work development tree; original DataElement
copyright is retained in LICENSE.
