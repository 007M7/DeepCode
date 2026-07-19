/** Package-owned runtime contracts for @deepseek-ai/dsh-subagent-inprocess. @module @deepseek-ai/dsh-subagent-inprocess/invariant */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import { assertInvariant, type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subagent-inprocess'

/** Cordis companion plugin name. */
export const name = 'subagent-inprocess-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Assert that structured-output guidance names the tool it actually installs. */
const install: InvariantInstaller = async (_ctx, fail) => {
  const { STRUCTURED_OUTPUT_INSTRUCTION, STRUCTURED_OUTPUT_TOOL } = await import('./structured-protocol.ts')
  assertInvariant(fail, /^[a-z][a-z0-9_]*$/.test(STRUCTURED_OUTPUT_TOOL),
    'the structured-output tool must retain a stable lowercase protocol name')
  assertInvariant(fail, STRUCTURED_OUTPUT_INSTRUCTION.includes(STRUCTURED_OUTPUT_TOOL),
    'the structured-output instruction must name the exact installed tool')
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
