/** Package-owned runtime contracts for @deepseek-ai/dsh-acp-snapshot. @module @deepseek-ai/dsh-acp-snapshot/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-acp-snapshot'

/** Cordis companion plugin name. */
export const name = 'acp-snapshot-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert stable JSON-RPC correlation and volatile-value tokenization. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const { normalizeStdout } = await import('./normalize.ts')
    const sessionId = '12345678-1234-1234-1234-123456789abc'
    const volatile = { sessionIds: [sessionId], cwd: '/tmp/dsh-acp-invariant' }
    const raw = [
      JSON.stringify({ jsonrpc: '2.0', id: 'request-7', result: { cwd: volatile.cwd } }),
      JSON.stringify({ jsonrpc: '2.0', id: 'request-7', result: { sessionId } }),
    ].join('\n')
    const normalized = normalizeStdout(raw, volatile)
    assertInvariant(fail,
      normalized.includes('"id":1')
        && normalized.includes('"cwd":"{{cwd}}"')
        && normalized.includes('"sessionId":"{{sessionId}}"'),
      'ACP normalization must preserve RPC correlation while tokenizing cwd and session ids')
    assertInvariant(fail, normalizeStdout(normalized, volatile) === normalized,
      'ACP stdout normalization must be idempotent')
    return () => {}
  }, 'acp-snapshot: validate stable transcript normalization')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
