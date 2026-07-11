/**
 * `SandboxBashExecutor`: the sandbox-consuming implementation of the `@deepseek-ai/dsh-bash`
 * executor seam.
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
 * Quote one string as a single-quoted POSIX shell word (embedded single
 * quotes become `'\''`), so a wrapped argv element survives the outer
 * `bash -c` re-parse byte-for-byte.
 * @param text - the raw argv element to quote.
 * @returns the single-quoted shell word.
 */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", String.raw`'\''`)}'`
}

/**
 * Classify a nonzero run using the selected backend's denial signatures.
 * @param result - the settled foreground run to classify.
 * @param signatures - the active wrap's denial dialect, case-insensitive stderr substrings.
 * @returns whether the run's failure reads as a sandbox denial.
 */
export function classifyDenial(result: BashRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}

/**
 * Classify a nonzero run using the selected backend's runner-failure signatures.
 * @param result - the settled foreground run to classify.
 * @param signatures - the active wrap's runner-failure signatures,
 *   case-insensitive stderr substrings.
 * @returns whether the run's failure reads as the runner itself failing.
 */
export function classifyRunnerFailure(result: BashRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}

/**
 * The classifier core shared by foreground results and settled background
 * tasks: failed AND signature present. Lowercases BOTH sides — the seam
 * declares its signatures case-insensitive, and producers compose them from
 * runtime data of any case (an `argv0` path, `No such file or directory`).
 */
function matchesSignature(exitCode: number | null, stderr: string, signatures: readonly string[]): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lowered = stderr.toLowerCase()
  return signatures.some(signature => lowered.includes(signature.toLowerCase()))
}

/**
 * Sandbox-consuming bash executor.
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
   * Per-task facts, keyed by task id from `start()` until the settle stamp consumes them: the
   * mode the task runs under (per-call — an escalated task differs from its neighbors) plus
   * its wrap facts.
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
    // Runner failure outranks denial: the sandbox itself failed and the command never RAN —
    // surface the same structured fail-closed error a confine-time discovery throws (late
    // detection, same outcome), with the runner's own first stderr line as the cause.
    if (classifyRunnerFailure(result, confined.runnerFailureSignatures)) {
      throw new SandboxUnavailableError(mode, result.stderr.text.trim().split('\n')[0])
    }
    return { ...result, sandbox: { mode, denied: classifyDenial(result, confined.denialSignatures), enforcement: confined.enforcement } }
  }

  override start(spec: BashExecSpec): BashTask {
    // Same stamped-by-resolve invariant as run().
    const mode = spec.sandboxMode as SandboxMode
    if (mode === 'danger-full-access') return super.start(spec)
    // Sandbox facts are stamped at settle time by {@link notifyTaskDone} (denial classification
    // runs against the settled task's collected stderr).
    const confined = this.confine(spec.command, mode)
    const task = super.start({ ...spec, command: confined.command })
    const { enforcement, denialSignatures, runnerFailureSignatures } = confined
    this.taskFacts.set(task.id, { mode, enforcement, denialSignatures, runnerFailureSignatures })
    return task
  }

  /**
   * Stamp the sandbox facts before completion listeners run: the base executor notifies from
   * inside the task's settle path, so overriding the notification point is what makes
   * `task.sandbox` visible to `onTaskDone` consumers and `done` awaiters alike.
   */
  protected override notifyTaskDone(task: BashTask): void {
    const facts = this.taskFacts.get(task.id)
    if (facts !== undefined) {
      this.taskFacts.delete(task.id)
      const stderr = this.collectedStderr(task.id)
      // Runner failure outranks denial (the command never ran; the runner's own error text can
      // contain denial words).
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
