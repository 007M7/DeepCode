/**
 * Process plumbing for the local bash executor: spawn, output collection
 * with tail-keep + spill-to-disk truncation, and process-group kill with
 * SIGTERM→SIGKILL escalation.
 *
 * Everything here is deliberately free of Cordis concepts so it can be unit
 * tested in isolation; `LocalBashExecutor` owns lifecycle and configuration.
 *
 * Design notes (surveyed against Claude Code, OpenCode, Codex, and pi — see
 * the package README): spawn-per-call with `detached: true` so the child
 * leads its own process group; kills target the group (`kill(-pid)`) so
 * pipelines and subshells die with the parent. SIGTERM first, SIGKILL after a
 * grace period (OpenCode's escalation; Codex/pi jump straight to SIGKILL).
 *
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
 * `process.env` minus credential-shaped vars, plus the model-friendly
 * overrides, plus any caller-supplied `extra` entries.
 *
 * Layering matters: the scrub drops `process.env` credentials, then
 * `ENV_OVERRIDES` forces the model-friendly terminal vars, then `extra` is
 * merged LAST so an explicit caller entry wins even when its name matches the
 * scrub pattern (the scrub is the control that stops the HARNESS's ambient
 * credentials leaking into a spawned command; a caller that explicitly sets a
 * var named a value it already holds, not that ambient secret). `extra` is set
 * by in-process plugins (the hooks bridges), not the model — `dsh-tool-bash`
 * builds its request from named fields only and does not forward model input
 * here (see its README, § "The tool builds its request from named args only").
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
  /** Kill the process group after this many milliseconds. 0 = no timeout. */
  timeoutMs: number
  /** Per-stream in-memory cap; overflow spills to disk (tail kept in memory). */
  maxOutputBytes: number
  /** Abort signal — kills the process group when fired. */
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

/** Raw outcome of one closed process (before result shaping). */
export interface SpawnOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  stdout: CollectedOutput
  stderr: CollectedOutput
}

/** Injectable knobs so tests can exercise escalation/spill without long waits. */
export interface RunInternals {
  /** Grace period between SIGTERM and SIGKILL on the process group. */
  graceMs?: number
  /** Directory for spill files (defaults to the OS temp dir). */
  spillDir?: string
}

/** Default SIGTERM→SIGKILL grace period (matches OpenCode's 3s). */
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
  /** Read the collected tail without finalizing (the final-result snapshot). */
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

  /** Close the spill file (if any) and return the final output. */
  finalize(): CollectedOutput {
    if (this.spillFd !== undefined) {
      try {
        closeSync(this.spillFd)
      } catch {
        // close can surface delayed writeback failures (for example EIO/ENOSPC)
        // after writeSync appeared to succeed. Keep finalize total so runBash's
        // close handler still resolves, but stop advertising a spill file that
        // may be missing its tail.
        this.spillFile = undefined
      }
      this.spillFd = undefined
    }
    return this.snapshot()
  }
}

/**
 * Send `sig` to the process GROUP led by `pid` (requires the child to have
 * been spawned with `detached: true`). NEVER throws: kills race process exit
 * by design (ESRCH), and the other failure modes (EPERM from setuid
 * children, …) fire inside timer callbacks where a throw would crash the
 * host process — a kill that cannot be delivered is reported by the process
 * NOT dying, which callers already handle via escalation/timeouts. No-op for
 * non-positive pids (spawn never started a process).
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
 * Spawn `bash -c <command>` in its own process group and collect output.
 *
 * Outcome semantics: the returned promise REJECTS only for spawn-level
 * failures (bad cwd → ENOENT, missing binary, pre-aborted signal); every
 * runtime outcome — nonzero exit, timeout kill, abort kill, signal death —
 * RESOLVES with a {@link SpawnOutcome} describing what happened, so callers
 * shape one consistent report for the model.
 *
 * XXX(stateful-shell): per the agent-tool survey there are two proven
 * stateful designs worth revisiting — Claude Code persists ONLY cwd between
 * calls (captures `pwd -P` after each command), and Codex keeps whole PTY
 * exec sessions addressable via session ids + stdin writes. We deliberately
 * spawn a fresh non-login `bash -c` per call for determinism (no rc files,
 * no inherited shell state); revisit when real workflows demand it.
 */
