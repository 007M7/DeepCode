# @deepseek-ai/dsh-bash

The **bash executor seam**: an abstract `BashExecutor` service (`ctx.bash`) defining WHAT a bash backend does — run foreground commands and start background processes — without saying HOW. Task ids, ownership, collection, cancellation, and notices belong to the generic `ctx.tasks` runtime.

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
| `start(spec)` | Background execution. Returns a task-free `BashProcess` handle immediately; **no timeout applies**. The caller may adapt it into `ctx.tasks`. |
| `sandboxMode` | The capability fact for the tool layer: the default mode a SANDBOXING executor confines under (`undefined` in the base class — "this executor does not sandbox"). `dsh-tool-bash` reads it at registration to advertise the escalation fields only when the composition honors them. |
| `BashProcess.readOutput()` | **Incremental** output read — consecutive reads never re-deliver. Reads that lost data to buffer bounds flag `lossy` and point at full-stream spill files. |
| `BashProcess.kill()` | Kill the process group. Returns `false` when it already finished. |

Implementations subclass `BashExecutor` and implement the abstract methods. Disposal must kill every running process and await its exit — see the HMR-safety tests.

## Vocabulary

`BashExecRequest` (command, workdir?, timeoutMs?, signal?, stdin?, env?, sandboxMode?) resolves to `BashExecSpec` (command, workdir, timeoutMs, signal?, stdin?, env?, sandboxMode) before execution. `sandboxMode` is optional on the request and required-but-nullable on the resolved spec: it carries an approved one-shot escalation or the session's standing override; a sandboxing executor stamps its configured default when absent, while a non-sandboxing executor carries the field and confines nothing.

The seam also owns the per-session mode override vocabulary: the log-only `'bash/sandbox-mode'` session event, the pure `effectiveSandboxMode(events)` fold, and the `setSandboxMode(session, mode)` write path. `run()` returns `BashRunResult`; `start()` returns `BashProcess`, whose incremental read and kill methods are adapted by `dsh-tool-bash` into a generic task registration. A sandboxing executor stamps `BashSandboxInfo` on foreground results and settled process handles. See `src/types.ts` and [core-data-structures/bash.md](../../../docs/core-data-structures/bash.md).

`stdin` and `env` are set by in-process plugins (the hooks bridges, native plugins) to feed a hook command its JSON payload on stdin and its `CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT` env. The model-facing `dsh-tool-bash` tool does not expose them as parameters — a model already has equivalent power through shell syntax (`FOO=bar cmd`, a heredoc), so they would be redundant tool params. This is not a security boundary: the implementation's credential scrub (not these fields) is what keeps the harness's ambient secrets out of a spawned command. They are plain optionals on the resolved spec; a missing value means "none". See [the bash-stdin-env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

## Model Experience

Indirectly, through `dsh-tool-bash`, which turns executor output and sandbox facts into guidance and retained tool-result tokens.

## Known Limitations and Deferred Work

- **No interactive-input vocabulary** — `stdin` is written once at spawn and closed; the seam has no channel to feed a running task and no PTY session concept.
- **Foreground timeouts are always executor-owned** — a caller-owned-deadline mode on the seam is explicitly deferred by [the tool-call timeout-policy RFC](../../../docs/rfc/implemented/architecture/2026-07-07-tool-call-timeout-policy.md).
