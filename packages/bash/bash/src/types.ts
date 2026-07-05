/**
 * Execution vocabulary for the bash executor seam. Types only — the abstract
 * service lives in `./index.ts`, implementations in sibling packages
 * (`@deepseek-ai/dsh-bash-local` first).
 *
 * @module dsh-bash/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one background task within an executor (generated `bash-N`). */
export type BashTaskId = Branded<'BashTaskId'>

/** Brand a string as a {@link BashTaskId}. */
export function BashTaskId(id: string): BashTaskId {
  return id as BashTaskId
}

/**
 * A background task's opaque isolation key — the CONSUMER's owner identity, not
 * the bash seam's. The executor stores and returns it verbatim and never
 * interprets it; the access policy lives in the consumer (`dsh-tool-bash`),
 * which is the single boundary that casts its own id vocabulary into one. A
 * DISTINCT brand (not a `SessionId` alias) keeps the seam decoupled — a
 * sandboxed/remote executor inherits no session dependency.
 */
export type OwnerToken = Branded<'OwnerToken'>

/** Brand a string as an {@link OwnerToken}. */
export function OwnerToken(id: string): OwnerToken {
  return id as OwnerToken
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
  /**
   * Opaque OWNER token for a background task — the consumer's isolation key
   * (the tool layer passes the owning agent's `session.header.id`). The
   * executor stores it on the task and exposes it via {@link BashExecutor.ownerOf};
   * the executor itself NEVER interprets it (no access policy lives in the
   * seam — that is the consumer's job). Absent for foreground runs and for an
   * ownerless background start (a non-agent caller).
   */
  owner?: OwnerToken | undefined
}

/**
 * A fully-resolved execution SPEC — exactly what {@link BashExecutor.run} /
 * {@link BashExecutor.start} act on. `workdir` and `timeoutMs` are REQUIRED:
 * defaulting and capping already happened in {@link BashExecutor.resolve}, so
 * the executor never hides a `?? config` fallback (explicit > implicit). For
 * background tasks, `start()` ignores `timeoutMs` (background runs have no
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
   * verbatim from {@link BashExecRequest.stdin}. OPTIONAL on the resolved spec
   * (unlike `owner`): it has no config default, so a missing one means "no
   * stdin" — the safe, ordinary case — not a silent footgun, so it stays a
   * plain optional rather than required-but-nullable (see the request field).
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
  /**
   * Opaque owner token, REQUIRED-but-nullable (mirrors `workdir`/`timeoutMs`
   * being required on the resolved spec): {@link BashExecutor.resolve} carries
   * the request's `owner` through, defaulting a missing one to `undefined`. A
   * required field makes a forgotten owner a VISIBLE `undefined` rather than a
   * silently-absent property that yields an unowned (cross-session-readable)
   * task. `start()` stores it; `run()` (foreground) ignores it.
   */
  owner: OwnerToken | undefined
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
}

/** Lifecycle of a background task. */
export type BashTaskStatus = 'running' | 'completed' | 'killed'

/** A tracked background task handle. */
export interface BashTask {
  readonly id: BashTaskId
  readonly command: string
  status: BashTaskStatus
  /** Exit code once finished (null = killed by signal / still running). */
  exitCode: number | null
  /** Terminating signal name, when signal-killed. */
  signal: NodeJS.Signals | null
  /** Resolves when the underlying process closes (never rejects). */
  readonly done: Promise<void>
}

/** One incremental {@link BashExecutor.readOutput} read. */
export interface BashTaskRead {
  task: BashTask
  /** Output produced since the previous read (stderr in a marked section). */
  delta: string
  /** True when truncation dropped unread bytes the delta cannot include. */
  lossy: boolean
  /** Full stdout spill file, when stdout truncation occurred and a safe path is available. */
  stdoutSpillPath?: string
  /** Full stderr spill file, when stderr truncation occurred and a safe path is available. */
  stderrSpillPath?: string
}

/** Completion callback for background tasks. */
export type BashTaskListener = (task: BashTask) => void
