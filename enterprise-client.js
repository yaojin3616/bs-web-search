import * as crypto from 'node:crypto'
import { WebError } from '@deepseek-ai/dsh-web'
import { createLegacyEnterpriseClient } from './legacy-enterprise-client.js'

const object = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const localErrors = new WeakSet()
const failure = (message, code) => {
  const error = new WebError(message, code)
  localErrors.add(error)
  return error
}
const errorCodes = {
  invalid_request: 'WEB_INVALID_REQUEST', invalid_response: 'WEB_INVALID_RESPONSE',
  not_connected: 'WEB_ENTERPRISE_LOGIN_REQUIRED', authorization_denied: 'WEB_ENTERPRISE_FORBIDDEN',
  session_changed: 'WEB_ENTERPRISE_ACCOUNT_CHANGED', request_aborted: 'WEB_ABORTED',
  request_timeout: 'WEB_TIMEOUT', tool_not_found: 'WEB_ENTERPRISE_TOOL_NOT_FOUND',
}

function searchError(error) {
  const mapped = failure('Enterprise search tool request failed.', Object.hasOwn(errorCodes, error?.errorCode) ? errorCodes[error.errorCode] : 'WEB_PROVIDER_ERROR')
  // The shared SDK owns diagnostic sanitization; do not forward raw exception messages or causes.
  if (error?.name === 'EnterpriseToolError') {
    const details = []
    if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      mapped.status = error.status
      details.push(`HTTP ${error.status}`)
    }
    if (typeof error.backendCode === 'string' && /^[a-z][a-z_]{0,63}$/u.test(error.backendCode)) {
      mapped.backendCode = error.backendCode
      details.push(`code=${error.backendCode}`)
    }
    if (typeof error.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(error.requestId)) {
      mapped.requestId = error.requestId
      details.push(`request_id=${error.requestId}`)
    }
    if (details.length) mapped.message = `Enterprise search tool request failed (${details.join('; ')}).`
  }
  return mapped
}

/** Search business adapter. Authentication, transport and tool envelopes belong to the host SDK. */
export function createEnterpriseClient({ getAuth, toolKey = 'bs_web_search' } = {}) {
  if (typeof getAuth !== 'function') throw new TypeError('An enterprise authentication service resolver is required.')
  if (typeof toolKey !== 'string' || !/^[A-Za-z0-9_-]{1,125}$/u.test(toolKey)) {
    throw new TypeError('Search toolKey must contain only letters, digits, underscores, or hyphens (1-125 characters).')
  }
  const lifetime = new AbortController()
  const legacy = createLegacyEnterpriseClient({ getAuth, toolKey })
  const resolveAuth = () => {
    let auth
    try { auth = getAuth() } catch { /* Report unavailable without exposing host errors. */ }
    if (typeof auth?.getState !== 'function' || typeof auth?.invokeTool !== 'function') {
      throw failure('Update BISHENG Work to a version providing enterpriseAuth.invokeTool.', 'WEB_ENTERPRISE_AUTH_UNAVAILABLE')
    }
    return auth
  }
  return {
    dispose() { lifetime.abort(); legacy.dispose() },
    available() {
      if (lifetime.signal.aborted) return false
      try {
        const auth = getAuth()
        return typeof auth?.invokeTool === 'function'
          ? resolveAuth().getState()?.connected === true : legacy.available()
      } catch { return false }
    },
    async search(input, signal) {
      // Select before dispatch; never retry a failed SDK call via another transport.
      let candidate
      try { candidate = getAuth() } catch { /* The adapter reports a safe error. */ }
      if (typeof candidate?.invokeTool !== 'function') return legacy.search(input, signal)
      const execution = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      try {
        if (execution.aborted) throw failure('Enterprise search cancelled.', 'WEB_ABORTED')
        if (!object(input) || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 32768 ||
            typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256) {
          throw failure('A non-empty search query and model are required.', 'WEB_INVALID_REQUEST')
        }
        const auth = resolveAuth()
        const result = await auth.invokeTool(toolKey, {
          id: crypto.randomUUID(), model: input.model,
          commands: { search_query: [{ q: input.query }] },
        }, { signal: execution, timeoutMs: 60_000, maxInputBytes: 65536, maxResponseBytes: 4 * 1024 * 1024 })
        if (execution.aborted) throw failure('Enterprise search cancelled.', 'WEB_ABORTED')
        if (!object(result)) throw failure('Enterprise search returned an invalid result.', 'WEB_INVALID_RESPONSE')
        return result
      } catch (error) {
        if (execution.aborted) throw failure('Enterprise search cancelled.', 'WEB_ABORTED')
        if (localErrors.has(error)) throw error
        throw searchError(error)
      }
    },
  }
}
