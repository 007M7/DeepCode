import { resolve } from 'node:path'
import type { Context } from 'cordis'
import * as SourceGuard from '@deepseek-ai/dsh-source-guard'

export const name = 'source-guard-fixture'

/**
 * Mount the real guard against the staging fixture in the process cwd. The
 * checkout under protection is a runtime fact of the isolated smoke directory,
 * which no static config value can name.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(SourceGuard, { protectedCheckout: resolve('staging/guard-anchor.ts') })
}
