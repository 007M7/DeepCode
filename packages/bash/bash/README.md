# @deepseek-ai/dsh-bash

The **bash executor seam**: an abstract `BashExecutor` service (`ctx.bash`) defining WHAT a bash backend does — run commands, manage background tasks — without saying HOW.

This package is the interface quarter of the bash capability, split so each concern can evolve (and be swapped) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-bash` (this) | the interface: abstract service + vocabulary types |
| `@deepseek-ai/dsh-bash-local` | an implementation: local subprocesses |
| `@deepseek-ai/dsh-bash-sandbox` | an implementation: `dsh-bash-local`'s mechanics with every spawn confined via [`ctx.sandbox`](../../sandbox/sandbox/), denials reported as result facts |
| `@deepseek-ai/dsh-tool-bash` | the model-facing tool schemas over `ctx.bash` |

The split mirrors the LLM seam (`LlmService`/`LlmAdapter`) and the agent-tool survey: pi hides execution behind a `BashOperations` interface (local shell / SSH / VM backends), Codex behind an exec-server protocol. `dsh-bash-sandbox` is exactly that swap in action — a sandboxing executor behind the same interface; the consumer detects its `sandboxMode` capability and adds escalation fields without importing the implementation. A containerized or remote executor slots in the same way.

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

The seam owns per-session sandbox overrides through the log-only `bash/sandbox-mode` event, `effectiveSandboxMode`, and `setSandboxMode`; writers preserve turn enclosure, and replay restores the last override. `BashTaskId` and `OwnerToken` are distinct brands. Foreground `run` returns exit, timeout, cancellation, output, and optional sandbox facts; background `start` and `readOutput` use task records. A sandboxing executor reports the executed mode, conservative denial classification, and enforcement completeness. See [core-data-structures/bash.md](../../../docs/core-data-structures/bash.md) for full shapes.

`stdin` and `env` are set by in-process plugins (the hooks bridges, native plugins) to feed a hook command its JSON payload on stdin and its `CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT` env. The model-facing `dsh-tool-bash` tool does not expose them as parameters — a model already has equivalent power through shell syntax (`FOO=bar cmd`, a heredoc), so they would be redundant tool params. This is not a security boundary: the implementation's credential scrub (not these fields) is what keeps the harness's ambient secrets out of a spawned command. They are plain optionals on the resolved spec (unlike `owner`'s required-but-nullable): a missing one means "none", the safe default. See [the bash-stdin-env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

## Model Experience

Indirectly, through `dsh-tool-bash`, which turns executor output and sandbox facts into guidance and retained tool-result tokens.

## Known Limitations and Deferred Work

- **No interactive-input vocabulary** — `stdin` is written once at spawn and closed; the seam has no channel to feed a running task and no PTY session concept.
- **Foreground timeouts are always executor-owned** — a caller-owned-deadline mode on the seam is explicitly deferred by [the tool-call timeout-policy RFC](../../../docs/rfc/implemented/architecture/2026-07-07-tool-call-timeout-policy.md).
