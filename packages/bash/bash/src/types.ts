/**
 * Execution vocabulary for the bash executor seam. Types only — the abstract
 * service lives in `./index.ts`, implementations in sibling packages
 * (`@deepseek-ai/dsh-bash-local` first).
 *
 * Background TASK semantics (ids, ownership, polling protocol, completion
 * listeners) deliberately do NOT live here: the seam starts a background
 * PROCESS and returns a {@link BashProcess} handle; the caller (the tool
 * layer) registers that handle with the generic `ctx.tasks` runtime
 * (`@deepseek-ai/dsh-tasks`), which owns everything task-shaped.
 *
 * @module dsh-bash/types
 */

import type { SandboxEnforcement, SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * Sandbox facts for one run, present iff a sandboxing executor handled it.
 * Facts are reported independently of process exit status so callers can
 * distinguish command failures from policy denials and runner failures.
 */
export interface BashSandboxInfo {
  /** The mode the command actually ran under. */
  mode: SandboxMode
  /** Whether the sandbox denied a file operation. */
  denied: boolean
  /** How completely the selected runner enforced the requested mode. */
  enforcement?: SandboxEnforcement
  /** Whether the sandbox runner failed before the command could run. */
  runnerFailed?: boolean
}

/**
 * A caller's execution REQUEST: `workdir` and `timeoutMs` are optional and
 * filled by {@link BashExecutor.resolve} from the implementation's config.
 * This is the model-/plugin-facing shape; pass it to `resolve()` to obtain a
 * fully-resolved {@link BashExecSpec}.
 */
export interface BashExecRequest {
  command: string
  /** Working directory override (default: implementation-configured). */
  workdir?: string | undefined
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number | undefined
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /**
   * Bytes to write to the command's stdin, then close it. Absent leaves stdin
   * closed/empty (the default for model-driven tool calls). Set by in-process
   * plugins (e.g. the hooks bridges, which write a hook command's JSON payload
   * to its stdin); the model-facing bash tool does not expose it as a parameter
   * (a model that needs stdin uses shell syntax like a heredoc or a pipe).
   */
  stdin?: string | undefined
  /**
   * Extra environment entries for the command, merged AFTER the
   * implementation's credential scrub (so an explicit entry here is honored even
   * when its name matches the scrub pattern — the caller named a value it holds,
   * not the harness's ambient secret). Set by in-process plugins (the hooks
   * bridges set `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, …); the model-facing
   * bash tool does not expose it as a parameter (a model that needs an env var
   * uses shell syntax like `FOO=bar cmd`).
   */
  env?: Record<string, string> | undefined
  /** Explicit per-call sandbox mode override. */
  sandboxMode?: SandboxMode | undefined
}

/**
 * A fully-resolved execution SPEC — exactly what {@link BashExecutor.run} /
 * {@link BashExecutor.start} act on. `workdir` and `timeoutMs` are REQUIRED:
 * defaulting and capping already happened in {@link BashExecutor.resolve}, so
 * the executor never hides a `?? config` fallback (explicit > implicit). For
 * background processes, `start()` ignores `timeoutMs` (background runs have no
 * timeout) — the field is still required because the type is shared.
 */
export interface BashExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /**
   * Bytes to write to the command's stdin (then close it), carried through
   * verbatim from {@link BashExecRequest.stdin}. OPTIONAL on the resolved spec:
   * it has no config default, so a missing one means "no stdin" — the safe,
   * ordinary case — not a silent footgun, so it stays a plain optional rather
   * than required-but-nullable (see the request field).
   */
  stdin?: string | undefined
  /**
   * Extra environment entries, carried through verbatim from
   * {@link BashExecRequest.env} and merged by the implementation AFTER its
   * credential scrub (an explicit entry wins even when its name matches the
   * scrub pattern). OPTIONAL on the spec for the same reason as `stdin` — no
   * config default, absent means "no extra env".
   */
  env?: Record<string, string> | undefined
  /** Resolved sandbox mode; ignored by executors that do not confine. */
  sandboxMode: SandboxMode | undefined
}

/** One captured stream: the (possibly truncated) text plus recovery info. */
export interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}

/** The outcome of one completed (or killed) foreground run. */
export interface BashRunResult {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
  /** True when the executor's own timeout killed the command. */
  timedOut: boolean
  /** True when the caller's AbortSignal killed the command. */
  aborted: boolean
  /** The effective timeout applied to this run (after defaulting/capping). */
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
  /** Sandbox execution facts, absent for an unsandboxed executor. */
  sandbox?: BashSandboxInfo
}

/** Lifecycle of a background process. */
export type BashProcessStatus = 'running' | 'completed' | 'killed'

/** One incremental {@link BashProcess.readOutput} read. */
export interface BashProcessRead {
  /** Output produced since the previous read (stderr in a marked section). */
  delta: string
  /** True when truncation dropped unread bytes the delta cannot include. */
  lossy: boolean
  /** Full stdout spill file, when stdout truncation occurred and a safe path is available. */
  stdoutSpillPath?: string
  /** Full stderr spill file, when stderr truncation occurred and a safe path is available. */
  stderrSpillPath?: string
}

/**
 * A live background process handle, returned by {@link BashExecutor.start}.
 * The HANDLE is the only access path (no executor-level id lookup): the
 * caller holds it, adapts it into a `ctx.tasks` registration, or drops it.
 * Reads stay valid after the process exits (the remaining buffered output is
 * still consumable); the executor's own disposal kills every running process
 * and awaits {@link done}.
 */
export interface BashProcess {
  /** The command line this process runs. */
  readonly command: string
  /** Process lifecycle state (settled exactly once). */
  status: BashProcessStatus
  /** Exit code once finished (null = killed by signal / still running). */
  exitCode: number | null
  /** Terminating signal name, when signal-killed. */
  signal: NodeJS.Signals | null
  /** Resolves when the underlying process closes (never rejects — a spawn failure settles as `killed` with the error on stderr). */
  readonly done: Promise<void>
  /** Sandbox facts, stamped once a confined process settles. */
  sandbox?: BashSandboxInfo
  /**
   * Read output produced since the previous read (consuming — consecutive
   * reads never re-deliver). Reads that lost data flag `lossy` and point at
   * full-stream spill files when available.
   */
  readOutput(): BashProcessRead
  /**
   * Kill the process group. Returns false when it had already finished
   * (no-op); idempotent.
   */
  kill(): boolean
}
