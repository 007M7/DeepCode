/**
 * Node half with NO node: imports on purpose: the worst-case smuggle where
 * platform errors give zero warning and the augmentation is the only payload.
 */
declare module 'cordis' {
  interface Context {
    echoD: EchoDService
  }
}

/** Node-side service registered by echo-d. */
export interface EchoDService {
  echo(text: string): string
}

/** Trivial runtime so the module has a value export alongside the augmentation. */
export function createEchoD(): EchoDService {
  return { echo: (t) => `ECHO-D: ${t}` }
}
