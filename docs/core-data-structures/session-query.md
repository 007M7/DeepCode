# Session Query

Exact reads and relationship traces over the live-preferred logical session corpus. The [package contract](../../packages/session-query/session-query) owns source precedence, dynamic optional persistence, cloning, surface classification, bounded windows, tracing validation, and typed failures. Full-text search is a separate proposed SQLite package.

Source: [`packages/session-query/session-query/src/types.ts`](../../packages/session-query/session-query/src/types.ts)

## Logical records

`SessionRecord` is returned by the cross-corpus list. It exposes source availability independently from the cloned live-preferred header. `SessionEventRecord` is a lightweight raw-log projection; classification uses the same `foldSurface()` transitions as model-history derivation.

```ts type-equiv
/** Whether an event is current model context, replaced context, or raw-log-only. */
type SessionEventSurface = 'current' | 'shadowed' | 'log-only'
```

```ts type-equiv
/** Lightweight identity and source availability for one logical session. */
interface SessionRecord {
  /** Cloned session header selected from the live-preferred corpus. */
  header: SessionHeader
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean
  /** Whether the active persistence backend currently materializes the id. */
  persisted: boolean
}
```

```ts type-equiv
/** Lightweight metadata for one event within a logical session. */
interface SessionEventRecord {
  /** Session that owns the event. */
  sessionId: SessionId
  /** Monotonic event seq within the session. */
  seq: number
  /** Discriminant of the session event. */
  type: SessionEventType
  /** Event timestamp in Unix epoch milliseconds. */
  time: number
  /** Event placement in the folded session surface. */
  surface: SessionEventSurface
}
```

## Session lineage

`SessionLineageTrace` carries known parents in immediate-to-outward order and a forest of recursively nested direct descendants. The completeness discriminant makes a known root and a missing parent mutually exclusive.

```ts type-equiv
/** Recursive descendant node in a session-lineage trace. */
interface SessionLineageNode {
  /** Detached logical-corpus record for this descendant. */
  session: SessionRecord
  /** Direct children, each carrying its own recursive descendants. */
  descendants: SessionLineageNode[]
}
```

```ts type-equiv
/** Known ancestry and descendants for one logical session. */
type SessionLineageTrace = {
  /** Detached record for the session that was traced. */
  target: SessionRecord
  /** Known parents from the immediate parent outward. */
  ancestors: SessionRecord[]
  /** Complete known descendant trees rooted at the target's direct children. */
  descendants: SessionLineageNode[]
} & (
  | {
    /** The complete parent chain is present in the logical corpus. */
    complete: true
    /** Detached record at the top of the complete lineage. */
    root: SessionRecord
  }
  | {
    /** The parent chain leaves the visible logical corpus. */
    complete: false
    /** First parent id that is not present in the logical corpus. */
    unresolvedParentId: SessionId
  }
)
```

## Bounded event reads

The request addresses one raw seq and optional neighboring counts. The result carries a `SessionHeader` rather than availability flags so a known live target can remain independent of persistence health.

```ts type-equiv
/** Request for one event plus raw neighboring log context. */
interface SessionEventReadRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: number
  /** Number of preceding raw events to include. */
  before?: number
  /** Number of following raw events to include. */
  after?: number
}
```

```ts type-equiv
/** Full target event and a bounded raw-log window. */
interface SessionEventWindow {
  /** Cloned header for the live-preferred source read. */
  session: SessionHeader
  /** Full cloned target event. */
  target: SessionEvent
  /** Full cloned events from `startSeq` through `endSeq`. */
  events: SessionEvent[]
  /** First seq included in `events`. */
  startSeq: number
  /** Last seq included in `events`. */
  endSeq: number
}
```

## Event relationships

Event traces distinguish positional surface replacement from logged provenance. Every seq list contains direct links except `replacementChain`, which follows immediate replacers from the target to the final positional replacement.

```ts type-equiv
/** Request for direct surface and provenance relationships around one event. */
interface SessionEventTraceRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: number
}
```

```ts type-equiv
/** Direct surface and provenance relationships for one event. */
interface SessionEventTrace {
  /** Lightweight target record. */
  target: SessionEventRecord
  /** Immediate positional replacement event, when the target was shadowed. */
  replacedBy?: number
  /** Positional replacers from the immediate replacement to the final replacement. */
  replacementChain: number[]
  /** Surface nodes directly removed when the target itself performed a replacement. */
  replacedEventSeqs: number[]
  /** Direct logged provenance sources in their recorded order. */
  sourceEventSeqs: number[]
  /** Later events that directly name the target as a provenance source, in log order. */
  derivedEventSeqs: number[]
}
```

## Errors

The closed code union distinguishes request validation, missing targets, malformed surface logs, optional-backend failure, and contradictory source metadata.

```ts type-equiv
/** Stable machine-routable failure taxonomy for exact session reads and traces. */
type SessionQueryErrorCode =
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_SOURCE_CONFLICT'
```
