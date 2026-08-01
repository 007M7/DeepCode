# Agent Note: Windows defaults to pwsh (roadmap)

Status: proposed

English | [中文](2026-08-01-windows-pwsh-default.zh.md)

## Problem

The harness's shipped execution profile is bash-first on every platform. Windows hosts must install a bash shim (WSL or Git-Bash) or fall back to the POSIX-only `dsh-bash-local` behavior; the model-facing bash tool teaches the bash dialect, and the TUI/Web surfaces render terminal output in bash-shaped expectations. The first Windows-native foundation shipped in the [pwsh executor and tool decision](../../implemented/feature/2026-08-01-pwsh-tool-and-executor.md): a PowerShell implementation of the `ctx.bash` seam and a minimal `pwsh` tool — but nothing yet defaults Windows hosts to them.

## Proposal

Three follow-up stages, each independently shippable:

1. **Windows default composition** — the shipped CLI compositions mount `dsh-pwsh-local` as the `ctx.bash` executor and `dsh-tool-pwsh` as the model-facing shell tool on Windows hosts (bash unmounted there), while POSIX hosts keep the bash stack. This is a composition/roster decision in `base.cordis.yml` and the surface overlays, gated by platform; it makes the shipped Windows experience PowerShell-native end to end.
2. **Bash-tool parity twin** — `tool-pwsh` grows the bash tool's missing surface where Windows workflows prove it: `run_in_background` through the generic task runtime, and the persistence-side `DSH_SESSION_JSONL` environment fact. Sandbox escalation stays out until a Windows-confining executor exists.
3. **pwsh TUI/GUI rendering** — the TUI and Web surfaces render pwsh output with PowerShell-aware presentation (native path display, `$env:` facts), the counterpart of the bash terminal cards. This is where terminal/console rendering conventions get a PowerShell twin.

The stages are deliberately sequenced: composition first (a Windows user gets PowerShell without choosing), then tool parity, then rendering. Nothing in this proposal changes POSIX behavior.

## Alternatives considered

**Default Windows to pwsh inside `dsh-bash-local` (one executor, dialect switch).** Rejected for the same reason the executor decision rejected a mode switch: the executor's identity is the shell it spawns, and platform-gated composition is a deployment choice, not an executor config.

**Ship the Windows default in the same change as the executor/tool.** Rejected: the roster change needs its own evidence (what breaks when the shipped Windows tree stops mounting bash, which tools depend on bash semantics), and it belongs to a composition decision with the approval/PTY surface visible.

**Keep bash on Windows via a shim and skip PowerShell defaults.** Rejected: it perpetuates the install-tax and the dialect mismatch the roadmap exists to remove; the shim is a deployment requirement, not a product behavior.

## Acceptance criteria

- A Windows host running the shipped `dsh` TUI/Web gets `pwsh` as its shell tool and PowerShell as the `ctx.bash` executor without configuration, and `bash` is absent from the model-visible roster there.
- POSIX hosts are byte-for-byte unaffected (same roster, same executor).
- The shipped-composition e2es assert the platform-gated roster on both families.
- Stage 2 lands with task-runtime integration tests; stage 3 lands with TUI/Web rendering snapshots for pwsh output.

## Risks

- **Bash-dependent composition rows** — any shipped plugin that assumes `bash` semantics (hook bridges executing shell hooks, workspace tooling) must be audited per stage; the audit may force a staged rollout rather than one switch.
- **Tool-behavior drift** — a minimal `tool-pwsh` that never grows parity invites models to write bash-shaped commands; the prompt guidance and dialect contract mitigate this only if the twin keeps pace.
- **Windows CI coverage gap** — unit coverage runs on Linux; Windows-only regressions in the pwsh stack surface through the Windows build/static lane and e2es, which must be extended per stage rather than assumed.
- **Rendering conventions** — a PowerShell twin for terminal cards is a UI design decision with snapshot surface; deferring it (stage 3) keeps stage 1 shippable without UI churn.
