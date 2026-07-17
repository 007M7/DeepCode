/**
 * Execution types for the bash executor seam. Background task semantics belong
 * to `@deepseek-ai/dsh-tasks`; this seam exposes only process handles.
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
  /**
   * Foreground stdout capture budget in bytes. Absent uses the executor's
   * default output cap. Trusted in-process consumers use this when they must
   * parse complete stdout up to their own bounded limit; the model-facing bash
   * tool does not expose it as a parameter.
   */
  stdoutMaxBytes?: number | undefined
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
 * A resolved execution spec. {@link BashExecutor.resolve} fills and caps the
 * required fields; {@link BashExecutor.start} ignores `timeoutMs` because
 * background processes have no executor timeout.
 */
export interface BashExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  /**
   * Resolved foreground stdout capture budget in bytes. `run()` uses it for
   * stdout; background tasks and stderr keep the executor's own output cap.
   */
  stdoutMaxBytes: number
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /** Bytes to write to stdin before closing it; absent means no stdin. */
  stdin?: string | undefined
  /**
   * Extra environment entries, merged after credential scrubbing so explicit
   * values win; absent means no extra entries.
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
  /**
   * True when the executor's own timeout was the FIRST cause to cut the command
   * short. Mutually exclusive with {@link aborted}: one fused deadline drives
   * both the timeout and the caller's cancellation, so a timeout and an abort
   * racing before process close report the single first-abort cause, not both
   * (see the [timeout-library RFC](../../../../docs/rfc/implemented/architecture/2026-07-06-timeout-deadline-library.md)).
   */
  timedOut: boolean
  /**
   * True when the caller's `AbortSignal` was the FIRST cause to kill the command
   * (and it was not the executor's own timeout). Mutually exclusive with
   * {@link timedOut} — see there for the first-cause classification.
   */
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
 * A background process handle returned by {@link BashExecutor.start}. It is the
 * only access path; buffered output remains readable after exit. Executor
 * disposal kills running processes and awaits {@link done}.
 */
export interface BashProcess {
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
