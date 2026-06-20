# Bash Executor

The bash execution seam — the canonical [capability seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md) example, split across three packages: interface ([dsh-bash](../../packages/bash), `ctx.bash`), implementation ([dsh-bash-local](../../packages/bash-local), local subprocesses), and consumer ([dsh-tool-bash](../../packages/tool-bash), the `bash`/`bash_output`/`bash_kill` tool schemas). Bash is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A sandboxed, containerized, or remote backend is a sibling package implementing the same interface.

Source: [`packages/bash/src/types.ts`](../../packages/bash/src/types.ts)

## Request vs. spec: the `resolve()` split

The seam separates the **model-/plugin-facing request** (optional `workdir`/`timeoutMs`, filled from config) from the **fully-resolved spec** the executor acts on (those fields required). The tool layer calls `ctx.bash.resolve(request)` between them — this is the repo's "explicit > implicit at package seams" rule made concrete: the reader of a `BashExecSpec` never wonders where the working directory came from.

```ts type-equiv
interface BashExecRequest {
  command: string
  /** Working directory override (default: implementation-configured). */
  workdir?: string | undefined
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number | undefined
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /**
   * Opaque OWNER token for a background task — the consumer's isolation key
   * (the tool layer passes the owning agent's `session.header.id`). The
   * executor stores it on the task and exposes it via {@link BashExecutor.ownerOf};
   * the executor itself NEVER interprets it (no access policy lives in the
   * seam — that is the consumer's job). Absent for foreground runs and for an
   * ownerless background start (a non-agent caller).
   */
  owner?: string | undefined
}
```

```ts type-equiv
interface BashExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /**
   * Opaque owner token, REQUIRED-but-nullable (mirrors `workdir`/`timeoutMs`
   * being required on the resolved spec): {@link BashExecutor.resolve} carries
   * the request's `owner` through, defaulting a missing one to `undefined`. A
   * required field makes a forgotten owner a VISIBLE `undefined` rather than a
   * silently-absent property that yields an unowned (cross-session-readable)
   * task. `start()` stores it; `run()` (foreground) ignores it.
   */
  owner: string | undefined
}
```

The `owner` token is the isolation key: the executor stores it but never interprets it (access policy is the consumer's job), so a background task started by one agent isn't readable cross-session. A required-but-nullable field makes a forgotten owner a visible `undefined` rather than a silently-unowned task.

## Foreground runs: `BashRunResult`

The outcome of one completed (or killed) foreground run. Orthogonal outcomes are reported **independently** — a process can both time out AND exit 0 because it trapped the signal — so `timedOut`, `aborted`, `signal`, and `exitCode` are each their own field; a caller never reads a cut-short run as a clean success.

```ts type-equiv
interface BashRunResult {
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
```

Each stream is a `CollectedOutput` — the (possibly truncated) text plus recovery info. When truncated, `text` is the **tail** and the complete stream spills to a private file:

```ts type-equiv
interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}
```

## Background tasks: `BashTask`

A long-running command started with `start()` is tracked as a `BashTask`. `BashTaskStatus` is `'running' | 'completed' | 'killed'`; `done` resolves when the underlying process closes and never rejects.

```ts type-equiv
interface BashTask {
  readonly id: string
  readonly command: string
  status: BashTaskStatus
  /** Exit code once finished (null = killed by signal / still running). */
  exitCode: number | null
  /** Terminating signal name, when signal-killed. */
  signal: NodeJS.Signals | null
  /** Resolves when the underlying process closes (never rejects). */
  readonly done: Promise<void>
}
```

`readOutput()` returns an incremental `BashTaskRead` — the output produced since the previous read, with a `lossy` flag when truncation dropped unread bytes:

```ts type-equiv
interface BashTaskRead {
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
```

## The service

`BashExecutor` (`ctx.bash`, abstract — defined in [`packages/bash/src/index.ts`](../../packages/bash/src/index.ts)) mirrors the `LlmService`/`LlmAdapter` split: `resolve` (request → spec), `run` (foreground), `start` (background), `get`/`ownerOf`/`list`/`readOutput`/`kill`, and `onTaskDone` (a `BashTaskListener` completion callback). Spawned commands get a **scrubbed env** (dropping `*KEY*`/`*SECRET*`/`*TOKEN*`) and spill files use a private 0700 dir with random names and owner-only opens — model output never gets the ambient environment or a predictable path. The implementation that provides all this is `dsh-bash-local`; the model-facing `bash`/`bash_output`/`bash_kill` schemas that call it are in `dsh-tool-bash` (and present as terminals via the [tool-presentation vocabulary](tools.md#tool-presentation-ui-vocabulary)).
