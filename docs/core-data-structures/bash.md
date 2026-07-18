# Bash Executor

The bash execution seam is split across interface ([dsh-bash](../../packages/bash/bash), `ctx.bash`), implementations ([dsh-bash-local](../../packages/bash/bash-local) and [dsh-bash-sandbox](../../packages/bash/bash-sandbox)), and consumer ([dsh-tool-bash](../../packages/bash/tool-bash), the `bash` schema). Generic background-task ids, ownership, and controls live in [tasks.md](tasks.md); this seam returns a task-free process handle.

Source: [`packages/bash/bash/src/types.ts`](../../packages/bash/bash/src/types.ts)

## Managed shell environment namespace

`DSH_*` variables are Harness-owned child-process facts. The model-facing bash tool collects them through `ctx.bashEnv` and passes them through `BashExecRequest.dshEnv`; executors remove inherited `DSH_*` names before merging the current snapshot.

```ts type-equiv
type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`
```

```ts type-equiv
type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>
```

## Request vs. spec: the `resolve()` split

The seam separates the **model-/plugin-facing request** (optional `workdir`/`timeoutMs`/`stdoutMaxBytes`, filled from config or request policy) from the **fully-resolved spec** the executor acts on (those fields required). The tool layer calls `ctx.bash.resolve(request)` between them — this is the repo's "explicit > implicit at package seams" rule made concrete: the reader of a `BashExecSpec` never wonders where the working directory or output budget came from.

```ts type-equiv
interface BashExecRequest {
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
   * Ordinary environment entries for the command, merged after the credential
   * scrub. `DSH_*` is reserved for {@link dshEnv} and implementations reject it
   * here. Set by in-process plugins (the hooks bridges set
   * `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, …); the model-facing bash tool
   * does not expose it as a parameter.
   */
  env?: Record<string, string> | undefined
  /**
   * Harness-owned `DSH_*` variables for this execution. Executors discard
   * ambient `DSH_*` entries before merging this snapshot, so an unavailable
   * current fact cannot inherit a stale value from the harness process, and
   * reject non-`DSH_*` names supplied through this managed channel.
   */
  dshEnv?: DshEnvironment | undefined
  /**
   * Explicit per-call sandbox-policy input, overriding the executor's
   * configured default mode for THIS call. Never a silent default: a
   * consumer sets it only from an explicit policy source — an
   * `'allowed-once'` grant a human just issued through `ctx.approval` (the
   * escalation flow in the sandbox RFC § Escalation, which outranks), or the
   * session's standing override folded from its own `bash/sandbox-mode`
   * events (the sandbox RFC § Per-session mode switching — the user's recorded per-session
   * choice). A sandboxing executor confines THIS call under the given mode;
   * a non-sandboxing executor carries the field and confines nothing (the
   * tool layer stamps neither escalation nor overrides without a sandboxing
   * executor — see {@link BashExecutor.sandboxMode}).
   */
  sandboxMode?: SandboxMode | undefined
}
```

```ts type-equiv
interface BashExecSpec {
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
  /**
   * Bytes to write to the command's stdin (then close it), carried through
   * verbatim from {@link BashExecRequest.stdin}. It has no config default, so
   * a missing value means "no stdin" and remains an ordinary optional.
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
  /** Managed `DSH_*` snapshot; implementations reject ordinary names. */
  dshEnv?: DshEnvironment | undefined
  /**
   * The sandbox mode this call executes under, required-but-nullable so every
   * resolved spec states its policy. A sandboxing executor's `resolve()` stamps
   * the effective mode (the request's explicit override, else its configured
   * default) so `run()`/`start()` read the spec, never the config;
   * a non-sandboxing executor carries the request value through verbatim and
   * ignores it (`undefined` under such an executor means what its README says:
   * unconfined execution).
   */
  sandboxMode: SandboxMode | undefined
}
```

`stdin` and `env` are trusted in-process plugin inputs and are not exposed by `dsh-tool-bash`. The local executor scrubs ambient credentials before merging explicit caller-supplied env. See [the bash-stdin-env RFC](../rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

`stdoutMaxBytes` is also trusted-plugin-only. It lets a foreground consumer request complete stdout up to a bounded parser budget without changing stderr, background tasks, or the model-facing bash tool's ordinary output cap.

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
  /**
   * Sandbox facts, present iff a sandboxing executor ran the command — an
   * unsandboxed executor (e.g. `dsh-bash-local`) never sets it. See
   * {@link BashSandboxInfo} for the `denied` classification semantics.
   */
  sandbox?: BashSandboxInfo
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

## File sandbox: `BashSandboxInfo`

A sandbox-consuming executor exposes its configured fallback through `BashExecutor.sandboxMode`. The tool layer folds each session's durable `bash/sandbox-mode` override and may replace it for one user-approved strictly wider call. The mode/enforcement vocabulary is owned by the [`@deepseek-ai/dsh-sandbox` seam](sandbox.md); modes govern file effects only.

A sandboxed run reports its mode, conservative denial classification, and enforcement completeness. `runnerFailed` marks a sandbox runner failure before the command ran; foreground execution throws `SANDBOX_UNAVAILABLE`, while a settled background process has only its facts channel.

```ts type-equiv
interface BashSandboxInfo {
  /** The mode the command actually ran under. */
  mode: SandboxMode
  /**
   * True when the executor classifies this run's failure as the sandbox
   * denying a file operation. The classification is CONSERVATIVE (a failed
   * exit whose stderr carries a filesystem-permission signature) and reads
   * the COLLECTED stderr — the bounded in-memory tail per
   * {@link CollectedOutput} semantics, so a signature that survives only in a
   * spill file is missed toward `denied: false`. A plain command failure
   * keeps `denied: false` even under a sandboxed mode.
   */
  denied: boolean
  /**
   * How completely the runner enforced `mode`'s file effects — see
   * {@link SandboxEnforcement}. Absent exactly when `mode` is
   * `danger-full-access`: nothing is confined, so there is no enforcement to
   * report.
   */
  enforcement?: SandboxEnforcement
  /**
   * True when the executor classifies this failure as the SANDBOX RUNNER
   * itself failing (missing binary, refused profile, fail-closed refusal
   * before exec) — the command NEVER RAN; this is a sandbox failure, not a
   * task failure, and it outranks `denied` (a runner's own error text can
   * contain denial words). Only ever stamped on settled BACKGROUND tasks: a
   * foreground run surfaces the same condition as the thrown
   * `SANDBOX_UNAVAILABLE` error instead (the foreground path has an error
   * channel; a settled task's facts are its only channel).
   */
  runnerFailed?: boolean
}
```

One more piece completes the vocabulary: the `SANDBOX_UNAVAILABLE` error code (owned by the [sandbox seam](sandbox.md)) is what the `ctx.sandbox` provider throws — and the executor propagates — when a confined mode has no usable backend. A selected runner refusing its profile reaches the same fail-closed foreground error; a settled background task records `runnerFailed`. The model receives denial/runner facts in results, learns the effective mode only when a denial marker names it, and can request a one-shot strictly wider retry through `sandbox_permissions` plus `justification`; `ctx.approval` must grant that exact call before anything executes. The complete policy and switching design is the [sandbox RFC](../rfc/implemented/feature/2026-07-06-sandbox.md).

## Background processes: `BashProcess`

`start()` returns a handle with no id or owner. `dsh-tool-bash` adapts it into `ctx.tasks.start()` hooks; the generic runtime then owns task identity and lifecycle. `done` resolves when the process closes and never rejects, reads remain valid after settlement, and sandbox facts are stamped before `done` resolves.

```ts type-equiv
interface BashProcess {
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
```

`readOutput()` returns the incremental delta and spill recovery facts:

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

`BashExecutor` owns `resolve`, foreground `run`, background-process `start`, and the `sandboxMode` capability fact. `dsh-bash-local` owns process groups, timeout/abort handling, bounded collectors, spill files, credential scrubbing, and disposal quiescence. `dsh-tool-bash` owns model-facing rendering and adapts background handles into the [generic task runtime](tasks.md).
