import * as crypto from 'node:crypto'
import { WebError } from '@deepseek-ai/dsh-web'

const object = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const localErrors = new WeakSet()
const failure = (message, code, details = {}) => {
  const error = Object.assign(new WebError(message, code), details)
  localErrors.add(error)
  return error
}
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_INPUT_BYTES = 65536
const BACKEND_CODES = new Set([
  'invalid_request', 'unsupported_parameter', 'context_length_exceeded',
  'invalid_access_token', 'session_expired', 'session_revoked', 'permission_denied', 'internal_error',
  'tool_not_found', 'tool_permission_denied', 'tool_unsupported', 'tool_arguments_invalid',
  'tool_concurrency_exceeded', 'tool_upstream_failed', 'tool_result_invalid',
  'tool_execution_timeout', 'tool_service_unavailable', 'tool_input_too_large', 'tool_output_too_large',
])

function readSession(getAuth) {
  let auth, state
  try {
    auth = getAuth()
    if (typeof auth?.getState !== 'function' || typeof auth?.request !== 'function') {
      throw failure('This BISHENG version does not provide the enterprise authentication channel.', 'WEB_ENTERPRISE_AUTH_UNAVAILABLE')
    }
    state = auth.getState()
  } catch (error) {
    if (localErrors.has(error)) throw error
    throw failure('Enterprise authentication channel is unavailable.', 'WEB_ENTERPRISE_AUTH_UNAVAILABLE')
  }
  if (!object(state) || typeof state.connected !== 'boolean') {
    throw failure('Enterprise authentication returned an invalid login state.', 'WEB_INVALID_RESPONSE')
  }
  if (!state.connected) return { auth, connected: false }
  if (typeof state.sessionVersion !== 'string' || !state.sessionVersion || state.sessionVersion.length > 256 ||
      ['enterpriseId', 'userId'].some(key => state[key] !== undefined &&
        (typeof state[key] !== 'string' || !state[key] || state[key].length > 256))) {
    throw failure('Enterprise authentication returned an invalid session identity.', 'WEB_INVALID_RESPONSE')
  }
  return { auth, connected: true, identity: JSON.stringify([state.sessionVersion, state.enterpriseId, state.userId]) }
}

function waitFor(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    const settle = callback => value => { signal.removeEventListener('abort', abort); callback(value) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(settle(resolve), settle(reject))
    if (signal.aborted) abort()
  })
}

