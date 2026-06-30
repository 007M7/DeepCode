# RFC: Session fork service

Status: implemented (proposed 2026-06-30, accepted 2026-06-30)

## Context

The event-sourced session log already has the primitive a fork needs: create a new session with a seed event prefix, then derive model history from that seeded log exactly as replay does. That primitive is intentionally low-level. It lives on `dsh-session` as `ctx.sessions.create(id, { seed })`, while durable metadata such as `parentSession` and `seedLength` is stored on the out-of-log `SessionHeader` introduced by [session persistence](../../implemented/architecture/2026-06-14-session-persistence.md). The same mechanics already support in-process subagent fork children and replay routing for forked child logs.

What is missing is a reusable product service for ordinary session forking. Putting that directly on `dsh-session` would make a derived workflow part of the core log API, even though the core session package should stay focused on append-only storage, derived history, and lifecycle events. The harness architecture prefers optional capability plugins over widening the core spine; [event-sourced sessions](../../implemented/architecture/2026-06-11-event-sourced-sessions.md) provide the log semantics, and [capability seams](../../implemented/architecture/2026-06-13-capability-seams.md) provide the extension pattern.

The main semantic hazard is the fork boundary. A session event log is only a valid seed when it is contiguous and balanced. Forking inside an active turn would copy an open `turn/start`, possibly an open `step/start`, and possibly dangling tool calls. That violates the turn-enclosure and provider-transcript invariants, and it creates a misleading child history that appears to have participated in an unfinished parent turn. The existing [subagent seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md) deliberately solves a different problem: a tool-triggered subagent fork usually happens while the parent turn is open, so `dsh-subagent-fork` clips the seed to the parent's last completed-turn prefix. A general session fork should not silently clip; it should reject attempts made away from a boundary.

## Decision

The shipped design adds an optional product package, `@deepseek-ai/dsh-session-fork`, under `packages/session-fork/session-fork`. It registers `ctx.sessionFork` and depends only on `cordis` plus the `dsh-session` vocabulary/service. No new session event types, persistence methods, ACP methods, agent-loop hooks, or subagent behavior are added in the first cut.

The service exposes two operations:

```ts ignore-check
type SessionForkSource = Session | SessionId

interface SessionForkSeed {
  source: Session
  seed: SessionEvent[]
  meta: {
    parentSession: SessionId
    seedLength: number
    cwd?: string
  }
}

interface ForkSessionOptions {
  source: SessionForkSource
  sessionId?: SessionId
}

class SessionForkService extends Service {
  snapshot(source: SessionForkSource): SessionForkSeed
  fork(options: ForkSessionOptions): Session
}
```

`snapshot()` is the reusable half. It resolves only live sessions from `ctx.sessions`; v1 does not load unloaded persisted sessions by id. It validates the source is at a turn boundary, deep-clones the source events, and returns the seed plus metadata a caller can pass to a later session or agent creation path. This shape keeps the fork computation reusable for future ACP or agent-facing consumers without coupling this service to `ctx.agents`.

`fork()` is the convenience half. It calls `snapshot()`, then creates a live child session via `ctx.sessions.create(sessionId, { seed, meta })`. The child inherits the source session's `cwd`, stamps `parentSession` to the source id, and sets `seedLength` to the seeded prefix length. When `sessionId` is omitted, `SessionStore` generates one using its existing id policy.

The boundary rule is structural: an empty source log is forkable, and any source whose last event is `turn/end` is forkable regardless of the turn-end reason (`completed`, `aborted`, `error`, `disposed`, `max-tokens`, `interrupted`, or a future merge-extensible reason). Any non-empty source whose last event is not `turn/end` is inside a turn or otherwise not at the boundary and is rejected with a typed `SessionForkError` code. The service also classifies non-live source ids (`SESSION_NOT_FOUND`), stale `Session` object references whose id is live on a different instance (`SESSION_NOT_LIVE`), and duplicate requested child ids (`SESSION_ALREADY_EXISTS`) instead of leaking raw store errors. This is intentionally stricter than `dsh-subagent-fork`, whose completed-prefix clipping remains unchanged because it serves tool-time delegation rather than user/session branching.

## Consequences

The feature is a small capability seam rather than a change to `dsh-session`: the core log keeps its low-level seed primitive, while `dsh-session-fork` owns policy, error taxonomy, and convenience creation. Persistence continues to work through existing `session/created` and `session/flush` behavior: a forked child starts life with seeded events, so existing backends persist that seed once and preserve `parentSession` / `seedLength` in the header.

The v1 scope deliberately excludes ACP `session/fork`, unloaded persisted-session forking, model-facing tools, and subagent refactors. Those can consume `snapshot()` later. If a future ACP method is added, it should advertise the capability only after it has transcript/snapshot coverage; this RFC adds no editor-facing updates, so no ACP snapshot is required now. Fork-child replay remains covered by the existing [seed-boundary testing RFC](../../implemented/testing/2026-06-22-fork-child-replay-seed-boundary.md), while this service gets focused unit tests plus one persistence integration test.
