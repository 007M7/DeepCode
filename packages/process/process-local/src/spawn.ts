/**
 * Process plumbing for the local process manager: detached process-group
 * spawn, tail-keep output with spill files, and SIGTERM→SIGKILL escalation.
 * This layer reacts to an abort signal; callers own deadlines and classify
 * causes.
 * @module dsh-process-local/spawn
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-process'
import type { CollectedOutput, DshEnvironment, ProcessHandle, ProcessOutcome, ProcessSpawnSpec } from '@deepseek-ai/dsh-process'

/**
 * Credential-shaped env vars are NOT forwarded to children (the harness's
 * own DEEPSEEK_API_KEY must not leak into `env` output, tool results, or
 * spill files). Same default pattern as Codex's env policy; a future config
 * can whitelist specific vars when a workflow genuinely needs one.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|SECRET|TOKEN/i

/**
 * Build a child environment from scrubbed ambient values, ordinary caller
 * entries, and a managed `DSH_*` snapshot. Ambient managed names are removed;
 * ordinary and managed entries reject the other channel's namespace before
 * `dshEnv` merges last.
 * @param extra - caller entries; `DSH_*` names are rejected.
 * @param dshEnv - managed entries; non-`DSH_*` names are rejected.
 * @returns the environment to hand to `spawn` for the child process.
 */
export function childEnv(
  extra?: Readonly<Record<string, string>>,
  dshEnv?: DshEnvironment,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_PATTERN.test(key) && !key.startsWith(DSH_ENV_PREFIX)) env[key] = value
  }
  for (const key of Object.keys(extra ?? {})) {
    if (key.startsWith(DSH_ENV_PREFIX)) {
      throw new Error(`ordinary child env cannot set reserved variable "${key}"; use dshEnv`)
    }
  }
  for (const key of Object.keys(dshEnv ?? {})) {
    if (!key.startsWith(DSH_ENV_PREFIX)) {
      throw new Error(`managed child env cannot set ordinary variable "${key}"; use env`)
    }
  }
  return { ...env, ...extra, ...dshEnv }
}

/** Injectable knobs so tests can exercise spill behavior without the OS tmpdir. */
export interface SpawnInternals {
  /** Directory for spill files (defaults to the OS temp dir). */
  spillDir?: string
}

let spillCounter = 0
let defaultSpillDir: string | undefined

/**
 * The default spill location: a private (0700) per-process directory under
 * the OS tmpdir, created lazily. Predictable world-readable paths would let
 * other local users read command output or pre-create symlinks.
 */
function privateSpillDir(): string {
  defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'dsh-proc-'))
  return defaultSpillDir
}

/**
 * Collects one stream with a bounded in-memory tail. On first overflow a
 * spill file is created and every chunk (including those already collected)
 * is appended there while the full stream remains within `maxSpillBytes`.
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
  private spillDisabled = false
  /** Total bytes ever pushed (not just retained). */
  private total = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number,
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
    if (!this.spillDisabled && (overflows || this.spillFd !== undefined)) this.spillAll(chunk)
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
    if (this.total > this.maxSpillBytes) {
      this.discardSpill()
      return
    }
    if (this.spillFd === undefined) {
      // Random suffix + O_EXCL + no-follow-equivalent ('wx' fails on any
      // existing path, symlink or not) + owner-only mode: defeats spill-path
      // prediction and symlink planting in shared tmp dirs.
      this.spillFile = join(
        this.spillDir,
        `dsh-proc-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
      )
      this.spillFd = openSync(this.spillFile, 'wx', 0o600)
      for (const prior of this.chunks) writeSync(this.spillFd, prior)
    }
    writeSync(this.spillFd, chunk)
  }

  /** Stop spilling and remove the file once it can no longer hold the complete stream. */
  private discardSpill(): void {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Retain the descriptor so finalize can retry the failed close.
        this.spillFd = fd
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // A failed unlink leaves at most maxSpillBytes behind, never an unbounded file.
      }
    }
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
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
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
 * Spawn one isolated detached process group and collect its output.
 * Runtime exits resolve as {@link ProcessOutcome}; only spawn failures reject.
 * @param spec - fully resolved argv, cwd, limits, and cancellation.
 * @param internals - test-only spill-directory override.
 * @returns live process handle and outcome promise.
 */
export function spawnProcess(spec: ProcessSpawnSpec, internals: SpawnInternals = {}): ProcessHandle {
  const spillDir = internals.spillDir ?? privateSpillDir()

  if (spec.signal?.aborted) {
    throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
  }
  const [program, ...args] = spec.argv
  if (program === undefined || program.length === 0) {
    throw new Error('invalid argv: expected a non-empty program name at argv[0]')
  }

  // Keep absent stdin as /dev/null; literal tuples preserve non-null output types.
  const env = childEnv(spec.env, spec.dshEnv)
  const child: ChildProcessByStdio<Writable | null, Readable, Readable> = spec.stdin !== undefined
    ? spawn(program, args, { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    : spawn(program, args, { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })

  const stdout = new OutputCollector(spec.stdoutMaxBytes, spec.maxSpillBytes, 'stdout', spillDir)
  const stderr = new OutputCollector(spec.stderrMaxBytes, spec.maxSpillBytes, 'stderr', spillDir)
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

  // The caller owns timeout classification; this layer only reacts to abort.
  const onAbort = (): void => { kill() }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  // Stdin writes are best-effort; process exit and captured output remain authoritative.
  if (child.stdin !== null) {
    child.stdin.on('error', () => { /* stdin write is best-effort; outcome rides on exit/output. */ })
    child.stdin.end(spec.stdin)
  }

  const done = new Promise<ProcessOutcome>((resolve, reject) => {
    let settled = false
    let pipeDrainTimer: NodeJS.Timeout | undefined
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      child.stdout.destroy()
      child.stderr.destroy()
      cleanup()
      resolve({
        exitCode,
        signal,
        stdout: stdout.finalize(),
        stderr: stderr.finalize(),
      })
    }
    child.on('error', (error) => {
      // No meaningful close outcome follows a spawn failure.
      settled = true
      cleanup()
      reject(error)
    })
    child.on('exit', (exitCode, signal) => {
      pipeDrainTimer = setTimeout(() => { settle(exitCode, signal) }, spec.graceMs)
    })
    child.on('close', settle)
    function cleanup(): void {
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      if (pipeDrainTimer !== undefined) clearTimeout(pipeDrainTimer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  })

  return { pid, stdout, stderr, done, kill }
}
