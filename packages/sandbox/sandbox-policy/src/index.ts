/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path, from `./session-mode.ts`).
 * Before each agent request, the owner also renders the resolved policy as the
 * `sandbox:policy` system section; request headers therefore reconstruct the
 * same mode and roots the enforcing consumers resolve.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here and register their independently disposable model-facing
 * families. The request section therefore describes only operations this
 * runtime actually fences, while each backend retains its own enforcement
 * dialect. The service reads session state once at each operation boundary;
 * executors and providers remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { resolve as resolvePath } from 'node:path'
import { Context, Service } from 'cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { canonicalPath, type SandboxExecutionPolicy, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { effectiveSandboxMode } from './session-mode.ts'

export { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from './session-mode.ts'

/** Resolve filesystem identity before lexical normalization can erase symlink-sensitive components. */
function resolveWorkspaceRoot(path: string): string {
  return resolvePath(canonicalPath(path))
}

/** Model-facing operation family whose current file policy is enforced by a runtime contribution. */
type FilePolicyFamily = 'filesystem' | 'bash' | 'terminal'

/** Canonical model-facing order, independent of plugin load order. */
const FILE_POLICY_FAMILIES: readonly FilePolicyFamily[] = ['filesystem', 'bash', 'terminal']

const FAMILY_LABELS: Readonly<Record<FilePolicyFamily, string>> = {
  filesystem: 'the write and edit tools',
  bash: 'one-shot bash commands',
  terminal: 'terminal sessions',
}

/** Join model-facing family names with stable English punctuation. */
function familyList(families: readonly FilePolicyFamily[], conjunction: 'and' | 'or'): string {
  const labels = families.map(family => FAMILY_LABELS[family])
  if (labels.length === 1) return labels[0] as string
  if (labels.length === 2) return `${labels[0]} ${conjunction} ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, ${conjunction} ${labels.at(-1)}`
}

/** Render only policy facts shared by every backend enforcing each registered family. */
function renderPolicyContext(policy: SandboxExecutionPolicy, families: readonly FilePolicyFamily[]): string {
  if (families.length === 0) return ''
  switch (policy.mode) {
    case 'read-only': {
      const subjects = familyList(families, 'and')
      return `Current DSH file policy: read-only. ${subjects[0]?.toUpperCase()}${subjects.slice(1)} cannot modify files under this policy.`
    }
    case 'workspace-write': {
      const subjects = familyList(families, 'and')
      return `Current DSH file policy: workspace-write. ${subjects[0]?.toUpperCase()}${subjects.slice(1)} may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    }
    case 'danger-full-access':
      return `Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict ${familyList(families, 'or')}.`
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
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
 * default mode, fallback workspace root, enforcing-family contributions, and
 * current request-time policy section. Tool layers call {@link resolve} for
 * each execution so a session's mode log and immutable cwd travel together to
 * every enforcing capability.
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
  /** Independently disposable enforcement-family contributions. */
  private readonly enforcedFamilies = new Map<FilePolicyFamily, Set<symbol>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.section({
        name: 'sandbox:policy',
        order: 110,
        text: (context) => {
          const session = context.agent?.session
          return session === undefined ? '' : renderPolicyContext(this.resolve({ session }), this.activeFamilies())
        },
      })
    })
  }

  /**
   * Register one runtime contribution that enforces the shared file policy for
   * a model-facing operation family. Equal families remain independently
   * disposable; registration and removal invalidate assembled prompt caches
   * when a system-prompt service is active.
   * @param family - operation family whose file effects this contribution enforces.
   * @returns the exact Cordis effect disposer for this contribution.
   */
  registerEnforcedFamily(family: 'filesystem' | 'bash' | 'terminal'): () => void {
    const token = Symbol(family)
    const dispose = this.ctx.effect(() => {
      const contributions = this.enforcedFamilies.get(family) ?? new Set<symbol>()
      contributions.add(token)
      this.enforcedFamilies.set(family, contributions)
      this.emitPromptChange()
      return () => {
        contributions.delete(token)
        if (contributions.size === 0 && this.enforcedFamilies.get(family) === contributions) {
          this.enforcedFamilies.delete(family)
        }
        this.emitPromptChange()
      }
    }, 'sandboxPolicy.registerEnforcedFamily()')
    return () => void dispose()
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
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return effectiveSandboxMode(session.events)
  }

  /** Active families in canonical model-facing order. */
  private activeFamilies(): FilePolicyFamily[] {
    return FILE_POLICY_FAMILIES.filter(family => (this.enforcedFamilies.get(family)?.size ?? 0) > 0)
  }

  /** Notify prompt consumers only after their registry exists. */
  private emitPromptChange(): void {
    if (this.ctx.get('systemPrompt') !== undefined) this.ctx.emit('system-prompt/change')
  }
}

export default SandboxPolicyService
