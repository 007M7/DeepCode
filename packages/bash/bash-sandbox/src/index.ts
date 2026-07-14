/**
 * `SandboxBashExecutor`: the sandbox-consuming implementation of the
 * `@deepseek-ai/dsh-bash` executor seam. Every spawned command is wrapped by
 * the `ctx.sandbox` provider (`@deepseek-ai/dsh-sandbox`) according to the
 * configured {@link SandboxMode}: the executor hands the provider the exact
 * `['bash', '-c', command]` argv it is about to spawn and spawns the wrapped
 * argv instead. WHICH platform runner confines it — and whether one is
 * usable at all (the provider fails CLOSED with a structured
 * `SANDBOX_UNAVAILABLE` error rather than passing the argv through) — is the
 * provider's concern (`@deepseek-ai/dsh-sandbox-local` first).
 *
 * Extends `LocalBashExecutor` so all process mechanics — spawn, process-group
 * kills, timeout escalation, output collection and spill files, background
 * tasks, the credential scrub — are the local implementation's, verbatim.
 * This package adds only the seam consumption and the result facts, which is
 * exactly the split the capability seam was designed for (a sandboxing
 * executor replaces `dsh-bash-local` without touching `dsh-tool-bash`, and
 * swapping the confinement backend never touches this package).
 *
 * A failed run whose stderr carries the selected backend's own denial
 * dialect (the signatures the provider stamps on every wrap) is classified
 * as a sandbox denial on `BashRunResult.sandbox`, and every confined result
 * also carries how completely the selected runner enforces the mode
 * (`sandbox.enforcement`, from the provider's wrap). A failure carrying the
 * backend's RUNNER-FAILURE signature instead means the sandbox itself broke
 * and the command never ran: the foreground path re-throws it as the
 * structured fail-closed `SANDBOX_UNAVAILABLE` error (late twin of the
 * provider's confine-time throw), a settled background task stamps
 * `sandbox.runnerFailed` — either way a broken sandbox can never read as a
 * failing command, and the command never slips through unconfined.
 *
 * Deny-only at the seam, escalation at the tool: a denial is a reported FACT
 * here, and the one-shot user-approved escalated retry of a denied action
 * (docs/rfc/implemented/feature/2026-07-06-sandbox.md) is driven by
 * `dsh-tool-bash` through `ctx.approval` — this executor's contribution is the
 * per-call `sandboxMode` override it honors in {@link resolve}: an escalated
 * call runs (and classifies, and reports) under ITS granted mode while every
 * neighboring call keeps its session's standing mode (or the configured
 * default when that session has no override).
 *
 * @module @deepseek-ai/dsh-bash-sandbox
 */

import { resolve } from 'node:path'
import { Context } from 'cordis'
import z from 'schemastery'
import type { BashExecRequest, BashExecSpec, BashRunResult, BashTask, BashTaskId } from '@deepseek-ai/dsh-bash'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedSandboxMode, SandboxEnforcement, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import { classifyDenial, classifyRunnerFailure, matchesSignature, shellQuote } from './helpers.ts'

/**
 * Plugin config: the local executor's knobs plus the sandbox policy. All
 * optional — `static Config` supplies the defaults (`mode: 'read-only'` is the
 * fail-safe default; an example that wants a workspace-writable agent opts in
 * explicitly). The runner choice is NOT configured here: which platform
 * backend confines the command is the `ctx.sandbox` provider's config.
 */
export interface Config extends LocalConfig {
  /** File-sandbox mode commands run under (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Root directory `workspace-write` mode may write under (default: the
   * executor's default working directory — `cwd`, else `process.cwd()`).
   */
  workspaceRoot?: string
}

/**
 * Registers as `ctx.bash` in place of the local executor and requires a
 * `ctx.sandbox` provider; the tool layer is unchanged. The configured mode is
 * the fallback, while a session override or approved one-shot escalation may
 * select each call's mode. The prompt does not state the standing mode;
 * `result.sandbox` reports the mode and enforcement actually used.
 */
export class SandboxBashExecutor extends LocalBashExecutor {
  static inject = ['sandbox']

  // The sandbox-specific fields intersect the local executor's Config as an
  // inline schema call: the config catalog walks `static Config` statically.
  static override Config: z<Config> = z.intersect([
    LocalBashExecutor.Config,
    z.object({
      mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
      workspaceRoot: z.string(),
    }),
  ])

  private readonly mode: SandboxMode
  private readonly workspaceRoot: string
  /**
   * Per-task facts, keyed by task id from `start()` until the settle stamp
   * consumes them: the mode the task runs under (per-call — an escalated task
   * differs from its neighbors) plus its wrap facts. The seam returns facts
   * PER WRAP — a provider may legally vary enforcement or dialect between
   * calls — so overlapping background tasks must each classify against their
   * OWN wrap; a single latest-wrap field would let a later `start()` clobber
   * an earlier task's facts before it settles. A `danger-full-access` task
   * has NO entry (nothing confined it), which is what the settle stamp keys
   * off.
   */
  private readonly taskFacts = new Map<BashTaskId, {
    mode: ConfinedSandboxMode
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureSignatures: readonly string[]
  }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // schemastery (static Config) already filled the defaulted fields — the
    // cast records that runtime fact (mirrors LocalBashExecutor's config
    // cast). `workspaceRoot` and `cwd` have NO schema default, so their
    // fallback chain is real branching.
    this.mode = config.mode as SandboxMode
    this.workspaceRoot = resolve(config.workspaceRoot ?? config.cwd ?? process.cwd())
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  override get sandboxMode(): SandboxMode {
    return this.mode
  }

