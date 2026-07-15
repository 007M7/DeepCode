/**
 * Sandbox-consuming bash executor. It wraps the exact local bash argv through
 * `ctx.sandbox`, inherits local process mechanics, and reports the selected
 * mode, enforcement, and denial facts. Runner failure means the command never
 * ran: foreground calls throw `SANDBOX_UNAVAILABLE`, while settled background
 * processes carry `runnerFailed`. The tool owns approval and passes per-call modes.
 * @module @deepseek-ai/dsh-bash-sandbox
 */

import { resolve } from 'node:path'
import { Context } from 'cordis'
import z from 'schemastery'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from '@deepseek-ai/dsh-bash'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedSandboxMode, SandboxEnforcement, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'

/**
 * Plugin config: the local executor's knobs plus the sandbox policy. All
 * optional — `static Config` supplies the defaults (`mode: 'read-only'` is the
 * fail-safe default; an example that wants a workspace-writable agent opts in
 * explicitly). The runner choice is not configured here: which platform
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
 * Conservatively classify a nonzero, non-signal run using only the selected
 * backend's denial signatures. Text inference may miss a denial or match
 * unrelated stderr in that dialect; it never uses another backend's terms.
 * @param result - the settled foreground run to classify.
 * @param signatures - the active wrap's denial dialect, case-insensitive stderr substrings.
 * @returns whether the run's failure reads as a sandbox denial.
 */
export function classifyDenial(result: BashRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}

/**
 * Classify a nonzero run using the selected backend's runner-failure
 * signatures. Callers check this before denial because runner diagnostics may
 * contain denial words; the command did not run.
 * @param result - the settled foreground run to classify.
 * @param signatures - the active wrap's runner-failure signatures,
 *   case-insensitive stderr substrings.
 * @returns whether the run's failure reads as the runner itself failing.
 */
export function classifyRunnerFailure(result: BashRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}

/**
 * Shared classifier for failed runs. Signatures are case-insensitive and may
 * include runtime values such as an executable path.
 */
function matchesSignature(exitCode: number | null, stderr: string, signatures: readonly string[]): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lowered = stderr.toLowerCase()
  return signatures.some(signature => lowered.includes(signature.toLowerCase()))
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
    // Schemastery fills mode before construction; workspaceRoot and cwd retain runtime fallbacks.
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
    // Runner failure outranks denial because the command did not run. Throw the
    // same fail-closed error as confine-time discovery with the first stderr line.
    if (classifyRunnerFailure(result, confined.runnerFailureSignatures)) {
      throw new SandboxUnavailableError(mode, result.stderr.text.trim().split('\n')[0])
    }
    return { ...result, sandbox: { mode, denied: classifyDenial(result, confined.denialSignatures), enforcement: confined.enforcement } }
  }

  override start(spec: BashExecSpec): BashProcess {
    // Same stamped-by-resolve invariant as run().
    const mode = spec.sandboxMode as SandboxMode
    if (mode === 'danger-full-access') return super.start(spec)
    // Install facts synchronously; promise settlement cannot run before start() returns.
    const confined = this.confine(spec.command, mode)
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
