/**
 * Sandbox-consuming bash executor. It wraps the exact local bash argv through
 * `ctx.sandbox`, inherits local process mechanics, and reports the selected
 * mode, enforcement, and denial facts. Runner failure means the command never
 * ran: foreground calls throw `SANDBOX_UNAVAILABLE`, while settled background
 * processes carry `runnerFailed`. The tool owns approval and passes a complete
 * per-call policy.
 * @module @deepseek-ai/dsh-bash-sandbox
 */

import { Context } from 'cordis'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from '@deepseek-ai/dsh-bash'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedSandboxMode, SandboxEnforcement, SandboxExecutionPolicy, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import { classifyDenial, classifyRunnerFailure, matchesSignature, shellQuote } from './helpers.ts'

/**
 * Plugin config: the local executor's knobs, verbatim. The sandbox policy —
 * the default mode and fallback `workspace-write` root — is NOT here: it lives
 * on `ctx.sandboxPolicy` (`@deepseek-ai/dsh-sandbox-policy`), which resolves
 * each calling session's mode and cwd for every enforcing capability. The runner
 * choice is likewise the `ctx.sandbox` provider's config, not this executor's.
 */
export type Config = LocalConfig

/**
 * Registers as `ctx.bash` in place of the local executor and requires a
 * `ctx.sandbox` provider plus `ctx.sandboxPolicy`; the tool layer is
 * unchanged. Tool calls pass the calling session's resolved policy; direct
 * calls fall back to deployment policy. `result.sandbox` reports the mode and
 * enforcement actually used.
 */
export class SandboxBashExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  // No own Config: the sandbox default (mode + workspaceRoot) moved to
  // ctx.sandboxPolicy, so this executor inherits LocalBashExecutor's Config
  // verbatim (the config catalog walks the inherited static).

  private readonly mode: SandboxMode
  /**
   * Per-process confinement facts retained until settlement. Providers may
   * vary enforcement and diagnostic dialect between overlapping calls, so a
   * shared latest-wrap value would classify a process against the wrong facts.
   * Unconfined processes have no entry.
   */
  private readonly processFacts = new Map<BashProcess, {
    mode: ConfinedSandboxMode
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureSignatures: readonly string[]
  }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // The default mode is the capability fact used for schema advertisement;
    // actual tool executions carry their resolved per-call policy.
    this.mode = ctx.sandboxPolicy.defaultMode
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  override get sandboxMode(): SandboxMode {
    return this.mode
  }

  /**
   * Stamp a complete per-call policy onto the spec. Tool calls supply the
   * calling session's resolved mode and root; lower-level callers fall back to
   * the deployment policy.
   */
  override resolve(request: BashExecRequest): BashExecSpec {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }

  override async run(spec: BashExecSpec): Promise<BashRunResult> {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      const result = await super.run(spec)
      return { ...result, sandbox: { mode, denied: false } }
    }
    const confined = this.confine(spec.command, { ...policy, mode })
    const result = await super.run({ ...spec, command: confined.command })
    // Runner failure outranks denial because the command did not run. Throw the
    // same fail-closed error as confine-time discovery with the first stderr line.
    if (classifyRunnerFailure(result, confined.runnerFailureSignatures)) {
      throw new SandboxUnavailableError(mode, result.stderr.text.trim().split('\n')[0])
    }
    return { ...result, sandbox: { mode, denied: classifyDenial(result, confined.denialSignatures), enforcement: confined.enforcement } }
  }

  override start(spec: BashExecSpec): BashProcess {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') return super.start(spec)
    // Install facts synchronously; promise settlement cannot run before start() returns.
    const confined = this.confine(spec.command, { ...policy, mode })
    const proc = super.start({ ...spec, command: confined.command })
    const { enforcement, denialSignatures, runnerFailureSignatures } = confined
    this.processFacts.set(proc, { mode, enforcement, denialSignatures, runnerFailureSignatures })
    return proc
  }

  /**
   * Stamp per-process sandbox facts before `done` settles. Full-access processes
   * have no facts; signal deaths are not denials.
   */
  protected override onProcessDone(proc: BashProcess, stderr: string): void {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      // Runner failure outranks denial because its diagnostics may contain denial terms.
      const runnerFailed = matchesSignature(proc.exitCode, stderr, facts.runnerFailureSignatures)
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      }
    }
    super.onProcessDone(proc, stderr)
  }

  /**
   * Wrap one shell command via the `ctx.sandbox` provider: hand over the
   * exact `['bash', '-c', command]` argv this executor would spawn, get back
   * the confined argv, and re-assemble it into the `exec …` command string
   * the inherited spawn path runs (the outer `bash -c` the subprocess service spawns
   * `exec`s into the runner, so no extra shell lingers). Provider errors
   * (fail-closed `SANDBOX_UNAVAILABLE`) propagate to the caller unchanged.
   */
  private confine(command: string, policy: SandboxPolicy): {
    command: string
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureSignatures: readonly string[]
  } {
    const confined = this.ctx.sandbox.confine(['bash', '-c', command], policy)
    return {
      command: `exec ${confined.argv.map(shellQuote).join(' ')}`,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      runnerFailureSignatures: confined.runnerFailureSignatures,
    }
  }
}

export default SandboxBashExecutor
