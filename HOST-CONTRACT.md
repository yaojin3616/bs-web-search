# BISHENG Work Integration Contract

This is the host-side contract consumed by bs-web-search 0.2.2. The inspected
BISHENG Work source now provides the generic enterpriseAuth implementation. New
plugin business APIs must not require host code changes. Production deployment
and enterprise/backend authorization still require end-to-end acceptance.

## Cordis service

Expose **enterpriseAuth** in the plugin's Cordis scope. Its implementation may use
IPC or an internal HTTP broker, but plugin code must use this SDK only. A complete
TypeScript shape is exported as EnterpriseAuth from this plugin's public types.

~~~ts
interface EnterpriseAuth {
  getState(): {
    connected: boolean
    sessionVersion: string
    enterpriseId?: string
    userId?: string
  }
  request(path: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | Uint8Array
    signal?: AbortSignal
  }): Promise<Response>
}
~~~

The getState() method is a synchronous, locally cached snapshot, never a Promise
or a network request. Keep the service registered while logged out. Session
metadata must not include tokens or a privileged broker capability.

The sessionVersion is a non-empty, non-secret string, at most 256 characters.
Change it on login/logout, account or enterprise switch, revoked authorization,
and any new authenticated session, including logout/relogin to the same account.
Ordinary access-token refresh within the same session must not change it. Optional
enterprise/user identifiers are non-empty strings of at most 256 characters.

The request() method returns a standard Fetch Response with status, headers and a
readable body. HTTP business errors (including 401/403/404/500) return Responses;
they do not throw raw backend error text. Host transport/authentication failures
may throw errors with these stable codes, which the plugin recognizes:

| Host code | Plugin mapping |
| --- | --- |
| errorCode: not_connected | WEB_ENTERPRISE_LOGIN_REQUIRED |
| errorCode: session_changed | WEB_ENTERPRISE_ACCOUNT_CHANGED |
| errorCode: authorization_denied | WEB_ENTERPRISE_FORBIDDEN |
| errorCode: request_aborted | WEB_ABORTED |

Legacy uppercase code values ENTERPRISE_LOGIN_REQUIRED, ENTERPRISE_SESSION_CHANGED
and ENTERPRISE_PERMISSION_DENIED remain recognized. SDK error messages are never
forwarded verbatim.

Other SDK failures become a sanitized WEB_PROVIDER_ERROR. Missing or broken SDK
state becomes WEB_ENTERPRISE_AUTH_UNAVAILABLE; malformed state is invalid.

## Host security responsibilities

- Resolve paths against the trusted API origin of the current enterprise.
- Accept new API paths without per-business-route code or whitelist changes.
- Reject absolute URLs, cross-origin resolution and other origin bypasses.
- Own token storage/refresh and add authentication only after authorization.
- Reject plugin overrides of Authorization, Host, Cookie and sensitive headers.
- Default to no redirect following; never forward credentials to another origin.
- Bind channel authorization to the real plugin execution instance. Never trust
  a self-reported plugin id or distribute one shared privileged broker key.
- Authorize every request; a synchronous connected flag is not authorization.
- Propagate cancellation through transport and streaming body consumption.
- On logout, session switch, or permission revocation, cancel pending calls and
  discard old-session responses, even after response headers have been returned.
- Enforce generic resource limits and audit without logging credentials.
- Do not automatically replay arbitrary non-idempotent business requests.

The plugin checks session identity before and after each successful response as
an additional safeguard. That does not replace host-side session pinning: the
host must not send an old operation under a newly switched account.

The host must decide how authentication-channel permission is approved in the
enterprise market. The current ZIP manifest's network permission is not itself
authentication authorization. If backend fine-grained plugin authorization is
required, attach a trusted plugin identity or use plugin-scoped credentials on the
host side; do not trust an arbitrary header supplied by the plugin.

## Business protocol owned by the plugin

The search plugin invokes POST /api/v1/dsh/tools/{toolName}/invoke. The historical
configuration field toolKey is retained for compatibility but means the exact
saved tool name, not the generated tool_key. Default name: bs_web_search; default
model: gpt-5.6-terra. Tool names are limited to 125 identifier characters.

The plugin sends { arguments: { id, model, commands: { search_query: [{ q }] } } }.
It generates id with crypto.randomUUID() for each business request and maps the
native query to q. This UUID is not used for response correlation or authorization.
The strict invocation envelope contains only arguments; extra top-level fields,
including id, remain forbidden. Success is { tool: toolName, result: ... }; the
plugin checks tool and reads result without requiring an echoed UUID.

The complete serialized request, including UUID, nested commands and JSON escaping,
is bounded to the backend default 65536 UTF-8 bytes. The saved OpenAPI schema must
declare id/model/commands, and the invocation API must support generic nested
objects/arrays. Flat-only backends and the former query/model search adapter are
not compatible with this release. The backend validates the declared protocol and
sends it unchanged; no search-specific adapter belongs in the host or generic
OpenAPI executor.

Error responses use { error: { code, message, type }, request_id }. The plugin
keeps only status, recognized business codes and UUID-shaped request IDs, not
raw messages/types/details. The SDK should preserve the response body; the
plugin bounds diagnostic parsing separately from success parsing.

The host must not implement special handling for this path, toolKey, request
envelope, or search results. It forwards the request and response unchanged,
except for its generic transport/security rules. No enterpriseSearch service or
local search-specific endpoint is required.

## Host acceptance checklist

1. Register SDK even while logged out; installing/activating the plugin succeeds.
2. Login makes the provider usable without plugin reinstall or polling.
3. A mock backend receives the requested business path/body and host-added token.
4. A newly added business API works without host code changes or new route rules.
5. Requests cannot send credentials to another origin or override auth headers.
6. Logout/switch/revocation cancel requests and invalidate stale responses.
7. AbortSignal cancels both pending requests and body streams.
8. Standard JSON, binary, streaming, and HTTP error responses are preserved.
9. Unauthorized/disabled plugin instances cannot use the channel.

The installed host market loader can verify ZIP loading and provider selection
without this SDK, but authenticated tool success requires the host implementation
and the actual backend. Contract mocks are not production acceptance.
