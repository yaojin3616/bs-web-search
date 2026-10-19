import type { Context } from '@deepseek-ai/cordis'
export declare const name = 'bs-web-search'
export declare const inject: readonly []
export interface SearchConfig {
  model: string
  /** Historical configuration name: the exact saved tool name, not its generated key. */
  toolKey: string
}
/** Host SDK contract required by this plugin; no credentials are exposed. */
export interface EnterpriseAuth {
  getState(): { connected: boolean; sessionVersion: string; enterpriseId?: string; userId?: string }
  invokeTool(toolName: string, args: Record<string, unknown>, options?: {
    signal?: AbortSignal
    timeoutMs?: number
    maxInputBytes?: number
    maxResponseBytes?: number
  }): Promise<unknown>
}
export declare function apply(ctx: Context, config: SearchConfig): Promise<void>
