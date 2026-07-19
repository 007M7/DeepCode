/** Package-owned runtime contracts for @deepseek-ai/dsh-agent-loop-testkit. @module @deepseek-ai/dsh-agent-loop-testkit/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-loop-testkit'

/** Cordis companion plugin name. */
export const name = 'agent-loop-testkit-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert the awaitable helper shape and optional-options call boundary. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.effect(async () => {
    const { mountAgentLoopTestDependencies } = await import('./index.ts')
    assertInvariant(fail,
      mountAgentLoopTestDependencies.constructor.name === 'AsyncFunction',
      'the prerequisite mount helper must remain awaitable so tests cannot race service activation')
    assertInvariant(fail, mountAgentLoopTestDependencies.length === 1,
      'the prerequisite mount helper must keep its options argument optional')
    return () => {}
  }, 'agent-loop-testkit: validate prerequisite mount boundary')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
