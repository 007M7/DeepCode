/**
 * Public vocabulary for the session-query retrieval service: lightweight
 * records, composable filters, traces, search requests/results, extractor
 * registrations, and the provider synchronization contract.
 *
 * @module @deepseek-ai/dsh-session-query/types
 */

import type { ContentBlockMap, ContentBlockType } from '@deepseek-ai/dsh-llm'
import type {
  SessionEvent,
  SessionEventType,
  SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session'

/** Whether an event is on the current surface, was replaced, or is log-only. */
export type SessionEventSurface = 'current' | 'shadowed' | 'log-only'

/** Lightweight identity and availability for one logical session. */
export interface SessionRecord {
  /** Cloned immutable session header selected from the live-preferred corpus. */
  header: SessionHeader
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean
  /** Whether the active persistence backend currently materializes the id. */
  persisted: boolean
}
/** Lightweight metadata for one event within a logical session. */
export interface SessionEventRecord {
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

/** Inclusive numeric range used by result and search filters. */
export interface SessionQueryRange {
  /** Inclusive lower bound. */
  from?: number
  /** Inclusive upper bound. */
  to?: number
}

/** Serializable filter applied to session records. */
export type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | { kind: 'created-at'; range: SessionQueryRange }
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly ('live' | 'persisted')[] }

/** Serializable filter applied to event records. */
export type SessionEventResultFilter =
  | { kind: 'seq'; range: SessionQueryRange }
  | { kind: 'time'; range: SessionQueryRange }
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] }

/** Caller cancellation threaded through synchronization and provider search. */
export interface SessionQueryExecContext {
  /** Abort signal for waiting and provider-owned query work. */
  readonly signal?: AbortSignal
}

/** Cheap local usability status returned by a search provider. */
export type SessionSearchProviderStatus =
  | { readonly available: true }
  | { readonly available: false; readonly reason: 'misconfigured' | 'unavailable' }

/** Common pagination fields accepted by both search scopes. */
export interface SessionSearchPageRequest {
  /** Maximum number of hits on this page. */
  limit?: number
  /** Opaque cursor returned by the same provider/request. */
  cursor?: string
}

/** Cross-session full-text request. */
export interface SessionSearchRequest extends SessionSearchPageRequest {
  /** Plain text query interpreted by the selected provider. */
  query: string
  /** Session metadata filters applied before event ranking/grouping. */
  sessionFilters?: readonly SessionResultFilter[]
  /** Event metadata filters applied before best-event grouping. */
  eventFilters?: readonly SessionEventResultFilter[]
}

/** Full-text request scoped to one session's events. */
export interface SessionEventSearchRequest extends SessionSearchPageRequest {
  /** Session whose events form the search corpus. */
  sessionId: SessionId
  /** Plain text query interpreted by the selected provider. */
  query: string
  /** Event metadata filters applied before ranking. */
  filters?: readonly SessionEventResultFilter[]
}

/** Provider-facing cross-session search spec after service normalization. */
export interface SessionSearchSpec extends SessionSearchRequest {
  /** Required page size validated and defaulted by the query service. */
  limit: number
}

/** Provider-facing event search spec after service normalization. */
export interface SessionEventSearchSpec extends SessionEventSearchRequest {
  /** Required page size validated and defaulted by the query service. */
  limit: number
}

/** One lightweight event search hit with provider-produced evidence text. */
export interface SessionEventSearchHit extends SessionEventRecord {
  /** Plain-text excerpt explaining the match. */
  snippet: string
}

/** One session-ranked search hit and its strongest matching event. */
export interface SessionSearchHit extends SessionRecord {
  /** Strongest matching event used as the session's ranking evidence. */
  bestMatch: SessionEventSearchHit
}

/** One provider-owned page of search results. */
export interface SessionSearchPage<T> {
  /** Stable id of the provider that produced this page. */
  providerId: string
  /** Ranked hits in deterministic provider order, no longer than the requested limit. */
  items: readonly T[]
  /** Opaque next-page cursor, absent when the result is exhausted. */
  nextCursor?: string
}

/** Request for one event plus raw neighboring log context. */
export interface SessionEventReadRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: number
  /** Number of preceding raw events to include. */
  before?: number
  /** Number of following raw events to include. */
  after?: number
}

/** Full target event and a bounded raw-log window. */
export interface SessionEventWindow {
  /** Logical session metadata at read time. */
  session: SessionRecord
  /** Full cloned target event. */
  target: SessionEvent
  /** Full cloned events from `startSeq` through `endSeq`. */
  events: SessionEvent[]
  /** First seq included in `events`. */
  startSeq: number
  /** Last seq included in `events`. */
  endSeq: number
}

/** Recursive child node in a session lineage trace. */
export interface SessionLineageNode {
  /** Session represented by this lineage node. */
  session: SessionRecord
  /** Direct children in deterministic creation order. */
  children: SessionLineageNode[]
}

