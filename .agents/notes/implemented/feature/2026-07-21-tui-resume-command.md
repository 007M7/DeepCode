# Agent Note: Product-level TUI session resume

Status: implemented

English | [中文](2026-07-21-tui-resume-command.zh.md)

## Problem

The original `/resume` printed shell commands. It did not let a keyboard user inspect titles or outcomes, distinguish corruption from a missing adapter, detect another live owner, or safely transfer the terminal. Leaving the TUI and manually launching a command also hid the required ordering: finish current work, flush it, release the UI and app, then restore the exact persisted identity without silently creating a replacement.

## Decision

`/resume` uses the TUI's existing interactive overlay seam. It lists the current workspace by last logged activity and searches log-backed title or id. Each candidate displays current/live/persisted state, last turn outcome, recent provider/model, durable goal phase when present, and the id as secondary text. The current session and another live owner's session remain visible but disabled.

`session-query.readSession()` supplies a detached complete log validated by the same core replay boundary used by resume. The TUI folds title and goal state from that log. A candidate load failure is local to that row; selecting a candidate repeats the load, cwd, occupancy, and route checks so a stale listing cannot bypass preflight. A missing adapter reports an intact session with an unavailable route. Running agents are never switched or cancelled implicitly.

First-party persistence backends implement a cross-process live lease under the shared coordinator. JSONL uses an owner-only lock record; SQLite uses a `live_session_leases` row. Both retain PID plus an exec-stable nonce, reject another live process, reclaim a dead PID or a same-PID different-incarnation owner, and release only after the exact session lifecycle drains. A final process-local release excludes reacquisition until the physical lease settles. `AgentLoop.resume()` claims before load, closing the preflight/start race.

After preflight, the TUI claims the target's exec-stable live lease before flushing the current session. A lost claim race remains in the current TUI; any later recoverable failure releases the reservation. The TUI then stops the terminal before calling `TuiRuntime.handoffResume`. The shipped `dsh` host disposes the root app and uses `process.execve` with a normalized `--resume` argument, atomically replacing the process while retaining the target reservation rather than spawning a second terminal owner. The resumed app publishes the same `SessionId`; ordinary replay restores transcript, title, todos, and durable goal state. Goal activation is intentionally disarmed, and the TUI asks for human confirmation or `/goal resume`.

`resumeCommand` remains an exit and no-host fallback. The TUI substitutes `{session}` only for display and never executes arbitrary shell text. The exit hint still appears only after the current session is durable.

## Alternatives considered

**Have the TUI spawn `resumeCommand`.** Rejected: the template is deployment text, not trusted argv, and the TUI does not own app teardown or process lifetime. The constrained host seam receives only a validated `SessionId`.

**Construct the resumed agent inside the existing TUI.** Rejected: replacing one config-created agent would cross Loader ownership, scoped plugin setup, persistence retirement, and terminal lifecycle in the presentation layer. Root disposal plus process replacement reuses the supported startup path.

**Treat a missing adapter as a missing session.** Rejected: storage validity and current route availability are independent facts. The selector keeps the row and names the unavailable provider/model.

**Persist goal activation across resume.** Rejected: durable intent is not authorization to continue after a human or process boundary. Goal phase survives; automatic continuation does not.

## Consequences

- Persistence schema and artifact layout include live leases; SQLite advances its unreleased schema version and rejects older databases under the repository's pre-release policy.
- `/resume` depends on `session-query` for discovery and complete-log reads, but persistence and host handoff remain optional; without a host, the command fallback stays usable.
- Process replacement intentionally restarts Loader composition. Runtime-only state is rebuilt, while only logged or header-backed session state survives.

## Testing

TUI tests cover keyboard navigation, title/id search, Escape cancellation, running-agent refusal, route absence, occupied and corrupt rows, fallback commands, and stop-before-handoff ordering. Session-query tests pin detached full-log validation. Persistence contracts retain valid/corrupt/interrupted behavior, while a real JSONL child process proves another owner is disabled and its crashed lease is reclaimed. Agent-loop resume tests pin exact identity and history; title, todo, and goal replay suites pin restored projections and disarmed goal activation. The keyless TUI snapshot owns the visible selector frame.
