/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox default — the file-effect {@link SandboxMode} a session
 * starts from and the `workspace-write` boundary root — plus the per-session
 * override kit (the `sandbox/mode` event, its fold, and its write path, from
 * `./session-mode.ts`).
 *
 * Both enforcing capability families read the SAME policy here: the sandboxed
 * bash executor (`@deepseek-ai/dsh-bash-sandbox`) and the sandboxed filesystem
 * provider (`@deepseek-ai/dsh-fs-sandbox`) inject `ctx.sandboxPolicy` for the
 * default mode and workspace root, so bash and fs can never confine to
 * different roots — the split world the sandbox RFC warns about. The default
 * lives here rather than on either executor's config precisely because it is
 * one fact two families share.
 *
 * This service holds only the DEFAULT; the per-session fold
 * ({@link effectiveSandboxMode}) is a pure function the tool layers apply to
 * stamp each call, so neither the executor nor the provider depends on session
 * events.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { resolve } from 'node:path'
import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

export { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from './session-mode.ts'

declare module 'cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Absolute root directory `workspace-write` may write under (default:
   * `process.cwd()`). Both enforcing families fence against this SAME root.
   */
  workspaceRoot?: string
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode and workspace root; enforcing implementations read
 * {@link defaultMode} and {@link workspaceRoot}, and the tool layers fold each
 * session's `sandbox/mode` override with {@link effectiveSandboxMode} on top.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
  })

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` boundary root both families fence against. */
  readonly workspaceRoot: string

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolve(config.workspaceRoot ?? process.cwd())
  }
}

export default SandboxPolicyService
