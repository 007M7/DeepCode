/**
 * @deepseek-ai/dsh-host-runtime — host runtime assembly layer: the core spine
 * composition (bootHost) and the one-step shell seam (startHost). The ApiProxy
 * implementation lives in @deepseek-ai/dsh-host-apiproxy. Host-level
 * configuration (defaults, persistenceRoot, future user profile) lives here.
 */

export { bootHost } from './boot.ts'
export type { BootHostOptions, HostDefaults, HostHandle } from './boot.ts'
export { startHost } from './start.ts'
export type { StartHostOptions, RunningHost } from './start.ts'