/** Complete known lineage around one session. */
export interface SessionLineageTrace {
  /** Session that was traced. */
  target: SessionRecord
  /** Known parents from immediate parent outward. */
  parents: SessionRecord[]
  /** Root when the complete parent chain is available. */
  root?: SessionRecord
  /** First parent id outside the visible corpus, when the trace is partial. */
  unresolvedParentId?: SessionId
  /** Complete known descendant forest rooted at the target's direct children. */
  children: SessionLineageNode[]
}

/** Surface and provenance relationships for one event. */
export interface SessionEventTrace {
  /** Lightweight target record. */
  target: SessionEventRecord
  /** Immediate replacement event that shadowed the target. */
  shadowedBy?: number
  /** Replacement seqs from the target toward the current descendant. */
  replacementChain: number[]
  /** Surface nodes directly shadowed by the target replacement event. */
  shadows: number[]
  /** Direct provenance sources from `sourceEventSeqs`. */
  references: number[]
  /** Events that directly name the target in `sourceEventSeqs`. */
  referencedBy: number[]
}

/** Typed extractor for one declaration-merged session event type. */
export interface SessionEventTextExtractor<K extends SessionEventType = SessionEventType> {
  /** Stable cache-invalidation version chosen by the extractor owner. */
  version: string
  /**
   * Extract semantic searchable fragments from one event.
   * @param event - event narrowed to the registered type.
   * @returns plain-text fragments; blanks are discarded by the service.
   */
  extract(event: SessionEvent<K>): readonly string[]
}

/** Typed extractor for one declaration-merged content block type. */
export interface SessionContentTextExtractor<K extends ContentBlockType = ContentBlockType> {
  /** Stable cache-invalidation version chosen by the extractor owner. */
  version: string
  /**
   * Extract semantic searchable fragments from one content block.
   * @param block - block narrowed to the registered type.
   * @returns plain-text fragments; blanks are discarded by the service.
   */
  extract(block: ContentBlockMap[K]): readonly string[]
}

/** One provider-neutral event document produced by registered extractors. */
export interface SessionIndexDocument extends SessionEventRecord {
  /** Normalized newline-joined text indexed by a search provider. */
  text: string
}

/** One complete index layer for a live session or persisted checkpoint. */
export interface SessionIndexSnapshot {
  /** Layer metadata and live/persisted availability exposed in results. */
  session: SessionRecord
  /** Stable SHA-256 identity of canonical source data and extractor versions. */
  fingerprint: string
  /** Searchable event documents in seq order. */
  documents: readonly SessionIndexDocument[]
}

/** Durable provider inventory entry used to reuse unchanged persisted rows. */
export interface SessionPersistedIndexEntry {
  /** Persisted session id. */
  sessionId: SessionId
  /** Last indexed source/extractor fingerprint. */
  fingerprint: string
}

/** Search and synchronization backend registered into `ctx.sessionQuery`. */
export interface SessionSearchProvider {
  /** Stable provider id, unique within the query service. */
  readonly id: string
  /**
   * Return cheap local usability without performing index or search I/O.
   * @returns whether the provider can be selected.
   */
  status(): SessionSearchProviderStatus
  /**
   * Read reusable persisted-layer fingerprints from derived storage.
   * @returns durable inventory entries.
   */
  persistedInventory(): Promise<readonly SessionPersistedIndexEntry[]>
  /**
   * Hide or expose reconciled persisted rows without deleting their cache.
   * @param active - whether canonical persistence is mounted and reconciled.
   */
  setPersistedActive(active: boolean): Promise<void>
  /**
   * Atomically replace one persisted session's derived documents.
   * @param snapshot - canonical persisted checkpoint and fingerprint.
   */
  replacePersisted(snapshot: SessionIndexSnapshot): Promise<void>
  /**
   * Delete one durable derived entry after canonical reconciliation proves it absent.
   * @param sessionId - persisted id to remove.
   */
  removePersisted(sessionId: SessionId): Promise<void>
  /**
   * Replace one connection-local live override.
   * @param snapshot - current live snapshot and availability.
   */
  replaceLive(snapshot: SessionIndexSnapshot): Promise<void>
  /**
   * Drop one live override, revealing its active persisted base when present.
   * @param sessionId - live id to remove.
   */
  removeLive(sessionId: SessionId): Promise<void>
  /**
   * Search and group the complete logical corpus by session.
   * @param request - query, pre-ranking filters, and pagination.
   * @param exec - optional cancellation context.
   * @returns one ranked session page.
   */
  searchSessions(request: SessionSearchSpec, exec?: SessionQueryExecContext): Promise<SessionSearchPage<SessionSearchHit>>
  /**
   * Search events within one logical session.
   * @param request - target session, query, filters, and pagination.
   * @param exec - optional cancellation context.
   * @returns one ranked event page.
   */
  searchEvents(request: SessionEventSearchSpec, exec?: SessionQueryExecContext): Promise<SessionSearchPage<SessionEventSearchHit>>
}
