# @deepseek-ai/dsh-bash

The **bash executor seam**: an abstract `BashExecutor` service (`ctx.bash`) defining WHAT a bash backend does — run foreground commands, start background processes — without saying HOW.

This package is one third of the bash capability, split so each concern can evolve (and be swapped) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-bash` (this) | the interface: abstract service + vocabulary types |
| `@deepseek-ai/dsh-bash-local` | an implementation: local subprocesses |
| `@deepseek-ai/dsh-tool-bash` | the model-facing tool schema over `ctx.bash` |

The split mirrors the LLM seam (`LlmService`/`LlmAdapter`) and the agent-tool survey: pi hides execution behind a `BashOperations` interface (local shell / SSH / VM backends), Codex behind an exec-server protocol. A future sandboxed, containerized, or remote executor implements this interface and the tool schemas don't change.

## Service API (`ctx.bash`)

| Member | Semantics |
|---|---|
| `resolve(request)` | Fill a caller's `BashExecRequest` (optional `workdir`/`timeoutMs`) into a fully-resolved `BashExecSpec` from the implementation's config defaults and caps — the explicit defaulting step consumers call before `run`/`start`. |
| `run(spec)` | Foreground execution. Resolves when the command finishes. **Rejects only for infrastructure failures** (unusable workdir, missing shell, pre-aborted signal); nonzero exits, timeout kills, and abort kills resolve with a descriptive `BashRunResult`. |
| `start(spec)` | Background execution. Returns a `BashProcess` handle immediately; **no timeout applies** (stop the process via the handle's `kill()` or the spec's AbortSignal). |

The seam is deliberately TASK-FREE: `start()` hands back only the `BashProcess` handle — `command`, `status`, `exitCode`/`signal`, a never-rejecting `done` quiescence promise, a consuming incremental `readOutput()` (reads that lost data to buffer bounds flag `lossy` and point at full-stream spill files; reads stay valid after exit), and an idempotent `kill()`. Task ids, cross-session isolation, polling tools, and completion notices are the generic [`ctx.tasks` runtime](../../tasks/tasks/README.md)'s job — the tool layer adapts the handle into a task registration — which keeps a remote/sandbox executor free of any session or registry dependency. Disposal must kill every running background process and await its exit (no orphan processes) — see the HMR-safety tests.

## Vocabulary

`BashExecRequest` (command, workdir?, timeoutMs?, signal?, stdin?, env?) resolves to `BashExecSpec` (command, workdir, timeoutMs, signal?, stdin?, env?) before execution. `run()` returns `BashRunResult` (exitCode, signal, timedOut, aborted, timeoutMs, stdout/stderr as `CollectedOutput`) and `start()` returns `BashProcess`, whose `readOutput()` yields a `BashProcessRead`. See `src/types.ts` for the full contracts.

`stdin` and `env` are set by in-process plugins (the hooks bridges, native plugins) to feed a hook command its JSON payload on stdin and its `CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT` env. The model-facing `dsh-tool-bash` tool does not expose them as parameters — a model already has equivalent power through shell syntax (`FOO=bar cmd`, a heredoc), so they would be redundant tool params. This is not a security boundary: the implementation's credential scrub (not these fields) is what keeps the harness's ambient secrets out of a spawned command. They are plain optionals on the resolved spec: a missing one means "none", the safe default. See [the bash-stdin-env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).
