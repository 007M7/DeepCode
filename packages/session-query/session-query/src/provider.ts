/** Search-provider selection, synchronization, pagination, and cancellation. */

import type { Context } from 'cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionTextExtractors } from './extraction.ts'
import type { PersistenceView, SessionCorpus } from './corpus.ts'
import type {
  SessionEventRecord,
  SessionEventSearchHit,
  SessionEventSearchRequest,
  SessionEventSearchSpec,
  SessionQueryExecContext,
  SessionRecord,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchProvider,
  SessionSearchRequest,
  SessionSearchSpec,
} from './types.ts'
import type { Config } from './config.ts'
import { SessionQueryError } from './config.ts'
import { filterEventResults, filterSessionResults } from './filters.ts'

interface ProviderState {
  provider: SessionSearchProvider
  active: boolean
  chain: Promise<void>
  liveIds: Set<SessionId>
  fullSync: FullSync | undefined
  liveSync: Map<SessionId, Promise<void>>
}

interface FullSync {
  liveKey: string
  promise: Promise<void>
}

/** Coordinates one selected provider against live and persisted corpus layers. */
export class SessionProviderCoordinator {
  private readonly _configuredProviderId: string | undefined
  private readonly _defaultLimit: number
  private readonly _maxLimit: number
  private readonly _providers = new Map<string, ProviderState>()

  constructor(
    private readonly _ctx: Context,
    config: Required<Pick<Config, 'defaultLimit' | 'maxLimit'>> & Pick<Config, 'searchProvider'>,
    private readonly _corpus: () => SessionCorpus,
    private readonly _extractors: SessionTextExtractors,
  ) {
    this._configuredProviderId = config.searchProvider
    this._defaultLimit = config.defaultLimit
    this._maxLimit = config.maxLimit
    _ctx.on('session/created', (session) => { this.invalidateLive(session.id) })
    _ctx.on('session/event', (session) => { this.invalidateLive(session.id) })
    _ctx.on('session/removed', (header) => { this.invalidateLive(header.id) })
  }

  /**
   * Register one effect-scoped provider.
   * @param ctx - contributing caller context.
   * @param provider - provider implementation.
   * @returns disposer for the registration.
   */
  register(ctx: Context, provider: SessionSearchProvider): () => void {
    if (this._providers.has(provider.id)) {
      throw new SessionQueryError(`a session-query provider with id "${provider.id}" is already registered`, 'SESSION_QUERY_DUPLICATE_PROVIDER')
    }
    const state: ProviderState = {
      provider,
      active: true,
      chain: Promise.resolve(),
      liveIds: new Set(),
      fullSync: undefined,
      liveSync: new Map(),
    }
    const dispose = ctx.effect(function* (this: SessionProviderCoordinator) {
      this._providers.set(provider.id, state)
      void this._enqueue(state, () => provider.setPersistedActive(false)).catch((error: unknown) => {
        this._ctx.logger.warn(`session-query provider "${provider.id}" failed initial deactivation: ${String(error)}`)
      })
      yield () => {
        state.active = false
        this._providers.delete(provider.id)
      }
    }.bind(this), 'sessionQuery.registerSearchProvider()')
    return () => void dispose()
  }

