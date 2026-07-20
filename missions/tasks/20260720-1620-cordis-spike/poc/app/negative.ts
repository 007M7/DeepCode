/**
 * Negative proofs. In a CLEAN browser program both property reads are TS2339,
 * so the directives are consumed and tsc is green. If any node-side
 * augmentation leaks into the program, the corresponding directive becomes
 * "Unused '@ts-expect-error'" (TS2578) and tsc goes red — a mechanical tripwire.
 */
import type { Context } from 'cordis'

/** Assert node-side merges stay invisible to the browser program. */
export function assertNodeMergesInvisible(ctx: Context): void {
  // @ts-expect-error ctx.sessions is dsh-session's node-side augmentation
  void ctx.sessions
  // @ts-expect-error ctx.echoB is echo-b's node-half augmentation
  void ctx.echoB
}
