/**
 * `LocalBashExecutor`: the local-subprocess implementation of the
 * `@deepseek-ai/dsh-bash` executor seam. Spawns `bash -c` per call in its
 * own process group (see `./run.ts` for the plumbing and the agent-tool
 * survey notes), tracks background tasks, and kills everything on dispose.
 *
 * TODO(permissions/sandbox): execution policy does NOT belong here — use
 * the `tools/pre-execute` deny/ask gate (see docs/architecture.md
 * § Extending The Harness) or implement a sandboxing `BashExecutor`.
 * Reference points:
 * Claude Code wraps commands in sandbox-exec/bubblewrap; Codex applies
 * seatbelt/landlock plus an execpolicy prefix-rule engine.
 *
 * @module @deepseek-ai/dsh-bash-local
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { BashExecutor, BashTaskId } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashRunResult, BashTask, BashTaskRead, OwnerToken } from '@deepseek-ai/dsh-bash'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_GRACE_MS, runBash } from './run.ts'
import type { RunInternals, RunningBash } from './run.ts'

export { DEFAULT_GRACE_MS, ENV_OVERRIDES, killGroup, OutputCollector, runBash } from './run.ts'
export type { RunInternals, RunningBash, SpawnOutcome, SpawnSpec } from './run.ts'

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
  /** Grace period between the SIGTERM and the SIGKILL escalation on a kill. */
  graceMs?: number
}

/** The shape after schemastery applied the defaults (cwd has none). */
type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`bash-local: ${name} must be a positive finite number`)
  }
}

interface TrackedTask extends BashTask {
  running: RunningBash
  /** Whole-stream byte offsets already delivered via {@link LocalBashExecutor.readOutput}. */
  stdoutOffset: number
  stderrOffset: number
  /** Opaque owner token from the {@link BashExecSpec} (the consumer's isolation key). */
  owner: OwnerToken | undefined
}

/**
 * Local-subprocess bash executor. Defaults follow the agent-tool survey
 * consensus: 120s default / 600s max timeout (Claude Code, OpenCode), 64KB
 * in-memory output with full-stream spill files (pi, OpenCode),
 * process-group SIGTERM→SIGKILL kills with a 3s grace (OpenCode).
 */
export class LocalBashExecutor extends BashExecutor {
  static Config: z<Config> = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  private tasks = new Map<BashTaskId, TrackedTask>()
  private nextTaskId = 1
  /** Test seam: spill knobs forwarded to runBash. */
  internals: RunInternals = {}

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // schemastery (static Config) has already filled the defaulted fields;
    // the cast records that runtime fact for exactOptionalPropertyTypes.
    this.config = config as ResolvedConfig
    assertPositiveFinite('timeoutMs', this.config.timeoutMs)
    assertPositiveFinite('maxTimeoutMs', this.config.maxTimeoutMs)
    assertPositiveFinite('maxOutputBytes', this.config.maxOutputBytes)
    assertPositiveFinite('graceMs', this.config.graceMs)
    ctx.effect(() => async () => {
      // Kill every live process group and WAIT for the processes to close so
      // nothing outlives the fiber (HMR safety) — a TERM-trapping child is
      // held until the SIGKILL escalation lands. The base class already
      // silenced listeners, so these kills complete without notices.
      const pending: Promise<void>[] = []
      for (const task of this.tasks.values()) {
        if (task.status === 'running') {
          task.status = 'killed'
          task.running.kill()
          pending.push(task.done)
        }
      }
      this.tasks.clear()
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
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      ...request.signal ? { signal: request.signal } : {},
      // Carry stdin/env through verbatim — optional, no config default (absent
      // means none). env merges AFTER the scrub in run.ts.
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      // Carry the owner through verbatim (required-but-nullable on the spec):
      // the executor never interprets it — the consumer's access policy does.
      owner: request.owner,
    }
  }

