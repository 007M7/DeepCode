# RFC: Session surface — a linked list over the event log for LLM message derivation

Status: implemented

## Problem

The event log is authoritative, but history manipulation had no durable shared mechanism. Plugins such as compaction would otherwise rewrite derived requests through order-sensitive listeners, leave no provenance, and require repeated changes to `deriveMessages()`.

## Decision

Add a **surface** — a derived, cached linked list of "surface nodes" (the subset of events that produce LLM messages) — maintained by `surfaceOp` markers in the event log.

### Two new top-level fields on `SessionEvent`

Every `SessionEvent` gains two optional fields (structural metadata, like `seq`/`time`):

- **`sourceEventSeqs?: number[]`** — seq numbers of events that are provenance sources (e.g., the `assistant/chunk` seqs that built an `assistant/message`, or the surface nodes shadowed by a compaction marker). Provenance is a core design principle; without it, the replace-range operation cannot be validated on replay.
- **`surfaceOp?: SurfaceOp`** — how this event entered the surface. Absent for non-surface events.

### SurfaceOp: two operations

```ts
export type SurfaceOp =
  | 'append'                                    // normal tail append
  | { op: 'replace'; start: number; end: number }  // shadow [start, end] inclusive
```

1. **Append** — add a new node to the tail. Used by `user/message`, `assistant/message`, `tool/result`, `context/message`, `steering/message`. The loop passes `surfaceOp: 'append'` on all such appends, and `sourceEventSeqs` where applicable (e.g., `assistant/message` records its `assistant/chunk` sources; `tool/result` records its `tool/call` source).

2. **Replace** — remove nodes from `start` through `end` (both inclusive) and insert a new node in their place. Both `start` and `end` must be valid surface node seqs in the current surface; `start === end` replaces a single node. The node's `sourceEventSeqs` must contain every shadowed surface node. The shadowed events remain in the log but are no longer on the surface.

### SurfaceManager: delta-based, not full rebuild

A `SurfaceManager` class (private to `Session`) maintains the cached linked list. It tracks `_lastProcessedSeq` and processes only the **delta** (new events since the last access) rather than rescanning the entire log. Because the log is append-only, prior events never change; a seeded log is simply the initial delta folded on first access.

Delta processing is O(1) when no new events and O(new events) when new events arrive.

`deriveMessages()` uses the surface when surface markers exist, falling back to the existing linear scan for sessions without markers (backward compatibility).

### Persistence

The new fields are serialized as top-level JSON properties. The JSONL backend requires zero changes — `JSON.stringify`/`JSON.parse` preserve everything transparently. The SQLite backend's `events` table carries two nullable TEXT columns (`source_event_seqs`, `surface_op`). The on-disk `SCHEMA_VERSION` is bumped to reflect the column set, and — per the pre-release bump-and-reject policy — a database written by any other build is REJECTED on open rather than migrated (there is no persisted user data to upgrade). The session format `version` is pinned at `SESSION_FORMAT_VERSION = 0` (the "unstable / pre-release" stance): the optional surface fields are absorbed without bumping it.

### Crash recovery

The `repair.ts` module synthesizes `tool/result` closers for orphaned tool calls after a crash. These closers carry `surfaceOp: 'append'` and `sourceEventSeqs` pointing to the orphaned `tool/call` event, so the rehydrated surface is valid.

### Invariants

The dev-mode invariants plugin validates: `sourceEventSeqs` references (non-empty, no duplicates, references earlier events, references known seqs) and `surfaceOp` (replace `start ≤ end`, both endpoints are on the tracked surface, the range is non-reversed in surface position, and `sourceEventSeqs` includes every node the range shadows).

Every surface-eligible event must carry `surfaceOp` or it would disappear from derived history. Typed `append` overloads enforce this for literal event types; runtime checks in `append` and the seed constructor cover widened unions and loaded logs. Invalid seeds are rejected rather than upgraded under the pre-release format policy.

## Alternatives considered

- **Per-plugin `agent/request` wrapping** (the pre-surface pattern for history manipulation) — listener-ordering fragility, no durable record of what was changed, and every new manipulation forces another change to core `deriveMessages()`.
- **Half-open `[start, endExclusive)` replace ranges** — rejected: the surface is a doubly-linked list whose ends are naturally named by node seqs, and single-node replacement (`start === end`) reads naturally with inclusive semantics.
- **Full rebuild behind a dirty flag** instead of delta processing — O(N²) over a session's lifetime: every single-event append would rescan all prior events.

## Consequences

- **`packages/core/session`**: New `surface.ts` (`SurfaceManager`), new types (`SurfaceOp`, `SurfaceIntent`), new fields on `SessionEvent`, modified `append()` (third required `SurfaceIntent` param), refactored `deriveMessages()` (walks the surface as the sole derivation path), surface-aware `repair.ts`. The seed constructor rejects a surface-eligible seed event missing its `surfaceOp` marker (see § Invariants).
- **`packages/core/agent-loop`**: All surface-capable appends pass surface opts. Chunk seqs are collected for `assistant/message` provenance; `tool/call` seqs are captured for `tool/result` provenance.
- **`packages/session-persistence/session-persistence-sqlite`**: Two new nullable TEXT columns (`source_event_seqs`, `surface_op`) on the `events` table; `SCHEMA_VERSION` bumped (bump-and-reject, no migration).
- **`packages/support/invariants`**: Surface-related validation rules.
- **`packages/session-persistence/session-persistence-jsonl`**: No changes required.
- **`packages/session-persistence/session-persistence`**: Abstract interface unchanged.

The surface is the foundation for future history manipulation. A compaction or tool-result-prune plugin appends one of the existing message-producing event types (a `user/message` carrying the summary, say) with `surfaceOp: { op: 'replace', start, end }` and `sourceEventSeqs` covering the shadowed nodes — the new node takes the range's place on the surface while the plugin's own trace events (e.g. `compaction/start`, `compaction/end`) stay off it. Replay preserves the decision deterministically.
