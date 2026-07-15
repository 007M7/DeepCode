# Session Query

Query vocabulary over the live-preferred logical session corpus. The [interface package](../../packages/session-query/session-query) owns exact reads, source precedence, semantic extraction and provider-independent filters, while the [SQLite package](../../packages/session-query/session-query-sqlite) owns the concrete full-text index lifecycle.

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

## Provider-independent filters and documents

Session and event filter arrays are ANDed; values inside one list clause are ORed. Ranges are inclusive. The event `text` clause is a literal Unicode case-insensitive, whitespace-flexible regular-expression scan over extracted semantic text, independent of full-text providers.

```ts type-equiv
export type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange)
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] }
```

```ts type-equiv
export type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange)
  | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] }
  | { kind: 'text'; text: string }
```

```ts type-equiv
export interface SessionEventSearchDocument extends SessionEventRecord {
  text: string
}
```

`ctx.sessionQuery.filterSessions(filters)` applies `SessionResultFilter` to the complete logical corpus; `ctx.sessionQuery.filterEvents(sessionId, filters)` returns matching documents in ascending seq order. Messages, reasoning, tool calls/results, blocked prompts, todos, and failure/status detail contribute semantic text; structural events and stream chunks do not.

## Full-text search pages

The independent `ctx.sessionSearch` seam has two scopes. `searchSessions()` groups the corpus by strongest matching event; `searchEvents()` searches one session. Requests bind an opaque cursor to the normalized query, metadata filters, and limit. The event text scan is intentionally absent from provider metadata filters.

```ts type-equiv
export type SessionSearchCursor = Branded<'SessionSearchCursor'>
```

```ts type-equiv
export interface SessionSearchRequest {
  query: string
  sessionFilters?: readonly SessionResultFilter[]
  eventFilters?: readonly SessionEventMetadataFilter[]
  limit?: number
  cursor?: SessionSearchCursor
}
```

```ts type-equiv
export interface SessionEventSearchRequest {
  sessionId: SessionId
  query: string
  filters?: readonly SessionEventMetadataFilter[]
  limit?: number
  cursor?: SessionSearchCursor
}
```

```ts type-equiv
export interface SessionSearchPage<T> {
  items: readonly T[]
  nextCursor?: SessionSearchCursor
}
```

```ts type-equiv
export interface SessionEventSearchHit extends SessionEventRecord {
  snippet: string
}
```

```ts type-equiv
export interface SessionSearchHit extends SessionRecord {
  bestMatch: SessionEventSearchHit
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
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_CURSOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_STALE_CURSOR'
  | 'SESSION_QUERY_SOURCE_CONFLICT'
```