export function runBash(spec: SpawnSpec, internals: RunInternals = {}): RunningBash {
  const graceMs = internals.graceMs ?? DEFAULT_GRACE_MS
  const spillDir = internals.spillDir ?? privateSpillDir()

  if (spec.signal?.aborted) {
    throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
  }

  // stdin is a pipe ONLY when the caller supplied bytes; with none it is `ignore`
  // (fd 0 → /dev/null) — the exact pre-seam default. This matters: a spawn pipe
  // and /dev/null are NOT observationally identical (node's pipe is an AF_UNIX
  // socket, so a command that probes stdin's type — `test -c /dev/stdin`, `stat
  // /proc/self/fd/0` — sees a char device vs a socket), so the no-stdin path
  // (every model-driven call) must keep /dev/null rather than regress to a socket.
  // Two LITERAL `stdio` tuples (not one variable tuple): only a literal lets the
  // typed `spawn` overload infer non-null stdout/stderr, which the
  // `ChildProcessByStdio` annotation captures (stdin `Writable | null`; stdout/
  // stderr the non-null `Readable` the collectors attach to without a cast).
  const env = childEnv(spec.env)
  const child: ChildProcessByStdio<Writable | null, Readable, Readable> = spec.stdin !== undefined
    ? spawn('bash', ['-c', spec.command], { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    : spawn('bash', ['-c', spec.command], { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })

  const stdout = new OutputCollector(spec.maxOutputBytes, 'stdout', spillDir)
  const stderr = new OutputCollector(spec.maxOutputBytes, 'stderr', spillDir)
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })

  let timedOut = false
  let aborted = false
  let killTimer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined

  // pid is undefined when the spawn itself fails (bad cwd, missing binary);
  // the 'error' handler rejects `done` and kills become no-ops via pid -1.
  const pid = child.pid ?? -1

  const kill = (): void => {
    if (graceTimer !== undefined) return // escalation already in flight
    killGroup(pid, 'SIGTERM')
    graceTimer = setTimeout(() => { killGroup(pid, 'SIGKILL') }, graceMs)
  }

  if (spec.timeoutMs > 0) {
    killTimer = setTimeout(() => {
      timedOut = true
      kill()
    }, spec.timeoutMs)
  }

  const onAbort = (): void => {
    aborted = true
    kill()
  }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  // Write stdin and close it, but ONLY when the caller supplied bytes — with no
  // stdin, fd 0 is `ignore` (/dev/null) and `child.stdin` is null. The error
  // handler must exist whenever we write: an unhandled 'error' on the stream
  // would throw and crash the host. We swallow the error rather than reject
  // `done`, and that is correct for ANY stdin-write error, not just the common
  // one — the stdin write is BEST-EFFORT, while the command's authoritative
  // outcome is its exit code + captured output, which the `close` handler reports
  // regardless of whether the write landed. The expected case is EPIPE (the child
  // exited without reading, so closing our end of a still-full pipe fails); a rare
  // non-EPIPE pipe fault means the command ran with incomplete stdin, and it
  // surfaces that itself through its own exit/output (e.g. a hook that gets
  // truncated JSON errors out) — rejecting here would instead discard that real
  // output and turn it into an opaque infrastructure error, which is worse.
  if (child.stdin !== null) {
    child.stdin.on('error', () => { /* stdin write is best-effort; outcome rides on exit/output. */ })
    child.stdin.end(spec.stdin)
  }

  const done = new Promise<SpawnOutcome>((resolve, reject) => {
    child.on('error', (error) => {
      // Spawn-level failure (ENOENT cwd, EACCES, …): no close event with
      // meaningful output follows; clean up and reject.
      cleanup()
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      cleanup()
      resolve({
        exitCode,
        signal,
        timedOut,
        aborted,
        stdout: stdout.finalize(),
        stderr: stderr.finalize(),
      })
    })
    function cleanup(): void {
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  })

  return { pid, stdout, stderr, done, kill }
}
