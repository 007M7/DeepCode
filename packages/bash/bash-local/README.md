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
```

## Behavior (and where it came from)

Design surveyed against the bash tools of Claude Code, OpenCode, Codex, and pi; the notable choices:

- **Spawn per call, no shell state** — every call is a fresh non-login `bash -c` (deterministic; no rc files). All four surveyed tools spawn per call. `XXX(stateful-shell)` in `src/run.ts` records the two proven stateful designs (Claude Code's cwd-only persistence; Codex's PTY exec sessions) for when real workflows demand them.
- **Process-group kills with escalation** — children are spawned `detached` (own process group); kills send SIGTERM to the group, then SIGKILL after a 3s grace (OpenCode's escalation; pipelines and subshells die with the parent). ESRCH is tolerated; daemons that re-parent away from the group can still survive — same caveat as the surveyed tools.
- **Tail-keep truncation + spill files** — output beyond `maxOutputBytes` keeps the in-memory TAIL (errors/results cluster at the end — pi/OpenCode rationale) while the FULL stream is appended to a temp file whose path is reported when available. If the final spill close reports a delayed writeback failure, the executor still returns the tail but withholds the path rather than advertising a possibly incomplete file.
- **Model-friendly env + credential scrub** — `process.env` minus credential-shaped vars (`*KEY*`/`*SECRET*`/`*TOKEN*`), then `NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat` (Codex's hardcoded set) so pagers and ANSI color don't garble results. This scrub is the security control that keeps the harness's *ambient* credentials out of a spawned command. A spec's `env` is merged LAST (after the scrub), so a caller's explicit entry — a value it already holds — wins even on a credential-shaped name. The spec's `stdin`, when supplied, is written to the child and closed; with none supplied, fd 0 is `/dev/null` — the exact pre-seam default, so a command that probes stdin's file type is unaffected. Both `env`/`stdin` are set by in-process plugins (the hooks bridges); the model-facing tool doesn't expose them. See [the bash-stdin-env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).
- **Background tasks** — `start()` returns immediately, no timeout applies (Claude Code detaches timeouts when backgrounding), `readOutput()` is incremental with whole-stream byte offsets, and disposal kills everything. The spec's opaque `owner` token is stored on the tracked task and returned by `ownerOf(id)` — the executor never interprets it (the consumer's access policy does), and because it lives with the task here it survives a `tool-bash` HMR reload.

## Sandboxing

`TODO(permissions/sandbox)`: execution policy does NOT belong in this package. Use the `tools/pre-execute` deny/ask gate or implement a sandboxing `BashExecutor` — see docs/architecture.md § plugin checklist. Reference points: Claude Code wraps commands in sandbox-exec/bubblewrap; Codex applies seatbelt/landlock plus an execpolicy prefix-rule engine.
