/**
 * Process plumbing for the local bash executor: detached process-group spawn,
 * tail-keep output with spill files, and SIGTERM→SIGKILL escalation. This layer
 * reacts to an abort signal; the executor owns deadlines and classifies causes.
 * @module dsh-bash-local/run
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CollectedOutput } from '@deepseek-ai/dsh-bash'

/**
 * Model-friendly environment overrides: disable colors, pagers, and
 * interactive terminal features that would garble tool output (the same set
 * Codex hardcodes; Claude Code achieves it via TERM=dumb).
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/**
 * Credential-shaped env vars are NOT forwarded to commands (the harness's
 * own DEEPSEEK_API_KEY must not leak into `env` output, tool results, or
 * spill files). Same default pattern as Codex's env policy; a future config
 * can whitelist specific vars when a workflow genuinely needs one.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|SECRET|TOKEN/i

/**
 * Build a child environment by scrubbing credential-shaped ambient variables,
 * applying model-friendly overrides, then merging trusted caller entries last.
 *
 * @param extra - caller-supplied entries merged last; an explicit entry wins even against the scrub and the overrides.
 * @returns the environment to hand to `spawn` for the child process.
 */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_PATTERN.test(key)) env[key] = value
  }
  return { ...env, ...ENV_OVERRIDES, ...extra }
}

/** What to run and under which limits (resolved — no defaults in here). */
export interface SpawnSpec {
  command: string
  cwd: string
  /** Per-stream in-memory cap; overflow spills to disk (tail kept in memory). */
  maxOutputBytes: number
  /** Grace period between the SIGTERM and the SIGKILL escalation on a kill. */
  graceMs: number
  /**
   * Abort signal — kills the process group when it fires. The executor owns
   * timing: `run()` passes a fused timeout/cancel deadline signal (see
   * `@deepseek-ai/dsh-timeout`), `start()` passes the bare upstream signal.
   * runBash only listens and kills; it does NOT classify why (the executor
   * reads the signal's reason afterward).
   */
  signal?: AbortSignal | undefined
  /**
   * Bytes to write to the child's stdin, then close it. Absent (or empty)
   * leaves stdin closed/empty. Set by in-process plugins (the hooks bridges);
   * the model-facing `dsh-tool-bash` tool does not thread model input here.
   */
  stdin?: string | undefined
  /**
   * Extra environment entries, merged onto the scrubbed env AFTER the
   * credential scrub and the model-friendly overrides (so an explicit entry
   * wins). Set by in-process plugins; the model-facing tool does not forward
   * model input here.
   */
  env?: Record<string, string> | undefined
}

/**
 * Raw outcome of one closed process (before result shaping). Deliberately
 * carries NO timeout/cancel classification: runBash kills on abort but does not
 * decide why — the executor's `run()`/`start()` reads the deadline signal it
 * owns to classify `timedOut`/`aborted` (see the package README).
 */
export interface SpawnOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: CollectedOutput
  stderr: CollectedOutput
}

/** Injectable knobs so tests can exercise spill behavior without the OS tmpdir. */
export interface RunInternals {
  /** Directory for spill files (defaults to the OS temp dir). */
  spillDir?: string
}

/** Default SIGTERM→SIGKILL grace period (the `graceMs` config; matches OpenCode's 3s). */
export const DEFAULT_GRACE_MS = 3_000

let spillCounter = 0
let defaultSpillDir: string | undefined

/**
 * The default spill location: a private (0700) per-process directory under
 * the OS tmpdir, created lazily. Predictable world-readable paths would let
 * other local users read command output or pre-create symlinks.
 */
function privateSpillDir(): string {
  defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'dsh-bash-'))
  return defaultSpillDir
}

/**
 * Collects one stream with a bounded in-memory tail. The FULL stream is
 * always recoverable: on first overflow a spill file is created and every
 * chunk (including those already collected) is appended there.
 *
 * Tail-keep rationale (pi/OpenCode): errors and final results cluster at the
 * end of command output; the spill file covers the head.
 */
