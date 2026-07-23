/**
 * One-step host startup seam: boot core → assemble ApiProxy → assemble the
 * fetch handler. The returned RunningHost is shell-agnostic — node:http
 * (dsh web), in-process injection (dsh -p, tests), an IPC bridge (future
 * Electron sidecar), and front-door plugin mounting (future dsh acp) all
 * consume the same shape.
 */

import type { Context } from 'cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { bootHost } from './boot.ts'
import type { BootHostOptions, HostDefaults } from './boot.ts'
import { createApiProxy } from './api-proxy.ts'

/** Options for startHost. */
export interface StartHostOptions {
  /**
   * Passed through to bootHost verbatim. Future host-level knobs (profile,
   * log sink — any output added to the assembly MUST be switchable off here)
   * land as additive fields.
   */
  boot: BootHostOptions
}

/** Running host handle: the contract impl plus its fetch carrier and root ctx. */
export interface RunningHost {
  /** Contract implementation (direct calls for in-process consumers; the input of an IPC adapter). */
  api: ApiProxy
  /** WHATWG-fetch-shaped carrier (web shell bridges it to node:http; host-side endpoint of an IPC bridge). */
  handler: { fetch: typeof fetch }
  /** Host-level default routing (describe and every shell share this single source). */
  defaults: HostDefaults
  /**
   * Root context — a formal seam, not an escape hatch: (1) the mount point for
   * protocol front-door plugins (`dsh acp` = startHost() → ctx.plugin(uiAcp, config));
   * (2) headless session-event subscription. Discipline: consuming clients must
   * not bypass `api` through ctx; shells must not ctx.plugin to alter the
   * assembly (mounting a front door is the shell's own shape, not an assembly change).
   */
  ctx: Context
  /** Single shutdown exit (ctx.fiber.dispose()). Idempotent: a second call returns the same promise. */
  dispose(): Promise<void>
}

/**
 * Boot the host and assemble its consumption surfaces in one step.
 * @param options - boot passthrough (see StartHostOptions).
 * @returns the running host handle shared by every shell shape.
 */
export async function startHost(options: StartHostOptions): Promise<RunningHost> {
  const host = await bootHost(options.boot)
  const api = createApiProxy(host.ctx, host.defaults)
  const handler = toFetchHandler(api)
  let disposing: Promise<void> | undefined
  return { api, handler, defaults: host.defaults, ctx: host.ctx, dispose: () => (disposing ??= host.dispose()) }
}
