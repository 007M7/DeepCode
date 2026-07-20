declare module 'cordis' {
  interface Context {
    echoC: EchoCService
  }
}
export interface EchoCService {
  echo(text: string): string
}
export interface EchoCSummary {
  label: string
}
export function createEchoC(): EchoCService {
  return { echo: (t) => `ECHO-C: ${t}` }
}
