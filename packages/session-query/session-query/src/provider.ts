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
  chain: Promise<void>
  liveIds: Set<SessionId>
}

/** Coordinates one selected provider against live and persisted corpus layers. */
export class SessionProviderCoordinator {
  private readonly _configuredProviderId: string | undefined
  private readonly _defaultLimit: number
  private readonly _maxLimit: number
  private readonly _providers = new Map<string, ProviderState>()

  constructor(
    config: Required<Pick<Config, 'defaultLimit' | 'maxLimit'>> & Pick<Config, 'searchProvider'>,
    private readonly _corpus: () => SessionCorpus,
    private readonly _extractors: SessionTextExtractors,
  ) {
    this._configuredProviderId = config.searchProvider
    this._defaultLimit = config.defaultLimit
    this._maxLimit = config.maxLimit
  }

  /**
   * Register one effect-scoped provider.
   * @param ctx - contributing caller context.
   * @param provider - provider implementation.
   * @returns async disposer that deselects immediately and drains accepted work.
   */
  register(ctx: Context, provider: SessionSearchProvider): () => Promise<void> {
    if (this._providers.has(provider.id)) {
      throw new SessionQueryError(`a session-query provider with id "${provider.id}" is already registered`, 'SESSION_QUERY_DUPLICATE_PROVIDER')
    }
    const state: ProviderState = {
      provider,
      chain: Promise.resolve(),
      liveIds: new Set(),
    }
    const dispose = ctx.effect(function* (this: SessionProviderCoordinator) {
      this._providers.set(provider.id, state)
      yield async () => {
        this._providers.delete(provider.id)
        await state.chain
      }
    }.bind(this), 'sessionQuery.registerSearchProvider()')
    return async () => { await dispose() }
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
    const work = this._runFullSearch(state, undefined, async () => {
      if (exec?.signal?.aborted) throw aborted()
      const result = await state.provider.searchSessions(normalized, exec)
      return this._validateSearchPage(state, result, normalized.limit)
    })
    return waitFor(work, exec?.signal)
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
    const query = async (): Promise<SessionSearchPage<SessionEventSearchHit>> => {
      if (exec?.signal?.aborted) throw aborted()
      const result = await state.provider.searchEvents(normalized, exec)
      return this._validateSearchPage(state, result, normalized.limit)
    }
    const live = this._corpus().getLive(request.sessionId)
    let work: Promise<SessionSearchPage<SessionEventSearchHit>>
    if (live !== undefined) {
      work = this._runLiveSearch(state, live, query)
    } else {
      work = this._runFullSearch(state, request.sessionId, query)
    }
    return waitFor(work, exec?.signal)
  }

  private _runFullSearch<T>(
    state: ProviderState,
    requiredSessionId: SessionId | undefined,
    query: () => Promise<T>,
  ): Promise<T> {
    const liveSessions = this._corpus().listLive()
    return this._serialize(state, async () => {
      await this._synchronize(state, async () => {
        const persistence = await this._corpus().persistenceView()
        const missingRequired = requiredSessionId !== undefined
          && (persistence === undefined || !persistence.headers.some(header => header.id === requiredSessionId))
        if (missingRequired) {
          throw new SessionQueryError(`session "${requiredSessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
        }
        if (persistence === undefined) {
          await state.provider.setPersistedActive(false)
        } else {
          await this._syncPersisted(state, persistence)
        }
        await this._replaceLiveCorpus(state, liveSessions)
      })
      return query()
    })
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

  private _runLiveSearch<T>(state: ProviderState, session: Session, query: () => Promise<T>): Promise<T> {
    let snapshot: ReturnType<SessionTextExtractors['buildSnapshot']>
    try {
      snapshot = this._snapshotLive(session)
    } catch (error: unknown) {
      return Promise.reject(this._synchronizationError(state, error))
    }
    return this._serialize(state, async () => {
      await this._synchronize(state, async () => {
        await state.provider.replaceLive(snapshot)
        state.liveIds.add(session.id)
      })
      return query()
    })
  }

  private _snapshotLive(session: Session): ReturnType<SessionTextExtractors['buildSnapshot']> {
    return this._extractors.buildSnapshot(this._corpus().snapshotLive(session))
  }

  /** Serialize reconciliation and its provider query as one stable transaction. */
  private _serialize<T>(state: ProviderState, operation: () => Promise<T>): Promise<T> {
    const next = state.chain.then(operation, operation)
    state.chain = next.then(() => undefined, () => undefined)
    return next
  }

  /** Translate only derived-index update failures, never provider query failures. */
  private async _synchronize(state: ProviderState, operation: () => Promise<void>): Promise<void> {
    try {
      await operation()
    } catch (error: unknown) {
      throw this._synchronizationError(state, error)
    }
  }

  private _synchronizationError(state: ProviderState, error: unknown): SessionQueryError {
    /* v8 ignore next -- service-created typed synchronization errors pass through unchanged */
    if (error instanceof SessionQueryError) return error
    return new SessionQueryError(`session-query provider "${state.provider.id}" synchronization failed: ${errorMessage(error)}`, 'SESSION_QUERY_INDEX_FAILED', { cause: error })
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
  const observed = work.catch((error: unknown) => { throw operationError(error) })
  if (signal === undefined) return observed
  if (signal.aborted) {
    // Cancellation supersedes the caller's result, but shared work must still
    // have a rejection observer when it has already failed synchronously.
    void observed.catch((_supersededError: unknown) => undefined)
    return Promise.reject(aborted())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(aborted()) }
    signal.addEventListener('abort', onAbort, { once: true })
    observed.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(operationError(error))
      },
    )
  })
}

function operationError(error: unknown): Error {
  if (error instanceof Error) return error
  return new SessionQueryError('session-query operation failed with a non-Error rejection', 'SESSION_QUERY_PROVIDER_ERROR', { cause: error })
}

function aborted(): SessionQueryError {
  return new SessionQueryError('session-query operation aborted', 'SESSION_QUERY_ABORTED')
}

function errorMessage(error: unknown): string {
  /* v8 ignore next -- provider update contracts reject Error instances */
  return error instanceof Error ? error.message : 'unknown error'
}
