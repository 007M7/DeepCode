# Session Query

Exact reads and relationship traces over the live-preferred logical session corpus. The [package contract](../../packages/session-query/session-query) owns source precedence, dynamic optional persistence, cloning, surface classification, bounded windows, tracing validation, and typed failures. Full-text search is a separate proposed SQLite package.

Source: [`packages/session-query/session-query/src/types.ts`](../../packages/session-query/session-query/src/types.ts)

## Logical records

`SessionRecord` is returned by the cross-corpus list. It exposes source availability independently from the cloned live-preferred header. `SessionEventRecord` is a lightweight raw-log projection; classification uses the same `foldSurface()` transitions as model-history derivation.

```ts type-equiv
export type SessionEventSurface = 'current' | 'shadowed' | 'log-only'
```

```ts type-equiv
export interface SessionRecord {
  header: SessionHeader
  live: boolean
  persisted: boolean
}
```

```ts type-equiv
export interface SessionEventRecord {
  sessionId: SessionId
  seq: number
  type: SessionEventType
  time: number
  surface: SessionEventSurface
}
```

## Session lineage

`SessionLineageTrace` carries known parents in immediate-to-outward order and a forest of recursively nested direct descendants. The completeness discriminant makes a known root and a missing parent mutually exclusive.

```ts type-equiv
export interface SessionLineageNode {
  session: SessionRecord
  descendants: SessionLineageNode[]
}
```

```ts type-equiv
export type SessionLineageTrace = {
  target: SessionRecord
  ancestors: SessionRecord[]
  descendants: SessionLineageNode[]
} & (
  | {
    complete: true
    root: SessionRecord
  }
  | {
    complete: false
    unresolvedParentId: SessionId
  }
)
```

## Bounded event reads

The request addresses one raw seq and optional neighboring counts. The result carries a `SessionHeader` rather than availability flags so a known live target can remain independent of persistence health.

```ts type-equiv
export interface SessionEventReadRequest {
  sessionId: SessionId
  seq: number
  before?: number
  after?: number
}
```

```ts type-equiv
export interface SessionEventWindow {
  session: SessionHeader
  target: SessionEvent
  events: SessionEvent[]
  startSeq: number
  endSeq: number
}
```

## Event relationships

Event traces distinguish positional surface replacement from logged provenance. Every seq list contains direct links except `replacementChain`, which follows immediate replacers from the target to the final positional replacement.

```ts type-equiv
export interface SessionEventTraceRequest {
  sessionId: SessionId
  seq: number
}
```

```ts type-equiv
export interface SessionEventTrace {
  target: SessionEventRecord
  replacedBy?: number
  replacementChain: number[]
  replacedEventSeqs: number[]
  sourceEventSeqs: number[]
  derivedEventSeqs: number[]
}
```

## Errors

The closed code union distinguishes request validation, missing targets, malformed surface logs, optional-backend failure, and contradictory source metadata.

```ts type-equiv
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_SOURCE_CONFLICT'
```
