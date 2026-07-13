# @deepseek-ai/dsh-bash

The **bash executor seam**: an abstract `BashExecutor` service (`ctx.bash`) defining WHAT a bash backend does — run commands, manage background tasks — without saying HOW.

This package is the interface quarter of the bash capability, split so each concern can evolve (and be swapped) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-bash` (this) | the interface: abstract service + vocabulary types |
| `@deepseek-ai/dsh-bash-local` | an implementation: local subprocesses |
| `@deepseek-ai/dsh-bash-sandbox` | an implementation: `dsh-bash-local`'s mechanics with every spawn confined via [`ctx.sandbox`](../../sandbox/sandbox/), denials reported as result facts |
| `@deepseek-ai/dsh-tool-bash` | the model-facing tool schemas over `ctx.bash` |

The split mirrors the LLM seam (`LlmService`/`LlmAdapter`) and the agent-tool survey: pi hides execution behind a `BashOperations` interface (local shell / SSH / VM backends), Codex behind an exec-server protocol. `dsh-bash-sandbox` is exactly that swap in action — a sandboxing executor behind the same interface, tool schemas untouched; a containerized or remote executor slots in the same way.

## Service API (`ctx.bash`)

| Member | Semantics |
|---|---|
| `run(spec)` | Foreground execution. Resolves when the command finishes. **Rejects only for infrastructure failures** (unusable workdir, missing shell, pre-aborted signal); nonzero exits, timeout kills, and abort kills resolve with a descriptive `BashRunResult`. |
| `start(spec)` | Background execution. Returns a `BashTask` handle immediately; **no timeout applies** (stop tasks via `kill`). |
| `get(id)` / `list()` | Task lookup. |
| `sandboxMode` | The capability fact for the tool layer: the default mode a SANDBOXING executor confines under (`undefined` in the base class — "this executor does not sandbox"). `dsh-tool-bash` reads it at registration to advertise the escalation fields only when the composition honors them. |
| `ownerOf(id)` | The opaque OWNER token recorded for a background task at `start` (from the spec's `owner`), or `undefined` for an unknown id OR a known-but-ownerless task. The executor stores/returns it verbatim and NEVER interprets it — the access POLICY lives in the consumer (`dsh-tool-bash`), which compares `ownerOf(id)` to the caller's token. Storing ownership here (disposed with the executor's fiber) is what makes it survive a consumer HMR reload. |
| `readOutput(id)` | **Incremental** output read — consecutive reads never re-deliver. Reads that lost data to buffer bounds flag `lossy` and point at full-stream spill files. Throws for unknown ids. |
| `kill(id)` | Kill a running task. Returns `false` when it already finished; throws for unknown ids. |
| `onTaskDone(listener)` | Completion listener (effect-based, disposer returned). Fires exactly once per task; never after the service is disposed. |

Implementations subclass `BashExecutor`, implement the abstract methods, and call `notifyTaskDone(task)` on background completion. Disposal must kill every running task (no orphan processes) — see the HMR-safety tests.

## Vocabulary

`BashExecRequest` (command, workdir?, timeoutMs?, signal?, stdin?, env?, owner?, sandboxMode?) resolves to `BashExecSpec` (command, workdir, timeoutMs, signal?, stdin?, env?, owner, sandboxMode) before execution; `owner` and `sandboxMode` are optional on the request and **required-but-nullable** on the resolved spec, so a forgotten one is a visible `undefined` rather than a silently-absent property. `sandboxMode` is the explicit per-call sandbox-policy input: an escalation grant a human just issued ([the sandbox RFC § Escalation](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md), which outranks) or the session's standing override ([the sandbox RFC § Per-session mode switching](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)); a sandboxing executor's `resolve()` stamps its configured default when the request carries none, and a non-sandboxing executor carries the field verbatim and confines nothing.

The seam also owns the per-session mode override vocabulary (the sandbox RFC § Per-session mode switching): the log-only `'bash/sandbox-mode'` session event, the pure fold `effectiveSandboxMode(events)` (last event wins; `undefined` means "apply the executor default"), and THE write path `setSandboxMode(session, mode)` — the session log is the store, so an override survives restart by replay and two sessions can never see each other's mode. Writers must respect turn-enclosure: the ACP bridge anchors an idle switch at the next turn rather than appending between turns. The task id (`BashTaskId`) and the `owner` token (`OwnerToken`) are [branded](../../util/brand) — `OwnerToken` is a DISTINCT brand from `SessionId` (the seam never imports `dsh-session`; the `dsh-tool-bash` consumer is the single boundary that casts its `SessionId` into one). `run()` returns `BashRunResult` (exitCode, signal, timedOut, aborted, timeoutMs, stdout/stderr as `CollectedOutput`) and `start()`/`readOutput()` use `BashTask`/`BashTaskRead` for the background side. A sandboxing executor additionally stamps `sandbox` result facts on results and settled tasks (`BashSandboxInfo`: the mode it executed under, the conservative `denied` classification, and — for confined modes — the backend's `enforcement` completeness); the mode/enforcement vocabulary is owned by the [`dsh-sandbox`](../../sandbox/sandbox/) seam, and the facts are documented in [core-data-structures/bash.md](../../../docs/core-data-structures/bash.md). See `src/types.ts` for the full contracts.

`stdin` and `env` are set by in-process plugins (the hooks bridges, native plugins) to feed a hook command its JSON payload on stdin and its `CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT` env. The model-facing `dsh-tool-bash` tool does not expose them as parameters — a model already has equivalent power through shell syntax (`FOO=bar cmd`, a heredoc), so they would be redundant tool params. This is not a security boundary: the implementation's credential scrub (not these fields) is what keeps the harness's ambient secrets out of a spawned command. They are plain optionals on the resolved spec (unlike `owner`'s required-but-nullable): a missing one means "none", the safe default. See [the bash-stdin-env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).
