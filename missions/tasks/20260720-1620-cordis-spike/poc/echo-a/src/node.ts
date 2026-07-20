/**
 * Node half of echo-a. Imports a REAL node-side augmentation source
 * (dsh-session) and uses `ctx.sessions` — compiling green under
 * tsconfig.node.json is the positive proof that the node program sees it.
 */
import type { Context } from 'cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { EchoARpc } from './shared.ts'

/** Mount the node half; the `ctx.sessions` read type-checks only because dsh-session's augmentation is in-program. */
export function applyEchoANode(ctx: Context): keyof EchoARpc {
  void ctx.sessions
  const _probe: SessionId | undefined = undefined
  void _probe
  return 'echo-a/ping'
}
