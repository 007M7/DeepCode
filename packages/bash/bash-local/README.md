# @deepseek-ai/dsh-bash-local

Local-subprocess implementation of the `@deepseek-ai/dsh-bash` executor seam: `LocalBashExecutor` spawns `bash -c <command>` per call in its own process group, collects bounded output with full-stream spill files, and escalates kills SIGTERM→SIGKILL across the whole group.

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

## Sandboxing

Execution policy does NOT belong in this package: this executor always runs commands unconfined. Confinement is [`dsh-bash-sandbox`](../bash-sandbox/README.md), which extends this executor verbatim and confines commands under the `ctx.sandbox` seam's bwrap/Landlock/Seatbelt backends ([sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)); per-call allow/deny/ask policy belongs on the `tools/pre-execute` gate.