  /**
   * Search and group the complete logical corpus.
   * @param request - normalized provider-neutral request input.
   * @param exec - optional cancellation controls.
   * @returns ranked session page.
   */
  async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionQueryExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    const state = this._resolveProvider()
    const normalized = this._normalizeSessionSearch(request)
    await waitFor(this._syncAll(state), exec?.signal)
    const result = await waitFor(state.provider.searchSessions(normalized, exec), exec?.signal)
    return this._validateSearchPage(state, result, normalized.limit)
  }

  /**
   * Search events within one logical session.
   * @param request - target and provider-neutral request input.
   * @param exec - optional cancellation controls.
   * @returns ranked event page.
   */
  async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionQueryExecContext,
  ): Promise<SessionSearchPage<SessionEventSearchHit>> {
    const state = this._resolveProvider()
    const normalized = this._normalizeEventSearch(request)
    const live = this._corpus().getLive(request.sessionId)
    if (live !== undefined) {
      await waitFor(this._syncLive(state, live), exec?.signal)
    } else {
      const persistence = await this._corpus().persistenceView()
      if (persistence === undefined || !persistence.headers.some(header => header.id === request.sessionId)) {
        throw new SessionQueryError(`session "${request.sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
      }
      await waitFor(this._syncAll(state), exec?.signal)
    }
    const result = await waitFor(state.provider.searchEvents(normalized, exec), exec?.signal)
    return this._validateSearchPage(state, result, normalized.limit)
  }

  /**
   * Invalidate provider synchronization after one live source change.
   * @param sessionId - changed live session.
   */
  invalidateLive(sessionId: SessionId): void {
    for (const state of this._providers.values()) {
      state.fullSync = undefined
      state.liveSync.delete(sessionId)
    }
  }

  /** Invalidate all source/extractor-derived provider snapshots. */
  invalidateAll(): void {
    for (const state of this._providers.values()) {
      state.fullSync = undefined
      state.liveSync.clear()
    }
  }

  /**
   * React to persistence mount, inventory change, or unmount.
   * @param active - whether canonical persistence remains mounted.
   */
  persistenceChanged(active: boolean): void {
    for (const state of this._providers.values()) state.fullSync = undefined
    if (active) return
    for (const state of this._providers.values()) {
      void this._enqueue(state, () => state.provider.setPersistedActive(false)).catch((error: unknown) => {
        this._ctx.logger.warn(`session-query provider "${state.provider.id}" failed persistence deactivation: ${String(error)}`)
      })
    }
  }

  private _syncAll(state: ProviderState): Promise<void> {
    // Capture the direct source before awaiting: only searches that observed
    // the same live corpus may share an in-flight full synchronization.
    const liveSessions = this._corpus().listLive()
    const liveKey = JSON.stringify(liveSessions.map(session => this._snapshotLive(session)).map(snapshot => [
      snapshot.session.header.id,
      snapshot.fingerprint,
      snapshot.session.persisted,
    ]))
    if (state.fullSync?.liveKey === liveKey) return state.fullSync.promise
    const promise = this._enqueue(state, async () => {
      /* v8 ignore next -- a provider can be disposed while queued behind an in-flight update */
      if (!state.active) return
      const persistence = await this._corpus().persistenceView()
      if (persistence === undefined) {
        await state.provider.setPersistedActive(false)
      } else {
        await this._syncPersisted(state, persistence)
      }
      await this._replaceLiveCorpus(state, liveSessions)
    })
    const fullSync = { liveKey, promise }
    state.fullSync = fullSync
    void promise.finally(() => {
      /* v8 ignore next -- a newer invalidation may already own the sync slot */
      if (state.fullSync === fullSync) state.fullSync = undefined
    }).catch(() => undefined)
    return promise
  }

  private async _syncPersisted(state: ProviderState, persistence: PersistenceView): Promise<void> {
    await state.provider.setPersistedActive(false)
    const inventory = new Map((await state.provider.persistedInventory()).map(entry => [entry.sessionId, entry.fingerprint]))
    for (const header of persistence.headers) {
      const snapshot = this._extractors.buildSnapshot(await persistence.load(header.id))
      if (inventory.get(header.id) !== snapshot.fingerprint) await state.provider.replacePersisted(snapshot)
      inventory.delete(header.id)
    }
    for (const staleId of inventory.keys()) await state.provider.removePersisted(staleId)
    await state.provider.setPersistedActive(true)
  }

  private async _replaceLiveCorpus(state: ProviderState, sessions: readonly Session[]): Promise<void> {
    const liveIds = new Set(sessions.map(session => session.id))
    for (const staleId of state.liveIds) {
      if (!liveIds.has(staleId)) await state.provider.removeLive(staleId)
    }
    for (const session of sessions) {
      await state.provider.replaceLive(this._snapshotLive(session))
    }
    state.liveIds = liveIds
  }

  private _syncLive(state: ProviderState, session: Session): Promise<void> {
    const existing = state.liveSync.get(session.id)
    if (existing !== undefined) return existing
    const snapshot = this._snapshotLive(session)
    const promise = this._enqueue(state, async () => {
      /* v8 ignore next -- a provider can be disposed while queued behind an in-flight update */
      if (!state.active) return
      await state.provider.replaceLive(snapshot)
      state.liveIds.add(session.id)
    })
    state.liveSync.set(session.id, promise)
    void promise.finally(() => {
      /* v8 ignore next -- a newer invalidation may already own the target slot */
      if (state.liveSync.get(session.id) === promise) state.liveSync.delete(session.id)
    }).catch(() => undefined)
    return promise
  }

  private _snapshotLive(session: Session): ReturnType<SessionTextExtractors['buildSnapshot']> {
    return this._extractors.buildSnapshot(this._corpus().snapshotLive(session))
  }

  private _enqueue(state: ProviderState, operation: () => Promise<void>): Promise<void> {
    const next = state.chain.then(operation, operation)
    state.chain = next.then(() => undefined, () => undefined)
    return next.catch((error: unknown) => {
      /* v8 ignore next -- service-created typed synchronization errors pass through unchanged */
      if (error instanceof SessionQueryError) throw error
      throw new SessionQueryError(`session-query provider "${state.provider.id}" synchronization failed: ${errorMessage(error)}`, 'SESSION_QUERY_INDEX_FAILED', { cause: error })
    })
  }

  private _resolveProvider(): ProviderState {
    if (this._configuredProviderId !== undefined) {
      const state = this._providers.get(this._configuredProviderId)
      if (state === undefined) {
        throw new SessionQueryError(`configured session-query provider "${this._configuredProviderId}" is not registered`, 'SESSION_QUERY_PROVIDER_CONFIGURED_MISSING')
      }
      if (!state.provider.status().available) {
        throw new SessionQueryError(`configured session-query provider "${this._configuredProviderId}" is unavailable`, 'SESSION_QUERY_PROVIDER_CONFIGURED_UNAVAILABLE')
      }
      return state
    }
    const usable = [...this._providers.values()].filter(state => state.provider.status().available)
    const [single] = usable
    if (single === undefined) {
      throw new SessionQueryError('no usable session-query provider is registered', 'SESSION_QUERY_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      throw new SessionQueryError(`multiple usable session-query providers are registered (${usable.map(state => state.provider.id).join(', ')}); configure one explicitly`, 'SESSION_QUERY_PROVIDER_AMBIGUOUS')
    }
    return single
  }

  private _normalizeSessionSearch(request: SessionSearchRequest): SessionSearchSpec {
    const query = this._queryText(request.query)
    const limit = this._limitValue(request.limit)
    filterSessionResults<SessionRecord>([], request.sessionFilters ?? [])
    filterEventResults<SessionEventRecord>([], request.eventFilters ?? [])
    return { ...request, query, limit }
  }

  private _normalizeEventSearch(request: SessionEventSearchRequest): SessionEventSearchSpec {
    const query = this._queryText(request.query)
    const limit = this._limitValue(request.limit)
    filterEventResults<SessionEventRecord>([], request.filters ?? [])
    return { ...request, query, limit }
  }

  private _queryText(query: string): string {
    const normalized = query.trim()
    if (normalized.length === 0) {
      throw new SessionQueryError('session-query search text must not be blank', 'SESSION_QUERY_INVALID_QUERY')
    }
    return normalized
  }

  private _limitValue(limit: number | undefined): number {
    const value = limit ?? this._defaultLimit
    if (!Number.isInteger(value) || value < 1 || value > this._maxLimit) {
      throw new SessionQueryError(`session-query limit must be an integer between 1 and ${this._maxLimit}`, 'SESSION_QUERY_INVALID_LIMIT')
    }
    return value
  }

  private _validateSearchPage<T>(state: ProviderState, page: SessionSearchPage<T>, limit: number): SessionSearchPage<T> {
    if (page.providerId !== state.provider.id) {
      throw new SessionQueryError(`session-query provider "${state.provider.id}" returned providerId "${page.providerId}"`, 'SESSION_QUERY_PROVIDER_ERROR')
    }
    if (page.items.length > limit) {
      throw new SessionQueryError(`session-query provider "${state.provider.id}" returned ${page.items.length} items for limit ${limit}`, 'SESSION_QUERY_PROVIDER_ERROR')
    }
    return page
  }
}

function waitFor<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(aborted())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(aborted()) }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        /* v8 ignore next -- Promise contracts reject with Error; retain a typed boundary for third-party providers */
        reject(error instanceof Error
          ? error
          : new SessionQueryError('session-query operation failed with a non-Error rejection', 'SESSION_QUERY_PROVIDER_ERROR', { cause: error }))
      },
    )
  })
}

function aborted(): SessionQueryError {
  return new SessionQueryError('session-query operation aborted', 'SESSION_QUERY_ABORTED')
}

function errorMessage(error: unknown): string {
  /* v8 ignore next -- provider update contracts reject Error instances */
  return error instanceof Error ? error.message : 'unknown error'
}
