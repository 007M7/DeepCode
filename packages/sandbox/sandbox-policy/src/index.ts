/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path, from `./session-mode.ts`).
 *
 * Both enforcing capability families read the SAME policy here: the sandboxed
 * bash executor (`@deepseek-ai/dsh-bash-sandbox`) and the sandboxed filesystem
 * provider (`@deepseek-ai/dsh-fs-sandbox`) consume the SAME resolved per-call
 * policy, so bash and fs can never confine to different roots — the split
 * world the sandbox RFC warns about. The service reads session state once at
 * the tool boundary; executors and providers remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { resolve as resolvePath } from 'node:path'
import { Context, Service } from 'cordis'
import z from 'schemastery'
import { canonicalPath, type SandboxExecutionPolicy, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import { sandboxOverrideOf } from './session-mode.ts'

export { SANDBOX_MODES, effectiveSandboxMode, sandboxOverrideOf, setSandboxMode } from './session-mode.ts'

/** Resolve filesystem identity before lexical normalization can erase symlink-sensitive components. */
function resolveWorkspaceRoot(path: string): string {
  return resolvePath(canonicalPath(path))
}

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
   * Fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode and fallback workspace root. Tool layers call {@link resolve}
 * for each execution so a session's mode log and immutable cwd travel together
 * to every enforcing capability.
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
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
    }
  }

  /**
   * A session's sandbox-mode OVERRIDE — the override chain alone, never the
   * deployment default: the fold of the session's OWN switches (events past
   * the seed boundary — a fork seed's stale parent switch is subsumed by the
   * baseline captured after it), else the header's inherited delegation
   * baseline. The subagent driver stamps `overrideOf(parent.session)` into
   * each child's creation meta, so the chain collapses one level per
   * delegation and a tightened parent binds children at any depth
   * ([rationale](../../../.agents/notes/implemented/feature/2026-07-25-subagent-policy-inheritance.md)).
   * @param session - the session whose override chain to resolve.
   * @returns the effective override, or `undefined` for a session following
   *   the deployment default.
   * @throws when the durable header baseline is outside the closed mode
   *   vocabulary (a corrupt or foreign log; durable-boundary validation).
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return sandboxOverrideOf(session)
  }
}

export default SandboxPolicyService
