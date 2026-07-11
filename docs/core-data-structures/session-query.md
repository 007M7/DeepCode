# Session Query

Exact reads over the live-preferred logical session corpus. The [package contract](../../packages/session-query/session-query) owns source precedence, dynamic optional persistence, cloning, surface classification, bounded windows, and typed failures. Full-text search is a separate proposed SQLite phase.

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

## Errors

The closed code union distinguishes request validation, missing targets, malformed surface logs, optional-backend failure, and contradictory source metadata.

```ts type-equiv
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_SOURCE_CONFLICT'
```
