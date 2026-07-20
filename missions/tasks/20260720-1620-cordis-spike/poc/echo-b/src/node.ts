/**
 * echo-b: node-only plugin whose module augmentation (`ctx.echoB`) must never
 * become visible in the browser program. Also imports node:path so smuggling
 * it into a browser file-set is visibly wrong at the platform level too.
 */
import { isAbsolute } from 'node:path'

declare module 'cordis' {
  interface Context {
    echoB: EchoBService
  }
}

/** Node-side service registered by echo-b. */
export interface EchoBService {
  echo(text: string): string
}

/** Trivial runtime so the module has a value export alongside the augmentation. */
export function createEchoB(root: string): EchoBService {
  if (!isAbsolute(root)) throw new Error('echo-b requires an absolute root')
  return { echo: (text) => `ECHO-B(${root}): ${text}` }
}
