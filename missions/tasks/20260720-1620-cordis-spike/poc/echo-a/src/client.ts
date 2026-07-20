/**
 * Client half of echo-a. Its transitive closure defines the client TS
 * program: cordis + cosmokit + timer (client-safe augmentation) + shared.
 */
import { Context } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import type { EchoARpc } from './shared.ts'

/** Mount the client half; touching `ctx.timer` proves the client-safe augmentation is visible. */
export function applyEchoAClient(ctx: Context): keyof EchoARpc {
  ctx.plugin(TimerService)
  void ctx.timer
  return 'echo-a/ping'
}
