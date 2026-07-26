# @deepseek-ai/dsh-bash-local

English | [中文](README.zh.md)

Local implementation of the `@deepseek-ai/dsh-bash` executor seam over the [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) service: `LocalBashExecutor` spawns `bash -c <command>` per call as a managed process group through `ctx.subprocess`, and owns everything bash-shaped — command defaulting and caps, timeout/cancel classification, the model-friendly terminal environment, and the model-facing stdout/stderr merge for background reads. Group mechanics (bounded spill-backed output, credential scrub, kill escalation, disposal) are the subprocess service's.

The package root exports the default and named `LocalBashExecutor` plugin plus its `Config`.

## Config

```yaml
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: /path/to/workspace   # default: process.cwd()
    timeoutMs: 120000          # default foreground timeout
    maxTimeoutMs: 600000       # cap for per-call overrides
    maxOutputBytes: 64000      # per-stream in-memory cap; overflow spills to disk
    maxSpillBytes: 67108864    # per-stream full-output spill cap
    graceMs: 3000              # kill escalation and post-exit pipe-drain grace
```

## Behavior (and where it came from)

Design surveyed against the bash tools of Claude Code, OpenCode, Codex, and pi; the notable choices:

- **Spawn per call, no shell state** — every call is a fresh non-login `bash -c` (deterministic; no rc files). All four surveyed tools spawn per call. `XXX(stateful-shell)` in `src/index.ts` records the two proven stateful designs (Claude Code's cwd-only persistence; Codex's PTY exec sessions) for when real workflows demand them.
- **Configured budgets over managed groups** — `resolve()` fills `workdir`/`timeoutMs`/`stdoutMaxBytes` from config, and every spawn hands the service explicit byte caps, spill cap, and `graceMs` (default 3s — OpenCode's escalation). Process-group kills, the post-exit pipe-drain grace, tail-keep truncation, and bounded spill files are [`dsh-subprocess-local`](../../subprocess/subprocess-local/README.md) mechanics. A foreground `BashExecRequest.stdoutMaxBytes` can raise stdout's capture budget for one trusted caller; stderr and background runs still use `maxOutputBytes`.
- **Timeout and cancel classification** — `run()` fuses its config-clamped timeout with the caller's signal through one deadline; only the executor's own timeout reports `timedOut`, an upstream cancel reports `aborted`, and a self-signaled command reports neither ([timeout-library Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md)).
- **Model-friendly terminal env** — `NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat` (Codex's hardcoded set) so pagers and ANSI color don't garble results, merged as ordinary env under the service's credential scrub and `DSH_*` channel rules; an explicit caller entry still wins. See the [stdin/env Agent Note](../../../.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md) and [managed environment Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-agent-session-identity-and-log-location.md).
- **Background processes** — `start()` returns a live `BashProcess` handle immediately, no timeout applies (Claude Code detaches timeouts when backgrounding), and the handle's `readOutput()` merges the service's offset-based stdout/stderr reads into one marked-section delta with a consuming cursor. A still-running process belongs to the subprocess service, so it survives executor reloads and dies (killed and joined) with the service's disposal. Everything task-shaped (ids, ownership, polling, notices) lives in the generic [`ctx.tasks` runtime](../../tasks/tasks/README.md), which the tool layer registers the handle with — this executor never sees a session or a registry.

## Model Experience

Indirectly, through `dsh-tool-bash`, which renders this executor's bounded stdout/stderr tails, background-process deltas, spill-file paths, and infrastructure failures.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Unconfined by itself** — this executor always runs commands with the harness process's authority; deployments needing confinement compose [`dsh-bash-sandbox`](../bash-sandbox/README.md), while per-call allow/deny/ask policy belongs on `tools/pre-execute`.
- **No persistent shell or PTY** — every call starts a fresh non-login `bash -c`; cwd-only persistence and interactive terminal sessions remain deferred until a real workflow requires them.
- **POSIX-only** — the `bash` binary is hardcoded, and the underlying service's group semantics are POSIX; Windows is unsupported.
- **A background spawn-failure note is single-delivery** — the subprocess service buffers no output for a process that never ran, so the executor injects `spawn failed: …` into exactly one `readOutput()` delta; a reader that discards that delta cannot recover it.

Scrub-heuristic and spill-retention caveats live with [`dsh-subprocess-local`](../../subprocess/subprocess-local/README.md), which owns those mechanics.
