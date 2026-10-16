import type { Context } from '@deepseek-ai/cordis'
export declare const name = 'bs-web-search'
export declare const inject: readonly ['web', 'enterpriseSearch']
export interface SearchConfig { model: string }
export declare function apply(ctx: Context, config: SearchConfig): void
