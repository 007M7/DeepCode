# @deepseek-ai/dsh-bash

The **bash executor seam**: an abstract `BashExecutor` service (`ctx.bash`) defining WHAT a bash backend does — run commands, manage background tasks — without saying HOW.

This package is one third of the bash capability, split so each concern can evolve (and be swapped) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-bash` (this) | the interface: abstract service + vocabulary types |
| `@deepseek-ai/dsh-bash-local` | an implementation: local subprocesses |
| `@deepseek-ai/dsh-tool-bash` | the model-facing tool schemas over `ctx.bash` |

The split mirrors the LLM seam (`LlmService`/`LlmAdapter`) and the agent-tool survey: pi hides execution behind a `BashOperations` interface (local shell / SSH / VM backends), Codex behind an exec-server protocol. A future sandboxed, containerized, or remote executor implements this interface and the tool schemas don't change.

## Service API (`ctx.bash`)

| Member | Semantics |
|---|---|
| `run(spec)` | Foreground execution. Resolves when the command finishes. **Rejects only for infrastructure failures** (unusable workdir, missing shell, pre-aborted signal); nonzero exits, timeout kills, and abort kills resolve with a descriptive `BashRunResult`. |
| `start(spec)` | Background execution. Returns a `BashTask` handle immediately; **no timeout applies** (stop tasks via `kill`). |
| `get(id)` / `list()` | Task lookup. |
| `ownerOf(id)` | The opaque OWNER token recorded for a background task at `start` (from the spec's `owner`), or `undefined` for an unknown id OR a known-but-ownerless task. The executor stores/returns it verbatim and NEVER interprets it — the access POLICY lives in the consumer (`dsh-tool-bash`), which compares `ownerOf(id)` to the caller's token. Storing ownership here (disposed with the executor's fiber) is what makes it survive a consumer HMR reload. |
| `readOutput(id)` | **Incremental** output read — consecutive reads never re-deliver. Reads that lost data to buffer bounds flag `lossy` and point at full-stream spill files. Throws for unknown ids. |
| `kill(id)` | Kill a running task. Returns `false` when it already finished; throws for unknown ids. |
| `onTaskDone(listener)` | Completion listener (effect-based, disposer returned). Fires exactly once per task; never after the service is disposed. |

Implementations subclass `BashExecutor`, implement the abstract methods, and call `notifyTaskDone(task)` on background completion. Disposal must kill every running task (no orphan processes) — see the HMR-safety tests.

## Vocabulary

`BashExecRequest` (command, workdir?, timeoutMs?, signal?, stdin?, env?, owner?) resolves to `BashExecSpec` (command, workdir, timeoutMs, signal?, stdin?, env?, owner) before execution; `owner` is optional on the request and **required-but-nullable** (`OwnerToken | undefined`) on the resolved spec, so a forgotten owner is a visible `undefined` rather than a silently-absent property. The task id (`BashTaskId`) and the `owner` token (`OwnerToken`) are [branded](../../util/brand) — `OwnerToken` is a DISTINCT brand from `SessionId` (the seam never imports `dsh-session`; the `dsh-tool-bash` consumer is the single boundary that casts its `SessionId` into one). `run()` returns `BashRunResult` (exitCode, signal, timedOut, aborted, timeoutMs, stdout/stderr as `CollectedOutput`) and `start()`/`readOutput()` use `BashTask`/`BashTaskRead` for the background side. See `src/types.ts` for the full contracts.

`stdin` and `env` are a **trusted-plugin surface**: an in-process plugin (the hooks bridges, native plugins) sets them to feed a hook command its JSON payload on stdin and its `CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT` env. The model-facing `dsh-tool-bash` tool deliberately never forwards model input into either — so a model cannot smuggle an env var or stdin payload past the implementation's credential scrub. They are plain optionals on the resolved spec (unlike `owner`'s required-but-nullable): a missing one means "none", the safe default, not a security footgun. See [the trusted-plugin RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).