export class OutputCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private dropped = false
  private spillFd: number | undefined
  private spillFile: string | undefined
  /** Total bytes ever pushed (not just retained). */
  private total = 0

  constructor(
    private readonly maxBytes: number,
    private readonly label: string,
    private readonly spillDir: string,
  ) {}

  /**
   * Ingest one stream chunk, counting it toward the whole-stream total. On
   * first overflow of the in-memory cap a spill file is opened and every chunk
   * (already-collected ones included) is appended there from then on; the
   * in-memory tail then drops whole chunks from its head (or the head of a
   * single over-cap chunk) until it fits the cap again.
   * @param chunk - the raw bytes from one stream 'data' event.
   */
  push(chunk: Buffer): void {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    if (overflows || this.spillFd !== undefined) this.spillAll(chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      // Drop whole chunks from the head; pipe chunks are small (≤64KiB), so
      // the retained tail tracks the cap closely enough for a model-facing
      // truncation boundary. (length > 1 was just checked — shift() returns.)
      const head = this.chunks.shift() as Buffer
      this.bytes -= head.length
      this.dropped = true
    }
    if (this.bytes > this.maxBytes && this.chunks.length === 1) {
      // A single chunk larger than the cap: keep its tail.
      const only = this.chunks[0] as Buffer
      this.chunks[0] = only.subarray(only.length - this.maxBytes)
      this.bytes = this.maxBytes
      this.dropped = true
    }
  }

  /** Open the spill file lazily and append `chunk` (and any prior chunks once). */
  private spillAll(chunk: Buffer): void {
    if (this.spillFd === undefined) {
      // Random suffix + O_EXCL + no-follow-equivalent ('wx' fails on any
      // existing path, symlink or not) + owner-only mode: defeats spill-path
      // prediction and symlink planting in shared tmp dirs.
      this.spillFile = join(
        this.spillDir,
        `dsh-bash-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
      )
      this.spillFd = openSync(this.spillFile, 'wx', 0o600)
      for (const prior of this.chunks) writeSync(this.spillFd, prior)
    }
    writeSync(this.spillFd, chunk)
  }

  // TODO(snapshot-scope): `snapshot()` has one internal caller (`finalize()` at
  // the bottom of this file) and `totalBytes` is read only by a test. The live
  // background-poll path goes through `readFrom()`, so inline snapshot() into
  // finalize() and drop or privatize the totalBytes getter.
  /**
   * Read the collected tail without finalizing (the final-result snapshot).
   * @returns the retained tail text, the truncation flag, and the spill path when one was created.
   */
  snapshot(): CollectedOutput {
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }

  /** Total bytes ever pushed (including bytes dropped from memory). */
  get totalBytes(): number {
    return this.total
  }

  /**
   * Incremental read in whole-stream byte coordinates: returns everything
   * pushed since `fromByte`. When `fromByte` has already slid out of the
   * in-memory tail window, the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the offset for the next read, the `lossy` flag, and the spill path when one was created.
   */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }

  /**
   * Close the spill file (if any) and return the final output. A failed close
   * (delayed writeback fault) stops advertising the spill path — the file may
   * be missing its tail — but still returns the in-memory result.
   * @returns the final collected output: tail text, truncation flag, and the spill path when intact.
   */
  finalize(): CollectedOutput {
    if (this.spillFd !== undefined) {
      try {
        closeSync(this.spillFd)
      } catch {
        // A delayed writeback failure makes the spill unreliable; keep finalize
        // total but stop advertising that file.
        this.spillFile = undefined
      }
      this.spillFd = undefined
    }
    return this.snapshot()
  }
}

/**
 * Send `sig` to a detached process group. Never throws: delivery races process
 * exit and may run in a timer callback, so failures are contained and a
 * non-positive pid is a no-op.
 * @param pid - the group leader's pid; non-positive means the spawn failed and the call is a no-op.
 * @param sig - the signal to deliver to the whole group.
 */
export function killGroup(pid: number, sig: NodeJS.Signals): void {
  if (pid <= 0) return
  try {
    process.kill(-pid, sig)
  } catch {
    // Swallow: see contract above.
  }
}

/**
 * A live bash child process: the promise resolves when the process closes;
 * `kill()` starts the SIGTERM→grace→SIGKILL escalation on its group.
 */
export interface RunningBash {
  /** Process id (group leader); -1 when the spawn itself failed. */
  readonly pid: number
  /** stdout/stderr collectors (live — background polling reads incrementally). */
  readonly stdout: OutputCollector
  readonly stderr: OutputCollector
  /** Resolves when the process closes; rejects only for spawn-level failures. */
  readonly done: Promise<SpawnOutcome>
  /** Begin SIGTERM→grace→SIGKILL on the process group. Idempotent. */
  kill(): void
}

/**
 * Spawn one isolated `bash -c` process group and collect its output.
 * Runtime exits resolve as {@link SpawnOutcome}; only spawn failures reject.
 * @param spec - fully resolved command, cwd, limits, and cancellation.
 * @param internals - test-only process and spill-directory overrides.
 * @returns live process handle and outcome promise.
 */
// XXX(stateful-shell): evaluate persistent cwd or PTY sessions when workflows require shell state.
export function runBash(spec: SpawnSpec, internals: RunInternals = {}): RunningBash {
  const spillDir = internals.spillDir ?? privateSpillDir()

  if (spec.signal?.aborted) {
    throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
  }

  // Keep absent stdin as /dev/null; literal tuples preserve non-null output types.
  const env = childEnv(spec.env)
  const child: ChildProcessByStdio<Writable | null, Readable, Readable> = spec.stdin !== undefined
    ? spawn('bash', ['-c', spec.command], { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    : spawn('bash', ['-c', spec.command], { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })

  const stdout = new OutputCollector(spec.maxOutputBytes, 'stdout', spillDir)
  const stderr = new OutputCollector(spec.maxOutputBytes, 'stderr', spillDir)
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })

  let graceTimer: NodeJS.Timeout | undefined

  // Failed spawns use pid -1 so kill remains a no-op.
  const pid = child.pid ?? -1

  const kill = (): void => {
    if (graceTimer !== undefined) return // escalation already in flight
    killGroup(pid, 'SIGTERM')
    graceTimer = setTimeout(() => { killGroup(pid, 'SIGKILL') }, spec.graceMs)
  }

  // The executor owns timeout classification; this layer only reacts to abort.
  const onAbort = (): void => { kill() }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  // Stdin writes are best-effort; process exit and captured output remain authoritative.
  if (child.stdin !== null) {
    child.stdin.on('error', () => { /* stdin write is best-effort; outcome rides on exit/output. */ })
    child.stdin.end(spec.stdin)
  }

  const done = new Promise<SpawnOutcome>((resolve, reject) => {
    child.on('error', (error) => {
      // No meaningful close outcome follows a spawn failure.
      cleanup()
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      cleanup()
      resolve({
        exitCode,
        signal,
        stdout: stdout.finalize(),
        stderr: stderr.finalize(),
      })
    })
    function cleanup(): void {
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  })

  return { pid, stdout, stderr, done, kill }
}
