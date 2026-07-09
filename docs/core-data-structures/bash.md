# Bash Executor

The bash execution seam — the canonical [capability seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md) example, split across three packages: interface ([dsh-bash](../../packages/bash/bash), `ctx.bash`), implementation ([dsh-bash-local](../../packages/bash/bash-local), local subprocesses), and consumer ([dsh-tool-bash](../../packages/bash/tool-bash), the `bash` tool schema). Bash is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A sandboxed, containerized, or remote backend is a sibling package implementing the same interface.

Source: [`packages/bash/bash/src/types.ts`](../../packages/bash/bash/src/types.ts)

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
}
```

The seam is deliberately **task-free**: no task ids, no owner tokens, no polling protocol. Background-task semantics (ids, cross-session isolation, collect/stop tools, completion notices) live in the generic `ctx.tasks` runtime ([dsh-tasks](../../packages/tasks/tasks)); the tool layer adapts a `BashProcess` handle into a task registration, so a sandboxed or remote executor inherits no session or registry dependency.

`stdin` and `env` are set by in-process plugins (the hooks bridges, native plugins) to feed a hook command its JSON payload on stdin and its `CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT` env. The model-facing `dsh-tool-bash` tool does not expose them as parameters — its request is built from `command`/`workdir`/`timeoutMs`/`signal` only — because a model already has equivalent power through shell syntax (`FOO=bar cmd`, a heredoc), so duplicating them as tool params would be redundant. This is NOT a security boundary: the credential scrub in `dsh-bash-local` is what stops the harness's ambient secrets reaching a spawned command, and it works regardless of these fields (a model cannot read a value the scrub removed, and tool-call args are static JSON, never shell-evaluated). A guard test asserts the tool doesn't forward model `env`/`stdin` — to catch a future `...args` spread, not to defend a trust wall. `env` is merged AFTER the scrub so an explicit caller entry (a value it already holds) wins even on a credential-shaped name. See [the bash-stdin-env RFC](../rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

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

## Background processes: `BashProcess`

A long-running command started with `start()` returns a `BashProcess` **handle** — the only access path (no executor-level id lookup). `BashProcessStatus` is `'running' | 'completed' | 'killed'`; `done` resolves when the underlying process closes and never rejects (a spawn failure settles as `killed` with the error readable on stderr). Reads stay valid after exit: the remaining buffered output is still consumable through the handle.

```ts type-equiv
interface BashProcess {
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
```

`readOutput()` returns an incremental `BashProcessRead` — the output produced since the previous read, with a `lossy` flag when truncation dropped unread bytes:

```ts type-equiv
interface BashProcessRead {
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

`BashExecutor` (`ctx.bash`, abstract — defined in [`packages/bash/bash/src/index.ts`](../../packages/bash/bash/src/index.ts)) mirrors the `LlmService`/`LlmAdapter` split and is exactly three methods: `resolve` (request → spec), `run` (foreground), `start` (background, returning the `BashProcess` handle). Spawned commands get a **scrubbed env** (dropping `*KEY*`/`*SECRET*`/`*TOKEN*`) and spill files use a private 0700 dir with random names and owner-only opens — model output never gets the ambient environment or a predictable path. The implementation that provides all this is `dsh-bash-local`; the model-facing `bash` schema that calls it is in `dsh-tool-bash` (background runs register with [`ctx.tasks`](../../packages/tasks/README.md) and are collected via the generic `task_output`/`task_kill`), presenting as terminals via the [tool-presentation vocabulary](tools.md#tool-presentation-ui-vocabulary).
