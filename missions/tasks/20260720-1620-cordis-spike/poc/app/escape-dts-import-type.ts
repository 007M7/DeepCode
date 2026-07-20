/**
 * Escape probe 3 (the realistic apiproxy path): `import type` of a package
 * whose types resolve to a BUILT .d.ts carrying `declare module 'cordis'`.
 * Expected: the .d.ts contaminates the program despite import type + built
 * artifact — the tripwire below turns TS2578 to prove it.
 */
import type { Context } from 'cordis'
import type { EchoCSummary } from '@dsh-spike/echo-c'

export type Probe = EchoCSummary['label']

/** Standalone tripwire: red (TS2578) if the .d.ts augmentation leaked in. */
export function assertEchoCInvisible(ctx: Context): void {
  // @ts-expect-error ctx.echoC must stay invisible to the client program
  void ctx.echoC
}
