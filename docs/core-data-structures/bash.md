# Bash Executor

The bash execution seam — the canonical [capability seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md) example, split across three packages: interface ([dsh-bash](../../packages/bash/bash), `ctx.bash`), implementation ([dsh-bash-local](../../packages/bash/bash-local), local subprocesses), and consumer ([dsh-tool-bash](../../packages/bash/tool-bash), the `bash`/`bash_output`/`bash_kill` tool schemas). Bash is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A sandboxed, containerized, or remote backend is a sibling package implementing the same interface.

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
  /**
   * Opaque OWNER token for a background task — the consumer's isolation key
   * (the tool layer passes the owning agent's `session.header.id`). The
   * executor stores it on the task and exposes it via {@link BashExecutor.ownerOf};
   * the executor itself NEVER interprets it (no access policy lives in the
   * seam — that is the consumer's job). Absent for foreground runs and for an
   * ownerless background start (a non-agent caller).
   */
  owner?: OwnerToken | undefined
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
  /**
   * The sandbox mode this call executes under, REQUIRED-but-nullable for the
   * same visibility reason as `owner`. A sandboxing executor's `resolve()`
   * stamps the effective mode (the request's explicit override, else its
   * configured default) so `run()`/`start()` read the spec, never the config;
   * a non-sandboxing executor carries the request value through verbatim and
   * ignores it (`undefined` under such an executor means what its README says:
   * unconfined execution).
   */
  sandboxMode: SandboxMode | undefined
}
```

The `owner` token is the isolation key: the executor stores it but never interprets it (access policy is the consumer's job), so a background task started by one agent isn't readable cross-session. A required-but-nullable field makes a forgotten owner a visible `undefined` rather than a silently-unowned task.

`stdin` and `env` are set by in-process plugins (the hooks bridges, native plugins) to feed a hook command its JSON payload on stdin and its `CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT` env. The model-facing `dsh-tool-bash` tool does not expose them as parameters — its request is built from `command`/`workdir`/`timeoutMs`/`signal`/`owner` only — because a model already has equivalent power through shell syntax (`FOO=bar cmd`, a heredoc), so duplicating them as tool params would be redundant. This is NOT a security boundary: the credential scrub in `dsh-bash-local` is what stops the harness's ambient secrets reaching a spawned command, and it works regardless of these fields (a model cannot read a value the scrub removed, and tool-call args are static JSON, never shell-evaluated). A guard test asserts the tool doesn't forward model `env`/`stdin` — to catch a future `...args` spread, not to defend a trust wall. `env` is merged AFTER the scrub so an explicit caller entry (a value it already holds) wins even on a credential-shaped name. See [the bash-stdin-env RFC](../rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

Both ids the seam handles are [branded](core.md) (zero-cost `string` brands, the same machinery as `SessionId`/`AgentId`): `BashTaskId` (a tracked background task, generated `bash-N` by the local executor) and `OwnerToken` (the opaque isolation key). `OwnerToken` is deliberately a DISTINCT brand from `SessionId`, not an alias: the bash seam is a capability seam that must not know what an owner token *means*, so it never imports `dsh-session`'s vocabulary — the `dsh-tool-bash` consumer is the single boundary that casts the owning agent's `SessionId` into an `OwnerToken`. Branding both stops a raw `string` (or a `BashTaskId` where an `OwnerToken` is expected, or vice versa) from slipping through the type checker on the model-facing `task_id` path.

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

A sandbox-consuming executor (`dsh-bash-sandbox`) exposes its configured fallback through `BashExecutor.sandboxMode`. The tool layer folds each agent session's durable `bash/sandbox-mode` override, stamps the effective mode onto the request, and may replace it for one user-approved strictly wider call. It deliberately neither states the standing mode nor narrates switches; a denial result names the mode that command actually ran under. The mode/enforcement vocabulary is owned and cataloged by the [`@deepseek-ai/dsh-sandbox` seam](sandbox.md), whose provider wraps the executor's argv; modes govern FILE effects only, not network or process visibility.

A sandboxed run always reports the facts it executed under on `BashRunResult.sandbox`: `denied` is the executor's conservative classification of a failure as sandbox-caused (a failed exit whose stderr carries a filesystem-permission signature — never a clean exit or a signal kill), read from the collected stderr tail; `enforcement` reports how completely the selected backend governs the mode's file effects (`SandboxEnforcement = 'full' | 'partial'` — `partial` when an older Landlock ABI governs only a subset of the requested accesses; absent under `danger-full-access`, where nothing is confined); `runnerFailed` marks the opposite of a denial — the sandbox RUNNER itself failed and the command never ran (stamped only on settled background tasks; a foreground run surfaces the same condition as the thrown `SANDBOX_UNAVAILABLE` error):

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

## Background tasks: `BashTask`

A long-running command started with `start()` is tracked as a `BashTask`. `BashTaskStatus` is `'running' | 'completed' | 'killed'`; `done` resolves when the underlying process closes and never rejects. A sandboxing executor stamps `sandbox` once the task settles — classification runs against the settled task's collected stderr — so the field is absent while running and under an unsandboxed executor.

```ts type-equiv
interface BashTask {
  readonly id: BashTaskId
  readonly command: string
  status: BashTaskStatus
  /** Exit code once finished (null = killed by signal / still running). */
  exitCode: number | null
  /** Terminating signal name, when signal-killed. */
  signal: NodeJS.Signals | null
  /** Resolves when the underlying process closes (never rejects). */
  readonly done: Promise<void>
  /**
   * Sandbox facts for this task's execution, stamped by a sandboxing executor
   * once the task settles and BEFORE completion listeners are notified — an
   * `onTaskDone` consumer and a `done` awaiter both see it. Denial
   * classification runs against the settled task's collected stderr, so the
   * field cannot exist earlier: absent while the task is running and under an
   * executor that does not sandbox. See {@link BashSandboxInfo} for the
   * `denied` semantics.
   */
  sandbox?: BashSandboxInfo
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

`BashExecutor` (`ctx.bash`, abstract — defined in [`packages/bash/bash/src/index.ts`](../../packages/bash/bash/src/index.ts)) mirrors the `LlmService`/`LlmAdapter` split: `resolve` (request → spec), `run` (foreground), `start` (background), `get`/`ownerOf`/`list`/`readOutput`/`kill`, and `onTaskDone` (a `BashTaskListener` completion callback). Spawned commands get a **scrubbed env** (dropping `*KEY*`/`*SECRET*`/`*TOKEN*`) and spill files use a private 0700 dir with random names and owner-only opens — model output never gets the ambient environment or a predictable path. The implementation that provides all this is `dsh-bash-local`; the model-facing `bash`/`bash_output`/`bash_kill` schemas that call it are in `dsh-tool-bash` (and present as terminals via the [tool-presentation vocabulary](tools.md#tool-presentation-ui-vocabulary)).
