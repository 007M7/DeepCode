# Session Query

The provider-neutral retrieval seam over live and optionally persisted sessions. The [package contract](../../packages/session-query/session-query) owns resolution, lifecycle, synchronization, and error behavior; this page catalogs the public data exchanged by callers, extractors, and search providers.

Source: [`packages/session-query/session-query/src/types.ts`](../../packages/session-query/session-query/src/types.ts)

## Logical records and filters

`SessionRecord` exposes source availability independently from its live-preferred header. `SessionEventRecord` classifies every raw event against the folded surface.

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

Filters are serializable discriminated specs. Each spec is one transform in a chain; the literal types below are shared by in-memory filtering and provider pre-ranking requests.

```ts type-equiv
export interface SessionQueryRange {
  from?: number
  to?: number
}
```

```ts type-equiv
export type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | { kind: 'created-at'; range: SessionQueryRange }
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly ('live' | 'persisted')[] }
```

```ts type-equiv
export type SessionEventResultFilter =
  | { kind: 'seq'; range: SessionQueryRange }
  | { kind: 'time'; range: SessionQueryRange }
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] }
```

## Search requests and pages

Both scopes use the same opaque-cursor page envelope. Session hits carry exactly one best event; event hits add only a plain-text snippet to the lightweight record.

```ts type-equiv
export interface SessionQueryExecContext {
  readonly signal?: AbortSignal
}
```

```ts type-equiv
export type SessionSearchProviderStatus =
  | { readonly available: true }
  | { readonly available: false; readonly reason: 'misconfigured' | 'unavailable' }
```

```ts type-equiv
export interface SessionSearchPageRequest {
  limit?: number
  cursor?: string
}
```

```ts type-equiv
export interface SessionSearchRequest extends SessionSearchPageRequest {
  query: string
  sessionFilters?: readonly SessionResultFilter[]
  eventFilters?: readonly SessionEventResultFilter[]
}
```

```ts type-equiv
export interface SessionEventSearchRequest extends SessionSearchPageRequest {
  sessionId: SessionId
  query: string
  filters?: readonly SessionEventResultFilter[]
}
```

The service resolves caller requests before crossing the provider seam, so provider implementations always receive a validated page limit.

```ts type-equiv
export interface SessionSearchSpec extends SessionSearchRequest {
  limit: number
}
```

```ts type-equiv
export interface SessionEventSearchSpec extends SessionEventSearchRequest {
  limit: number
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

```ts type-equiv
export interface SessionSearchPage<T> {
  providerId: string
  items: readonly T[]
  nextCursor?: string
}
```

## Errors

The service exposes a closed machine-routable error taxonomy; messages and causes provide detail but do not add codes.

```ts type-equiv
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_DUPLICATE_EXTRACTOR'
  | 'SESSION_QUERY_DUPLICATE_PROVIDER'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_EXTRACTOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_PROVIDER_AMBIGUOUS'
  | 'SESSION_QUERY_PROVIDER_CONFIGURED_MISSING'
  | 'SESSION_QUERY_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'SESSION_QUERY_PROVIDER_ERROR'
  | 'SESSION_QUERY_PROVIDER_UNAVAILABLE'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_SOURCE_CONFLICT'
```

## Event reads and traces

An event read returns the full target plus a bounded raw-log window. Trace records retain lightweight seq links so callers choose which related event bodies to read.

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
  session: SessionRecord
  target: SessionEvent
  events: SessionEvent[]
  startSeq: number
  endSeq: number
}
```

```ts type-equiv
export interface SessionLineageNode {
  session: SessionRecord
  children: SessionLineageNode[]
}
```

```ts type-equiv
export interface SessionLineageTrace {
  target: SessionRecord
  parents: SessionRecord[]
  root?: SessionRecord
  unresolvedParentId?: SessionId
  children: SessionLineageNode[]
}
```

```ts type-equiv
export interface SessionEventTrace {
  target: SessionEventRecord
  shadowedBy?: number
  replacementChain: number[]
  shadows: number[]
  references: number[]
  referencedBy: number[]
}
```

## Extraction and provider synchronization

Custom extractors are keyed by declaration-merged event or content discriminants and carry stable cache-invalidation versions. Providers receive complete event documents grouped into independently replaceable persisted and live snapshots.

```ts type-equiv
export interface SessionEventTextExtractor<K extends SessionEventType = SessionEventType> {
  version: string
  extract(event: SessionEvent<K>): readonly string[]
}
```

```ts type-equiv
export interface SessionContentTextExtractor<K extends ContentBlockType = ContentBlockType> {
  version: string
  extract(block: ContentBlockMap[K]): readonly string[]
}
```

```ts type-equiv
export interface SessionIndexDocument extends SessionEventRecord {
  text: string
}
```

```ts type-equiv
export interface SessionIndexSnapshot {
  session: SessionRecord
  fingerprint: string
  documents: readonly SessionIndexDocument[]
}
```

```ts type-equiv
export interface SessionPersistedIndexEntry {
  sessionId: SessionId
  fingerprint: string
}
```

```ts type-equiv
export interface SessionSearchProvider {
  readonly id: string
  status(): SessionSearchProviderStatus
  persistedInventory(): Promise<readonly SessionPersistedIndexEntry[]>
  setPersistedActive(active: boolean): Promise<void>
  replacePersisted(snapshot: SessionIndexSnapshot): Promise<void>
  removePersisted(sessionId: SessionId): Promise<void>
  replaceLive(snapshot: SessionIndexSnapshot): Promise<void>
  removeLive(sessionId: SessionId): Promise<void>
  searchSessions(request: SessionSearchSpec, exec?: SessionQueryExecContext): Promise<SessionSearchPage<SessionSearchHit>>
  searchEvents(request: SessionEventSearchSpec, exec?: SessionQueryExecContext): Promise<SessionSearchPage<SessionEventSearchHit>>
}
```
