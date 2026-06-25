# RFC: Session surface — a linked list over the event log for LLM message derivation

Status: implemented (accepted 2026-06-18)

## Context

The `Session` event log is the single source of truth ([event-sourced sessions](2026-06-11-event-sourced-sessions.md)), but the only view over it was `deriveMessages()` — a linear scan that filtered and transformed raw events into `Message[]`. This creates problems for session-history-manipulating plugins (compaction, tool-call result pruning, etc.). Without a central mechanism, each plugin would need to wrap `agent/request` to rewrite the message list — a pattern that suffers from listener-ordering fragility, provides no durable record of what was changed, and forces repeated changes to the core `deriveMessages()` whenever a new manipulation is added. A central hub in the `session` package, with a provenance-recording mechanism and enough flexibility for future plugins to manipulate session history through a stable API, lays a solid foundation for plugin development.

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

The both-ends-inclusive design was chosen over half-open `[start, endExclusive)` because the surface is a doubly-linked list — both ends are naturally named by node seqs, and single-node replacement (`start === end`) is a common case that reads naturally with inclusive semantics.

### SurfaceManager: delta-based, not full rebuild

A `SurfaceManager` class (private to `Session`) maintains the cached linked list. It tracks `_lastProcessedSeq` and processes only the **delta** (new events since the last access) rather than rescanning the entire log. Because the log is append-only, prior events never change — full rebuild is only needed after a wholesale log replacement (e.g., seeding).

Why delta processing? The naive approach (a dirty flag + full rebuild on every access) would be O(N²) over a session's lifetime — every single-event append triggers a complete scan of all prior events. Delta processing is O(1) when no new events and O(new events) when new events arrive.

`deriveMessages()` uses the surface when surface markers exist, falling back to the existing linear scan for sessions without markers (backward compatibility).

### Persistence

The new fields are serialized as top-level JSON properties. The JSONL backend requires zero changes — `JSON.stringify`/`JSON.parse` preserve everything transparently. The SQLite backend's `events` table carries two nullable TEXT columns (`source_event_seqs`, `surface_op`). The on-disk `SCHEMA_VERSION` is bumped to reflect the column set, and — per the pre-release bump-and-reject policy — a database written by any other build is REJECTED on open rather than migrated (there is no persisted user data to upgrade). The session format `version` is pinned at `SESSION_FORMAT_VERSION = 0` (the "unstable / pre-release" stance): the optional surface fields are absorbed without bumping it.

### Crash recovery

The `repair.ts` module synthesizes `tool/result` closers for orphaned tool calls after a crash. These closers carry `surfaceOp: 'append'` and `sourceEventSeqs` pointing to the orphaned `tool/call` event, so the rehydrated surface is valid.

### Invariants

The dev-mode invariants plugin validates: `sourceEventSeqs` references (non-empty, no duplicates, references earlier events, references known seqs) and `surfaceOp` (replace `start ≤ end`, both endpoints are on the tracked surface, the range is non-reversed in surface position, and `sourceEventSeqs` includes every node the range shadows).

Because the surface is the SOLE derivation path, a surface-eligible event that carries no `surfaceOp` marker is invisible to `deriveMessages()` — it would land in the log yet silently drop from history on resume/fork. `append`'s typed overload makes the marker mandatory for `SurfaceEventType` events at compile time, but only when the type argument is a SPECIFIC literal; when it widens to the `SessionEventType` union (a caller iterating raw events, e.g. `for (const e of log) append(e.type, e.data)`) the conditional rest collapses to optional and the compiler stops enforcing it. The marker requirement is therefore ALSO checked at runtime in two places: `append` itself throws on a marker-less surface-eligible event (covering the union-widening loophole), and the `Session` seed constructor re-checks the same invariant (alongside its seq-contiguity and JSON-serializability checks) so a seed/load/fork — which arrives as raw `SessionEvent[]`, bypassing `append` — is REJECTED rather than constructing a session that resumes with missing history. (No backward-compat path for surface-less logs: per the pre-release stance there is no persisted user data to preserve, so such a log is rejected, not upgraded.)

## Consequences

- **`packages/core/session`**: New `surface.ts` (`SurfaceManager`), new types (`SurfaceOp`, `SurfaceIntent`), new fields on `SessionEvent`, modified `append()` (third required `SurfaceIntent` param), refactored `deriveMessages()` (walks the surface as the sole derivation path), surface-aware `repair.ts`. The seed constructor rejects a surface-eligible seed event missing its `surfaceOp` marker (see § Invariants).
- **`packages/core/agent-loop`**: All surface-capable appends pass surface opts. Chunk seqs are collected for `assistant/message` provenance; `tool/call` seqs are captured for `tool/result` provenance.
- **`packages/session-persistence/session-persistence-sqlite`**: Two new nullable TEXT columns (`source_event_seqs`, `surface_op`) on the `events` table; `SCHEMA_VERSION` bumped (bump-and-reject, no migration).
- **`packages/support/invariants`**: Surface-related validation rules.
- **`packages/session-persistence/session-persistence-jsonl`**: No changes required.
- **`packages/session-persistence/session-persistence`**: Abstract interface unchanged.

The surface is the foundation for future history manipulation. A compaction or tool-result-prune plugin appends one of the existing message-producing event types (a `user/message` carrying the summary, say) with `surfaceOp: { op: 'replace', start, end }` and `sourceEventSeqs` covering the shadowed nodes — the new node takes the range's place on the surface while the plugin's own trace events (e.g. `compaction/start`, `compaction/end`) stay off it. Replay preserves the decision deterministically.