async function readJson(response, signal, maxBytes = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader()
  if (!reader) throw failure('Enterprise tool returned an empty response.', 'WEB_INVALID_RESPONSE')
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks = []
  let size = 0
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await waitFor(reader.read(), signal)
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw failure('Enterprise tool response is too large.', 'WEB_INVALID_RESPONSE')
      chunks.push(Buffer.from(value))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      throw failure('Enterprise tool returned invalid JSON.', 'WEB_INVALID_RESPONSE')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function httpFailure(response, signal) {
  let payload
  const diagnosticSignal = AbortSignal.any([signal, AbortSignal.timeout(1000)])
  try { payload = await readJson(response, diagnosticSignal, 16 * 1024) } catch {
    // Diagnostics are best-effort once status is known, including at the total
    // deadline. The search catch still gives caller/disposal cancellation priority.
  }
  const backendCode = object(payload?.error) && BACKEND_CODES.has(payload.error.code) ? payload.error.code : undefined
  const requestId = typeof payload?.request_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(payload.request_id) ? payload.request_id : undefined
  const status = response.status
  const code = ({ 400: 'WEB_INVALID_REQUEST', 401: 'WEB_ENTERPRISE_LOGIN_REQUIRED',
    403: 'WEB_ENTERPRISE_FORBIDDEN', 404: 'WEB_ENTERPRISE_TOOL_NOT_FOUND' })[status] ?? 'WEB_PROVIDER_ERROR'
  const details = { status, ...(backendCode ? { backendCode } : {}), ...(requestId ? { requestId } : {}) }
  const diagnostic = [`HTTP ${status}`, ...(backendCode ? [`code=${backendCode}`] : []),
    ...(requestId ? [`request_id=${requestId}`] : [])].join('; ')
  return failure(`Enterprise search tool request failed (${diagnostic}).`, code, details)
}

/** Use the host's authenticated channel; never read credentials or call a raw URL. */
export function createEnterpriseClient({ getAuth, toolKey = 'bs_web_search', timeoutMs = 60_000 } = {}) {
  if (typeof getAuth !== 'function') throw new TypeError('An enterprise authentication service resolver is required.')
  if (typeof toolKey !== 'string' || !/^[A-Za-z0-9_-]{1,125}$/u.test(toolKey)) {
    throw new TypeError('Search toolKey must contain only letters, digits, underscores, or hyphens (1-125 characters).')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('A positive search timeout is required.')
  const lifetime = new AbortController()
  const path = `/api/v1/dsh/tools/${toolKey}/invoke`

  return {
    dispose() { lifetime.abort() },
    available() {
      if (lifetime.signal.aborted) return false
      try { return readSession(getAuth).connected } catch { return false }
    },
    async search(input, signal) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const execution = AbortSignal.any([lifetime.signal, timeout, ...(signal ? [signal] : [])])
      try {
        execution.throwIfAborted()
        if (!object(input) || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 32768 ||
            typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256) {
          throw failure('A non-empty search query and model are required.', 'WEB_INVALID_REQUEST')
        }
        const session = readSession(getAuth)
        if (!session.connected) throw failure('Sign in to your enterprise account to search.', 'WEB_ENTERPRISE_LOGIN_REQUIRED')
        const body = JSON.stringify({ arguments: {
          id: crypto.randomUUID(), model: input.model,
          commands: { search_query: [{ q: input.query }] },
        } })
        if (Buffer.byteLength(body, 'utf8') > MAX_INPUT_BYTES) {
          throw failure('Search arguments exceed the 65536-byte tool input limit.', 'WEB_INVALID_REQUEST')
        }
        const pending = Promise.resolve().then(() => {
          execution.throwIfAborted()
          const dispatch = readSession(getAuth)
          if (!dispatch.connected || dispatch.identity !== session.identity) {
            throw failure('Enterprise session changed before search dispatch.', 'WEB_ENTERPRISE_ACCOUNT_CHANGED')
          }
          return dispatch.auth.request(path, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body, signal: execution,
          })
        })
        // Close a late response if a host implementation ignores cancellation.
        void pending.then(response => { if (execution.aborted) void response?.body?.cancel().catch(() => {}) }, () => {})
        const response = await waitFor(pending, execution)
        execution.throwIfAborted()
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || typeof response.ok !== 'boolean') {
          throw failure('Enterprise authentication returned an invalid response.', 'WEB_INVALID_RESPONSE')
        }
        if (!response.ok) throw await httpFailure(response, execution)
        const payload = await readJson(response, execution)
        execution.throwIfAborted()
        const current = readSession(getAuth)
        if (!current.connected || current.identity !== session.identity) {
          throw failure('Enterprise session changed. Retry the search.', 'WEB_ENTERPRISE_ACCOUNT_CHANGED')
        }
        if (!object(payload) || payload.tool !== toolKey) {
          throw failure('Enterprise tool returned an invalid result envelope.', 'WEB_INVALID_RESPONSE')
        }
        if (payload.error !== undefined && payload.error !== null) {
          throw failure('Enterprise search tool execution failed.', 'WEB_PROVIDER_ERROR')
        }
        if (!object(payload.result)) throw failure('Enterprise tool returned an invalid result.', 'WEB_INVALID_RESPONSE')
        return payload.result
      } catch (error) {
        if (signal?.aborted || lifetime.signal.aborted) throw failure('Enterprise search cancelled.', 'WEB_ABORTED')
        if (localErrors.has(error)) throw error
        if (timeout.aborted) throw failure('Enterprise search timed out.', 'WEB_TIMEOUT')
        const hostCode = error?.errorCode ?? error?.code
        if (['not_connected', 'ENTERPRISE_LOGIN_REQUIRED'].includes(hostCode)) throw failure('Sign in to your enterprise account to search.', 'WEB_ENTERPRISE_LOGIN_REQUIRED')
        if (['session_changed', 'ENTERPRISE_SESSION_CHANGED'].includes(hostCode)) throw failure('Enterprise session changed. Retry the search.', 'WEB_ENTERPRISE_ACCOUNT_CHANGED')
        if (['authorization_denied', 'ENTERPRISE_PERMISSION_DENIED'].includes(hostCode)) throw failure('Enterprise search permission was denied.', 'WEB_ENTERPRISE_FORBIDDEN')
        if (hostCode === 'request_aborted') throw failure('Enterprise search cancelled.', 'WEB_ABORTED')
        throw failure('Enterprise authentication request failed.', 'WEB_PROVIDER_ERROR')
      }
    },
  }
}
