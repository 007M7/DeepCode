/**
 * Local-subprocess implementation of the bash executor seam. Each command runs
 * as `bash -c` in its own process group; disposal kills and joins live groups.
 * Execution policy belongs in `tools/pre-execute` or a sandboxing executor.
 * @module @deepseek-ai/dsh-bash-local
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { BashExecutor } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashProcess, BashProcessRead, BashRunResult } from '@deepseek-ai/dsh-bash'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_GRACE_MS, DEFAULT_MAX_SPILL_BYTES, runBash } from './run.ts'
import type { RunInternals, RunningBash } from './run.ts'

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Default working directory for commands (default: process.cwd()). */
  cwd?: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes?: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes?: number
  /** Grace period for kill escalation and for inherited pipes after shell exit. */
  graceMs?: number
}

/** The shape after schemastery applied the defaults (cwd has none). */
type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`bash-local: ${name} must be a positive finite number`)
  }
}

/**
 * Local bash executor with bounded output, spill files, and process-group
 * `SIGTERM` to `SIGKILL` escalation.
 */
export class LocalBashExecutor extends BashExecutor {
  static Config: z<Config> = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  /** Live processes retained only so disposal can kill and join them. */
  private live = new Map<BashProcess, RunningBash>()
  /** Test seam: spill knobs forwarded to runBash. */
  internals: RunInternals = {}

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery fills these fields before construction; the type does not encode that step.
    this.config = config as ResolvedConfig
    assertPositiveFinite('timeoutMs', this.config.timeoutMs)
    assertPositiveFinite('maxTimeoutMs', this.config.maxTimeoutMs)
    assertPositiveFinite('maxOutputBytes', this.config.maxOutputBytes)
    assertPositiveFinite('maxSpillBytes', this.config.maxSpillBytes)
    assertPositiveFinite('graceMs', this.config.graceMs)
    ctx.effect(() => async () => {
      // Await closure so even a TERM-trapping child cannot outlive the fiber.
      const pending: Promise<void>[] = []
      for (const [proc, running] of this.live) {
        proc.status = 'killed'
        running.kill()
        pending.push(proc.done)
      }
      this.live.clear()
      await Promise.all(pending)
    }, 'local bash teardown')
  }

  /**
   * Resolve a request into a fully-specified spec: fill `workdir` from
   * `config.cwd` (else `process.cwd()`), and `timeoutMs` from
   * `config.timeoutMs`, capped at `config.maxTimeoutMs`. The tool layer calls
   * this before {@link run}/{@link start}, so those methods receive explicit
   * values and never re-default.
   */
  resolve(request: BashExecRequest): BashExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      'bash-local: request.timeoutMs',
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes,
      ...request.signal ? { signal: request.signal } : {},
      // Carry stdin/ordinary env/trusted dshEnv through verbatim — optional,
      // no config default. run.ts owns the scrub and merge order.
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      // Carry a sandbox-mode override through verbatim: this executor never
      // confines, so the field is inert here (the seam contract) — a
      // sandboxing subclass overrides resolve() to stamp its default instead.
      sandboxMode: request.sandboxMode,
    }
  }

  async run(spec: BashExecSpec): Promise<BashRunResult> {
    // One deadline combines timeout and upstream cancellation; disposal clears its timer.
    using d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
    const outcome = await runBash({
      command: spec.command,
      cwd: spec.workdir,
      stdoutMaxBytes: spec.stdoutMaxBytes,
      stderrMaxBytes: this.config.maxOutputBytes,
      maxSpillBytes: this.config.maxSpillBytes,
      graceMs: this.config.graceMs,
      signal: d.signal,
      stdin: spec.stdin,
      env: spec.env,
      dshEnv: spec.dshEnv,
    }, this.internals).done
    // Only this executor's timeout reason counts as timedOut; outer deadlines count as aborts.
    const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
    const aborted = d.signal.aborted && !timedOut
    return { ...outcome, timedOut, aborted, timeoutMs: spec.timeoutMs }
  }

  start(spec: BashExecSpec): BashProcess {
    // Background runs ignore timeoutMs; callers stop them through kill() or spec.signal.
    const running = runBash({
      command: spec.command,
      cwd: spec.workdir,
      stdoutMaxBytes: this.config.maxOutputBytes,
      stderrMaxBytes: this.config.maxOutputBytes,
      maxSpillBytes: this.config.maxSpillBytes,
      graceMs: this.config.graceMs,
      signal: spec.signal,
      stdin: spec.stdin,
      env: spec.env,
      dshEnv: spec.dshEnv,
    }, this.internals)

    let stdoutOffset = 0
    let stderrOffset = 0
    const proc: BashProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        // Any signal termination is killed, including a command signaling itself.
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        this.onProcessDone(proc, running.stderr.readFrom(0).text)
        this.live.delete(proc)
      }, (error: unknown) => {
        // Background spawn failures settle as killed and surface through the read path.
        proc.status = 'killed'
        running.stderr.push(Buffer.from(`spawn failed: ${String(error)}`))
        this.onProcessDone(proc, running.stderr.readFrom(0).text)
        this.live.delete(proc)
      }),
      readOutput: (): BashProcessRead => {
        const out = running.stdout.readFrom(stdoutOffset)
        const err = running.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset

        // Single newline between sections: stdout chunks usually end with one
        // already; add it only when missing.
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text
          + (err.text.length > 0 ? `${separator}[stderr]\n${err.text}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.kill()
        return true
      },
    }
    this.live.set(proc, running)
    return proc
  }

  /**
   * Settlement hook for subclasses that attach execution facts to a process.
   * Called after exit facts or spawn-failure output are stamped and before
   * {@link BashProcess.done} resolves. The base implementation is intentionally
   * empty.
   * @param _proc - the settled process handle.
   * @param _stderr - the process's retained stderr tail used by subclasses for settlement classification.
   */
  protected onProcessDone(_proc: BashProcess, _stderr: string): void {}
}

export default LocalBashExecutor
