# RFC: SessionStore fork helpers

Status: implemented

## Problem

The event-sourced session log already has the primitive a fork needs: create a new session with a seed event prefix, then derive model history from that seeded log exactly as replay does. That primitive is intentionally low-level: `ctx.sessions.create(id, { seed, meta })` accepts any valid seed, but ordinary live-session branching needs policy around where the seed may be taken, which metadata is stamped on the child, and how errors are classified.

The semantic hazard is the fork boundary. A session event log is only a valid user-visible fork seed when it is contiguous and balanced. Forking inside an active turn would copy an open `turn/start`, possibly an open `step/start`, and possibly dangling tool calls. That violates the turn-enclosure and provider-transcript invariants, and it creates a misleading child history that appears to have participated in an unfinished parent turn. The existing [subagent seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md) deliberately solves a different problem: a tool-triggered subagent fork usually happens while the parent turn is open, so `dsh-subagent-fork` clips the seed to the parent's last completed-turn prefix. A general session fork should not silently clip; it should reject attempts made away from a boundary.

## Decision

`dsh-session` owns ordinary live-session fork helpers directly on `ctx.sessions`. There is no separate `dsh-session-fork` package or `ctx.sessionFork` service: the helpers have no independent backend, event vocabulary, lifecycle, or persistence behavior, and all durable work delegates to the existing session store and persistence backends.

The store exposes two operations:

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

class SessionStore extends Service {
  snapshot(source: SessionForkSource): SessionForkSeed
  fork(options: ForkSessionOptions): Session
}
```

`snapshot()` is the reusable half. It resolves only live sessions from `ctx.sessions`; v1 does not load unloaded persisted sessions by id. It validates the source is at a turn boundary, deep-clones the source events, and returns the seed plus metadata a caller can pass to a later session or agent creation path. This keeps the fork computation reusable for future ACP or agent-facing consumers without coupling `dsh-session` to `ctx.agents`.

`fork()` is the convenience half. It calls `snapshot()`, then creates a live child session via `ctx.sessions.create(sessionId, { seed, meta })`. The child inherits the source session's `cwd`, stamps `parentSession` to the source id, and sets `seedLength` to the seeded prefix length. When `sessionId` is omitted, `SessionStore` generates one using its existing id policy.

The boundary rule is structural: an empty source log is forkable, and any source whose last event is `turn/end` is forkable regardless of the turn-end reason (`completed`, `aborted`, `error`, `disposed`, `max-tokens`, `interrupted`, or a future merge-extensible reason). Any non-empty source whose last event is not `turn/end` is inside a turn or otherwise not at the boundary and is rejected with a typed `SessionForkError` code. The helpers also classify non-live source ids (`SESSION_NOT_FOUND`), stale `Session` object references whose id is live on a different instance (`SESSION_NOT_LIVE`), and duplicate requested child ids (`SESSION_ALREADY_EXISTS`) instead of leaking lower-level store errors.

## Alternatives considered

**Separate `ctx.sessionFork` service.** This was the first implementation, but review showed it overfit the capability-seam pattern. The code had no swappable backend, no extra event surface, no independent ownership lifecycle, and no durable behavior beyond `ctx.sessions.create({ seed, meta })`. Keeping a separate package would make callers discover and install a second service just to perform policy around a session-store primitive.

**Only expose `fork()`.** A one-function API is simpler for immediate child-session creation, but it forces callers that need a seed for another creation path to create a detached child session just to get the seed. `snapshot()` keeps the seed/metadata computation reusable without importing `ctx.agents` into `dsh-session`; `fork()` remains the simple one-call convenience.

**Silently clip open turns to the last completed boundary.** That is correct for `dsh-subagent-fork`, where delegation often starts while the parent turn is open and the child should inherit only the completed prefix. It is wrong for ordinary user/session branching because it hides that the requested fork point was not actually a valid boundary and silently drops the parent turn tail.

## Consequences

The public surface stays small and discoverable: live session branching is part of `ctx.sessions`, next to `create({ seed })`, rather than a standalone service. Persistence continues to work through existing `session/created` and `session/flush` behavior: a forked child starts life with seeded events, so existing backends persist that seed once and preserve `parentSession` / `seedLength` in the header.

The v1 scope still excludes ACP `session/fork`, unloaded persisted-session forking, model-facing tools, and subagent refactors. Those can consume `snapshot()` later. If a future ACP method is added, it should advertise the capability only after it has transcript/snapshot coverage; this RFC adds no editor-facing updates, so no ACP snapshot is required now. Fork-child replay remains covered by the existing [seed-boundary testing RFC](../../implemented/testing/2026-06-22-fork-child-replay-seed-boundary.md), while these helpers get focused `dsh-session` unit tests plus JSONL persistence coverage.
