# Session Fork

The session fork service is an optional capability over the core session store. It does not add new log events or persisted record shapes; it packages the existing seed primitive into a safe service with a turn-boundary policy.

Package: [`@deepseek-ai/dsh-session-fork`](../../packages/session-fork/session-fork) (`ctx.sessionFork`). The decision and rationale are recorded in [the session fork service RFC](../rfc/implemented/feature/2026-06-30-session-fork-service.md).

## Service Shape

`SessionForkService.snapshot(source)` accepts a live `Session` object or live `SessionId`, validates the source log is empty or ends at `turn/end`, then returns the resolved source, a deep-cloned `SessionEvent[]` seed, and child metadata: `parentSession`, `seedLength`, and optional inherited `cwd`.

`SessionForkService.fork({ source, sessionId? })` is a convenience wrapper around `ctx.sessions.create(sessionId, { seed, meta })`. Consumers that create agents can use `snapshot()` directly and pass the returned seed/meta through the agent factory instead of creating a detached session first.

## Boundary Policy

The boundary rule is structural: every `turn/end` reason is forkable, and every non-empty log whose last event is not `turn/end` is rejected. This is intentionally stricter than the subagent fork backend, which clips to the parent's last completed-turn prefix because it is usually invoked from inside the parent's active tool turn.

## Persistence

No persistence method is added. A forked child is just a normal live session with seed events already present at creation time, so existing persistence backends persist the inherited prefix and header metadata through `session/created` and `session/flush`.
