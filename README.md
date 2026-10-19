# bs-web-search

Enterprise web search for BISHENG Work. Version 0.2.2 calls the backend tool API
through a generic host authentication channel, not a search-specific local proxy.

## Integration status

This version uses the **ctx.enterpriseAuth** SDK now present in the inspected
BISHENG Work source, and sends the search tool's native id/model/commands protocol
inside the generic tool invocation envelope. See
[HOST-CONTRACT.md](HOST-CONTRACT.md) for the integration contract. The plugin can
activate without the service, but search remains unavailable. Isolated tests do
not establish production deployment compatibility or a successful live search.

There is no dependency on enterpriseSearch, /v1/search, /v1/state, broker
environment variables, or a global broker capability. There is no raw fetch or
plugin-managed login, token, API key, or enterprise base URL.

## Behavior

Activation automatically selects bs-web-search for native web.search, leaving
the fetch provider unchanged. Disabling or uninstalling restores the earlier
search selection unless the user explicitly chose another provider in the
meantime. Later fetch changes are preserved, including during a concurrent web
restart. The plugin waits for the initial web service without coupling its outer
lifetime to later web restarts.

Login availability comes from the synchronous host state snapshot, without
polling. Logout disables search immediately when the host updates that snapshot.
A fresh session check is performed before each request and after reading the
response; results from another user, enterprise, or session are discarded. The
host is responsible for invalidating credentials and cancelling in-flight calls
on logout or account switch. The plugin never falls back to the old provider
when enterprise authentication is unavailable.

The Profile patch only inserts the plugin; it does not preset search/fetch
configuration. Do not install simultaneous market and Profile copies. Safe Mode
does not load market plugins. An explicit conflicting DSH_WEB_SEARCH_PROVIDER
environment override must be removed before activation.

## Configuration

~~~yaml
model: gpt-6.1-sol
toolKey: bs_web_search
~~~

The historical configuration field toolKey contains the exact saved tool **name**,
not its generated tool_key. It remains named toolKey for configuration compatibility.
It accepts 1-125 ASCII letters, digits, underscores or hyphens. It cannot
contain a URL, path, query or fragment. The model must be a non-empty string of
at most 256 characters. Search queries must be non-empty and at most 32768
characters. The complete serialized UTF-8 JSON request must also fit within the
backend default 65536-byte input limit, including JSON escaping, the generated UUID,
and the complete nested search command and model fields.
Only search input is sent; no conversation history is transmitted.

## Tool protocol

The plugin calls:

~~~text
POST /api/v1/dsh/tools/bs_web_search/invoke
Content-Type: application/json
~~~

~~~json
{
  "arguments": {
    "id": "12345678-1234-4234-8234-123456789abc",
    "model": "gpt-6.1-sol",
    "commands": { "search_query": [{ "q": "search query" }] }
  }
}
~~~

The path uses the tool name configured in toolKey. The plugin generates a fresh
UUIDv4 with crypto.randomUUID() for every business request, preserves the query,
and constructs commands.search_query itself. The UUID is not a response correlation
ID or an authentication value, and a new explicit retry gets a new UUID. The host
resolves the current enterprise origin and adds authentication. The plugin supplies
no Authorization header and the host must not rewrite the business payload.

Expected response:

~~~json
{
  "tool": "bs_web_search",
  "result": {
    "output": "Readable summary",
    "results": [
      { "url": "https://example.com", "title": "Title", "snippet": "Excerpt" }
    ],
    "truncated": false
  }
}
~~~

The request must contain only arguments: the backend rejects extra top-level
fields, including id. The response tool must match the configured toolKey, and
result must be an object for this search provider. There is no request/response id
matching. Tool errors fail rather than becoming search content; unwrapped legacy
responses are rejected. The backend validates arguments against the saved tool
OpenAPI schema, not a built-in search signature. The saved tool must declare the
actual id/model/commands request shape, and the invocation API must support
generic nested object/array validation. A backend limited to flat scalar inputs
or still configured with the former query/model adapter is incompatible with 0.2.2.
The backend OpenAPI executor should send the declared body unchanged; it must not
generate the UUID or perform search-specific protocol conversion.

The output maps to DSH content, and citations map to sources; optional
published_at maps to publishedAt. Invalid or credential-bearing URLs are removed
and duplicate citations are collapsed. The encrypted_output field is not treated
as readable search content. The web runtime enforces maxResults.

Requests time out after 60 seconds and JSON responses are limited to 4 MiB.
Caller cancellation and plugin disposal abort requests and body reading, including
late response cleanup if a host adapter ignores cancellation. Error bodies and
raw SDK exceptions are not surfaced. HTTP failures retain status, whitelisted
backend error.code, and UUID-shaped request_id in the message and as status,
backendCode and requestId properties. Raw error messages, details, and headers
are never echoed. Diagnostic JSON reads are capped at 16 KiB and one second;
unreadable diagnostics do not replace the original HTTP status. HTTP 400 maps
to WEB_INVALID_REQUEST; 401/403/404 distinguish expired login, permission denial
and a missing tool. No business request is retried automatically.

## Develop and package

Use Node.js 22+ and npm:

~~~sh
npm ci
npm test
npm run build
npm pack --dry-run
~~~

The build produces .build/bs-web-search-0.2.2.zip with an enterprise manifest
and SHA-256 inventories for six platform/architecture targets. Runtime source,
types and the host contract are included. Host peer packages are not bundled.
ZIPs, dependencies and tarballs are not committed.

The existing market manifest has only a generic network permission; it does not
express or grant the new host authentication permission. Its services field lists
fixed HTTPS origins, not Cordis services, so it remains empty. The host/market
must explicitly grant and bind authentication-channel access to each approved
plugin instance; adding a field here cannot implement that security boundary.

Tests cover SDK and tool-envelope contracts, login/logout and session isolation,
input and response validation, cancellation and timeouts, credential-free plugin
requests, automatic provider replacement/restoration, and ZIP integrity. A local
HTTP test uses a mock host to attach credentials outside the plugin. These tests
do not verify production enterprise authorization or a deployed Gateway.

## License

MIT. Extracted from the BISHENG Work development tree; original DataElement
copyright is retained in LICENSE.
