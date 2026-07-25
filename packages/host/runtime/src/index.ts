/**
 * @deepseek-ai/dsh-host-runtime — host runtime assembly layer: the core spine
 * composition (bootHost), the ApiProxy implementation (createApiProxy), and
 * the one-step shell seam (startHost). Host-level configuration (defaults,
 * persistenceRoot, future user profile) lives here.
 */

export { bootHost } from './boot.ts'
export type { BootHostOptions, HostDefaults, HostHandle } from './boot.ts'
export { createApiProxy } from './api-proxy.ts'
export type { ApiProxyDefaults } from './api-proxy.ts'
export { startHost } from './start.ts'
export type { StartHostOptions, RunningHost } from './start.ts'
export { mountWebPlugins } from './web-plugins.ts'
