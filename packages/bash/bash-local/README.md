# @deepseek-ai/dsh-bash-local

Local-subprocess implementation of the `@deepseek-ai/dsh-bash` executor seam: `LocalBashExecutor` spawns `bash -c <command>` per call in its own process group, collects bounded output with full-stream spill files, and escalates kills SIGTERM→SIGKILL across the whole group.

The package root exports the default and named `LocalBashExecutor` plugin plus its `Config`; subprocess plumbing stays internal to the implementation package.

## Config

```yaml
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: /path/to/workspace   # default: process.cwd()
    timeoutMs: 120000          # default foreground timeout
    maxTimeoutMs: 600000       # cap for per-call overrides
    maxOutputBytes: 64000      # per-stream in-memory cap; overflow spills to disk
    graceMs: 3000              # SIGTERM→SIGKILL escalation grace on kills
```

## Behavior (and where it came from)

Design surveyed against the bash tools of Claude Code, OpenCode, Codex, and pi; the notable choices:

- **Spawn per call, no shell state** — every call is a fresh non-login `bash -c` (deterministic; no rc files). All four surveyed tools spawn per call. `XXX(stateful-shell)` in `src/run.ts` records the two proven stateful designs (Claude Code's cwd-only persistence; Codex's PTY exec sessions) for when real workflows demand them.
- **Process-group kills with escalation** — children are spawned `detached` (own process group); kills send SIGTERM to the group, then SIGKILL after the `graceMs` grace (default 3s — OpenCode's escalation; pipelines and subshells die with the parent). ESRCH is tolerated; daemons that re-parent away from the group can still survive — same caveat as the surveyed tools.
- **Tail-keep truncation + spill files** — output beyond `maxOutputBytes` keeps the in-memory TAIL (errors/results cluster at the end — pi/OpenCode rationale) while the FULL stream is appended to a temp file whose path is reported when available. If the final spill close reports a delayed writeback failure, the executor still returns the tail but withholds the path rather than advertising a possibly incomplete file.
- **Model-friendly environment** — ambient credential-shaped variables are removed before noninteractive terminal defaults and explicit caller entries are applied. Supplied stdin is written and closed; otherwise fd 0 is `/dev/null`. Trusted plugins use `env` and `stdin`, but the model-facing tool does not expose them. See the [bash stdin/env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).
- **Background tasks** — `start()` returns immediately, no timeout applies (Claude Code detaches timeouts when backgrounding), `readOutput()` is incremental with whole-stream byte offsets, and disposal kills everything. The spec's opaque `owner` token is stored on the tracked task and returned by `ownerOf(id)` — the executor never interprets it (the consumer's access policy does), and because it lives with the task here it survives a `tool-bash` HMR reload.

## Model Experience

Indirectly, through `dsh-tool-bash`, which renders this executor's bounded stdout/stderr tails, background-task deltas and state, spill-file path, exact `Error: unknown bash task "<taskId>"` and `Error: aborted before spawn: <reason>` failures, and retains each resulting tool message until compaction.

## Known Limitations and Deferred Work

- **Unconfined by itself** — this executor always runs commands with the harness process's authority; deployments needing confinement compose [`dsh-bash-sandbox`](../bash-sandbox/README.md), while per-call allow/deny/ask policy belongs on `tools/pre-execute`.
- **No persistent shell or PTY** — every call starts a fresh non-login `bash -c`; cwd-only persistence and interactive terminal sessions remain deferred until a real workflow requires them.
- **POSIX-only** — the `bash` binary, detached process groups, group kills, and SIGTERM→SIGKILL escalation are hardcoded; Windows is unsupported.
- **The credential scrub is a name heuristic** — `*KEY*`/`*SECRET*`/`*TOKEN*` only; differently-named secrets (e.g. `*PASSWORD*`) pass through, and a whitelist for over-scrubbed vars is noted future work.
- **Spill files are never deleted** — full-output recovery files (and the private per-process spill dir) accumulate under the OS tmpdir until something external cleans them.
- **Finished background tasks are never evicted** — they stay in the task map, retaining their in-memory output tails, until executor disposal.

The raw process handling lives in `src/run.ts`; `src/index.ts` is the service wiring.
