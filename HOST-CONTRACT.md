# BISHENG Work Integration Contract

The search plugin requires the enterpriseAuth.invokeTool SDK in the BISHENG Work
source package packages/dsh-desktop-enterprise. Source support is not proof of
production deployment or backend authorization. Upgrade the host and plugin together.

## Public SDK

The host registers enterpriseAuth even while logged out. The approved plugin
instance uses its Cordis-scoped service; it never receives credentials or broker URLs.

~~~ts
interface EnterpriseAuth {
  getState(): {
    connected: boolean
    sessionVersion: string
    enterpriseId?: string
    userId?: string
  }
  invokeTool(toolName: string, args: Record<string, unknown>, options?: {
    signal?: AbortSignal
    timeoutMs?: number
    maxInputBytes?: number
    maxResponseBytes?: number
  }): Promise<unknown>
}
~~~

getState() is a synchronous public snapshot for availability, not authorization.
The host checks instance permission and the current session on each request.
The plugin detects invokeTool support; old hosts remain unavailable rather than
falling back to a duplicate transport implementation.

The SDK also retains request(path, init) for arbitrary same-origin enterprise APIs,
including binary and streaming responses. Search does not call that lower-level API.

## Responsibility boundaries

- Electron main owns credentials, enterprise origin resolution, refresh, logout,
  per-instance permission, session pinning, transport limits and cancellation.
- The shared enterprise SDK owns tool names and invocation paths, the arguments
  and tool/result envelopes, bounded JSON reads, safe diagnostics and timeouts.
- This plugin owns search input validation, business UUID generation, model and
  commands construction, result normalization, WebError mapping and provider lifecycle.

Neither the host broker nor the shared SDK understands search-specific fields.
New tools and legal relative API paths do not require a new host business route.
The raw broker must forward business payloads unchanged. The tool SDK wraps args
without adding business fields such as id, model or commands.

## Search protocol

The plugin invokes invokeTool(config.toolKey, args, options). The historical
field toolKey means the exact saved tool name, not generated tool_key; default
bs_web_search. Model defaults to gpt-5.6-terra.

~~~js
await auth.invokeTool('bs_web_search', {
  id: crypto.randomUUID(),
  model: 'gpt-5.6-terra',
  commands: { search_query: [{ q: query }] },
}, { signal, timeoutMs: 60000, maxInputBytes: 65536, maxResponseBytes: 4194304 })
~~~

The SDK sends POST /api/v1/dsh/tools/bs_web_search/invoke with only
{ arguments: args }, validates the response tool, and returns envelope.result.
The generic result can be any JSON value; this search plugin requires an object
and normalizes output/results. The business UUID is not an authentication or
response correlation ID. Explicit retries generate a fresh UUID; no automatic
retry occurs. The backend OpenAPI schema must support nested id/model/commands.

## Errors and resource limits

The shared SDK applies the supplied 60-second deadline, 65536-byte serialized
UTF-8 input limit and 4 MiB JSON response limit. HTTP diagnostic reads are limited
to 16 KiB and one second; unreadable diagnostics retain the received HTTP failure.
Caller cancellation takes precedence. Caller/plugin disposal cancellation flows
through the SDK into the request and response body.

EnterpriseToolError exposes errorCode and optional status/backendCode/requestId.
The SDK whitelists backend codes and UUID-shaped request IDs, discards raw error
messages, response bodies and causes, and never replays a failed business request.
The plugin maps invalid_request/invalid_response to WEB_INVALID_REQUEST/
WEB_INVALID_RESPONSE, not_connected to WEB_ENTERPRISE_LOGIN_REQUIRED,
authorization_denied to WEB_ENTERPRISE_FORBIDDEN, session_changed to
WEB_ENTERPRISE_ACCOUNT_CHANGED, request_aborted to WEB_ABORTED, request_timeout
to WEB_TIMEOUT, tool_not_found to WEB_ENTERPRISE_TOOL_NOT_FOUND, and other
failures to WEB_PROVIDER_ERROR.

## Security and acceptance

Approved instances share the existing enterpriseAuth authorization; invokeTool
is not a privileged bypass. The main process must reject cross-origin URLs and
credential/header overrides, and revoke/cancel work on account switch or unload.
The SDK checks session identity before dispatch and after reading results; these
checks complement, not replace, main-process session isolation.

Shared-process Node plugins are not a strong sandbox against malicious code.
Backend user authorization is not necessarily fine-grained plugin authorization.
The ZIP network permission is not by itself permission to use enterpriseAuth.

Plugin regressions cover the SDK adapter, search arguments, lifecycle, provider
selection and packaging. Generic tool transport, JSON/envelope validation, HTTP
diagnostics, authorization and session safety are tested in BISHENG Work. Joint
host/plugin integration and real enterprise backend, Electron UI, installed builds
and target-native platform acceptance remain separate from isolated mocks.