  /**
   * Stamp the effective mode onto the spec — the request's explicit override
   * (an approved escalation), else this executor's configured default — so
   * defaulting stays an explicit resolve step and `run()`/`start()` read the
   * spec, never the config.
   */
  override resolve(request: BashExecRequest): BashExecSpec {
    return { ...super.resolve(request), sandboxMode: request.sandboxMode ?? this.mode }
  }

  override async run(spec: BashExecSpec): Promise<BashRunResult> {
    // resolve() always stamps the mode; the cast records that invariant
    // (mirrors the constructor's config casts).
    const mode = spec.sandboxMode as SandboxMode
    if (mode === 'danger-full-access') {
      const result = await super.run(spec)
      return { ...result, sandbox: { mode, denied: false } }
    }
    const confined = this.confine(spec.command, mode)
    const result = await super.run({ ...spec, command: confined.command })
    // Runner failure outranks denial: the sandbox itself failed and the
    // command NEVER RAN — surface the same structured fail-closed error a
    // confine-time discovery throws (late detection, same outcome), with
    // the runner's own first stderr line as the cause. Returning it as a
    // task result would let a broken sandbox read as a failing command.
    if (classifyRunnerFailure(result, confined.runnerFailureSignatures)) {
      throw new SandboxUnavailableError(mode, result.stderr.text.trim().split('\n')[0])
    }
    return { ...result, sandbox: { mode, denied: classifyDenial(result, confined.denialSignatures), enforcement: confined.enforcement } }
  }

  override start(spec: BashExecSpec): BashTask {
    // Same stamped-by-resolve invariant as run().
    const mode = spec.sandboxMode as SandboxMode
    if (mode === 'danger-full-access') return super.start(spec)
    // Sandbox facts are stamped at settle time by {@link notifyTaskDone}
    // (denial classification runs against the settled task's collected
    // stderr). The map entry lands synchronously after spawn, strictly
    // before the earliest possible settle (a process exit reaches us no
    // sooner than the next tick).
    const confined = this.confine(spec.command, mode)
    const task = super.start({ ...spec, command: confined.command })
    const { enforcement, denialSignatures, runnerFailureSignatures } = confined
    this.taskFacts.set(task.id, { mode, enforcement, denialSignatures, runnerFailureSignatures })
    return task
  }

  /**
   * Stamp the sandbox facts BEFORE completion listeners run: the base
   * executor notifies from inside the task's settle path, so overriding the
   * notification point is what makes `task.sandbox` visible to `onTaskDone`
   * consumers and `done` awaiters alike. Each task classifies against the
   * facts of ITS OWN wrap and reports ITS OWN mode (consumed from the
   * per-task map here — settle is the entry's end of life): with per-call
   * escalation, tasks under different modes settle side by side, so keying
   * anything off the configured default would misreport them. A
   * `danger-full-access` task has no map entry and carries no facts (nothing
   * confined it); a signal-killed task (null exit code) is never a denial,
   * mirroring the foreground classifier.
   */
  protected override notifyTaskDone(task: BashTask): void {
    const facts = this.taskFacts.get(task.id)
    if (facts !== undefined) {
      this.taskFacts.delete(task.id)
      const stderr = this.collectedStderr(task.id)
      // Runner failure outranks denial (the command never ran; the runner's
      // own error text can contain denial words). A settled task has no
      // error channel left, so the fact IS the surface here — the foreground
      // path throws instead.
      const runnerFailed = matchesSignature(task.exitCode, stderr, facts.runnerFailureSignatures)
      task.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && matchesSignature(task.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      }
    }
    super.notifyTaskDone(task)
  }

  /**
   * Wrap one shell command via the `ctx.sandbox` provider: hand over the
   * exact `['bash', '-c', command]` argv this executor would spawn, get back
   * the confined argv, and re-assemble it into the `exec …` command string
   * the inherited spawn path runs (the outer `bash -c` that `runBash` spawns
   * `exec`s into the runner, so no extra shell lingers). Provider errors
   * (fail-closed `SANDBOX_UNAVAILABLE`) propagate to the caller unchanged.
   */
  private confine(command: string, mode: ConfinedSandboxMode): {
    command: string
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureSignatures: readonly string[]
  } {
    const confined = this.ctx.sandbox.confine(['bash', '-c', command], { mode, workspaceRoot: this.workspaceRoot })
    return {
      command: `exec ${confined.argv.map(shellQuote).join(' ')}`,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      runnerFailureSignatures: confined.runnerFailureSignatures,
    }
  }
}

export default SandboxBashExecutor