  async run(spec: BashExecSpec): Promise<BashRunResult> {
    // One fused deadline drives both the timeout and upstream cancellation;
    // runBash listens on d.signal and runs the SIGTERM→grace→SIGKILL kill.
    // `using` clears the timer across the awaited process lifetime.
    using d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
    const outcome = await runBash({
      command: spec.command,
      cwd: spec.workdir,
      maxOutputBytes: this.config.maxOutputBytes,
      graceMs: this.config.graceMs,
      signal: d.signal,
      stdin: spec.stdin,
      env: spec.env,
    }, this.internals).done
    // Classify the FIRST abort reason: a BASH_TIMEOUT TimeoutReason means our
    // timeout cut the command short; any other abort — an upstream cancel, or a
    // foreign (outer) deadline's timeout under nesting — is aborted. Scoping to
    // our own code keeps a nested outer deadline from reading as our timeout.
    // Mutually exclusive by construction — the fused signal reports one cause.
    const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
    const aborted = d.signal.aborted && !timedOut
    return { ...outcome, timedOut, aborted, timeoutMs: spec.timeoutMs }
  }

  start(spec: BashExecSpec): BashTask {
    // No timeout for background tasks (matches Claude Code, which detaches
    // the timeout when backgrounding); callers stop tasks via kill() — or
    // via spec.signal, which the seam contract honors for background runs
    // too (runBash wires it to the group kill). No deadline is created here,
    // so spec.timeoutMs is ignored by design — background tasks stay
    // timeout-free (see the timeout-library RFC).
    const running = runBash({
      command: spec.command,
      cwd: spec.workdir,
      maxOutputBytes: this.config.maxOutputBytes,
      graceMs: this.config.graceMs,
      signal: spec.signal,
      stdin: spec.stdin,
      env: spec.env,
    }, this.internals)

    const id = BashTaskId(`bash-${this.nextTaskId++}`)
    const task: TrackedTask = {
      id,
      command: spec.command,
      status: 'running',
      exitCode: null,
      signal: null,
      owner: spec.owner,
      running,
      stdoutOffset: 0,
      stderrOffset: 0,
      done: running.done.then((outcome) => {
        // Abort-killed tasks report as killed, not completed. Background runs
        // forward only the upstream signal (no timeout), so its aborted state
        // is the authoritative "was this cancelled" signal.
        if (task.status === 'running') task.status = spec.signal?.aborted === true ? 'killed' : 'completed'
        task.exitCode = outcome.exitCode
        task.signal = outcome.signal
        this.notifyTaskDone(task)
      }, (error: unknown) => {
        // Spawn-level failure (bad workdir, …): the task never ran. String()
        // suffices — runBash only rejects with Error instances.
        task.status = 'killed'
        task.running.stderr.push(Buffer.from(`spawn failed: ${String(error)}`))
        this.notifyTaskDone(task)
      }),
    }
    this.tasks.set(id, task)
    return task
  }

  get(id: BashTaskId): BashTask | undefined {
    return this.tasks.get(id)
  }

  ownerOf(id: BashTaskId): OwnerToken | undefined {
    // Unknown id and known-but-ownerless both read as undefined — the consumer
    // treats undefined as "open" and a truly unknown id fails at readOutput/kill.
    return this.tasks.get(id)?.owner
  }

  list(): BashTask[] {
    return [...this.tasks.values()]
  }

  readOutput(id: BashTaskId): BashTaskRead {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`unknown bash task "${id}"`)

    const out = task.running.stdout.readFrom(task.stdoutOffset)
    const err = task.running.stderr.readFrom(task.stderrOffset)
    task.stdoutOffset = out.nextOffset
    task.stderrOffset = err.nextOffset

    // Single newline between sections: stdout chunks usually end with one
    // already; add it only when missing.
    const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
    const delta = out.text
      + (err.text.length > 0 ? `${separator}[stderr]\n${err.text}` : '')
    return {
      task,
      delta,
      lossy: out.lossy || err.lossy,
      ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
      ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
    }
  }

  kill(id: BashTaskId): boolean {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`unknown bash task "${id}"`)
    if (task.status !== 'running') return false
    task.status = 'killed'
    task.running.kill()
    return true
  }
}

export default LocalBashExecutor
