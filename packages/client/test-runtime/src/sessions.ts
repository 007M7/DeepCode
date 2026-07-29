/** Test-owned sessions face: the SlotsService host contract over declarative fixtures. */
import type { Context } from 'cordis'
import { createScope, scopeOf, SessionProvideChannel } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, ISessions, ObservableSnapshot, ProjectionsFace, SessionFace, SessionId,
  SessionListState, SessionProvideDescriptor, SessionSummary, SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, SessionMaybeProvideInfo, SessionProvideInfo } from '@deepseek-ai/dsh-client-ui-slots'
import { conversationSnapshot } from './fixtures.ts'
import type { SessionFixture, Stabilizer } from './fixtures.ts'

/**
 * The fixture-backed session face: conversation reads delegate to the
 * fixture's snapshot store; ISession verbs are fail-loud stubs unless the
 * fixture supplies them (the runtime never fakes behavior a test did not
 * declare — an unstubbed call names itself instead of half-working). Extra
 * fixture methods are grafted verbatim for feature-side casts.
 */
export class FixtureSession implements SessionFace {
  /**
   * The useProjection seat: identity-stable per-key faces over the fixture's
   * projection values (set via {@link TestSessions.setProjection}).
   */
  readonly projections: ProjectionsFace & { set(key: string, value: unknown): void }

  /**
   * @param sessionId - host identity (branded view of the fixture id).
   * @param store - conversation snapshot store (updateSnapshot writes it).
   * @param overrides - fixture-declared behavior face, grafted over the stubs.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly store: SnapshotStore<ConversationSnapshot>,
    overrides: Record<string, unknown>,
  ) {
    const values = new Map<string, unknown>()
    const listeners = new Map<string, Set<() => void>>()
    const faces = new Map<string, ObservableSnapshot<unknown>>()
    this.projections = {
      faceOf: (key: string) => {
        let face = faces.get(key)
        if (face === undefined) {
          face = {
            getSnapshot: () => values.get(key),
            subscribe: (fn: () => void) => {
              const set = listeners.get(key) ?? new Set()
              set.add(fn)
              listeners.set(key, set)
              return () => { set.delete(fn) }
            },
          }
          faces.set(key, face)
        }
        return face
      },
      set: (key: string, value: unknown) => {
        values.set(key, value)
        for (const fn of [...(listeners.get(key) ?? [])]) fn()
      },
    }
    Object.assign(this, overrides)
  }

  /** @returns the fixture conversation snapshot (useSession read side). */
  getSnapshot(): ConversationSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * Subscribe to fixture snapshot changes.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void {
    return this.store.subscribe(fn)
  }

  /**
   * Fail-loud stub; supply `prompt` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  prompt(): never {
    throw new Error(`test session "${this.sessionId}": prompt is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Fail-loud stub; supply `cancel` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  cancel(): never {
    throw new Error(`test session "${this.sessionId}": cancel is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Fail-loud stub; supply `command` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  command(): never {
    throw new Error(`test session "${this.sessionId}": command is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Fail-loud stub; supply `loadOlder` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  loadOlder(): never {
    throw new Error(`test session "${this.sessionId}": loadOlder is not stubbed — supply it on the fixture's session face`)
  }

}

/** One live test session: fixture-derived stores plus its minted scope state. */
interface SessionRecord {
  summary: SessionSummary
  snapshot: SnapshotStore<ConversationSnapshot>
  session: FixtureSession
  scope: Context | undefined
  scopeFiber: { dispose(): Promise<void> } | undefined
  /** Materialized standard-props bundle (identity-stable per session; invalidated on roster change). */
  provideInfo: SessionProvideInfo | undefined
}

/** Test binding shape handed to provider resolvers and feature injects (a SessionBinding whose session is the fixture face). */
export interface TestSessionBinding {
  readonly sessionId: SessionId
  readonly session: FixtureSession
  readonly ctx: Context
}

/**
 * Sessions test double behind the renderer host and feature injects: owns the
 * list/current observable, the standard-props provide channel (the runtime's
 * `useSession` contribution included), scope minting through the production
 * `createScope`, and the session behavior face supplied per fixture.
 *
 * Implements the same ISessions face features receive as `ctx.sessions`, so
 * a production face change breaks this double at compile time; the extra
 * members (add/updateSnapshot/setCurrent/remove/behavior/calls and the
 * legacy provideInfo/maybeProvideInfo lookups) are bench-only surface.
 */
export class TestSessions implements ISessions {
  /** The useSessions standard feed (list rows + current selection). */
  readonly list: SnapshotStore<SessionListState>
  /**
   * Atomic current-session provide projection (production SessionsService
   * mirror): selection changes and provider-roster changes publish through
   * this one source — the member the SlotsService host face hands the
   * renderer's SessionProvider.
   */
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>
  private readonly records = new Map<SessionId, SessionRecord>()
  /** The production provide channel (roster, materialization rules, current projection) — no test-side mirror. */
  private readonly channel: SessionProvideChannel

  /** Calls observed on the service-level face (open/clear), newest last. */
  readonly calls: { method: 'open' | 'clear'; args: unknown[] }[] = []

  /**
   * @param stabilize - the owning runtime's act wrapper.
   * @param rootCtx - the runtime's Cordis root; scope fibers mount under it.
   */
  constructor(private readonly stabilize: Stabilizer, private readonly rootCtx: Context) {
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, current: undefined, phase: 'ready',
    })
    this.channel = new SessionProvideChannel({
      rebuildBundles: () => {
        for (const record of this.records.values()) {
          if (record.provideInfo !== undefined) {
            record.provideInfo = this.channel.materializeInfo(this.bindingOf(record.session.sessionId, record))
          }
        }
      },
      resolveCurrent: () => this.maybeProvideInfo(this.list.getSnapshot().current),
    })
    this.currentProvideInfo = this.channel.currentProvideInfo
    // The projection follows every current write, as in production.
    this.list.subscribe(() => { this.channel.publishCurrent() })
  }

  /**
   * Add a session from a fixture and (by default) make it current.
   * @param fixture - identity + snapshot/summary overrides + behavior face.
   * @param opts - pass `current: false` to add without selecting.
   * @returns the stable session id (branded view of `fixture.id`).
   */
  async add(fixture: SessionFixture, opts?: { current?: boolean }): Promise<SessionId> {
    const id = fixture.id as SessionId
    if (this.records.has(id)) throw new Error(`test session "${id}" already added`)
    const summary: SessionSummary = {
      id,
      displayTitle: fixture.id,
      running: false,
      waitingApproval: false,
      blank: false,
      updatedAt: this.records.size + 1,
      ...fixture.summary,
    }
    const snapshot = createSnapshotStore<ConversationSnapshot>({
      ...conversationSnapshot(id),
      ...fixture.snapshot,
    })
    this.records.set(id, {
      summary,
      snapshot,
      session: new FixtureSession(id, snapshot, fixture.session ?? {}),
      scope: undefined,
      scopeFiber: undefined,
      provideInfo: undefined,
    })
    await this.stabilize(() => {
      this.list.update((draft) => {
        draft.ids.push(id)
        draft.byId[id] = summary
        if (opts?.current !== false) draft.current = id
      })
    })
    return id
  }

  /**
   * Update a session's conversation snapshot through an immer draft (the
   * live-stream stand-in: components subscribed via useSession re-render).
   * @param id - session id.
   * @param mutate - draft mutator.
   */
  async updateSnapshot(id: string, mutate: (draft: ConversationSnapshot) => void): Promise<void> {
    const record = this.require(id)
    await this.stabilize(() => { record.snapshot.update(mutate) })
  }

  /**
   * Switch the current selection (undefined = the no-session empty state).
   * @param id - session id to select, or undefined to clear.
   */
  async setCurrent(id: string | undefined): Promise<void> {
    if (id !== undefined) this.require(id)
    await this.stabilize(() => {
      this.list.update((draft) => { draft.current = id as SessionId | undefined })
    })
  }

  /**
   * Remove a session: list row, scope fiber, and per-session store instances
   * (with persisted state) die together — the same single lifecycle axis the
   * production SessionsService drives on session death, minus staging.
   * @param id - session id.
   */
  async remove(id: string): Promise<void> {
    const record = this.require(id)
    this.records.delete(id as SessionId)
    await this.stabilize(async () => {
      this.list.update((draft) => {
        draft.ids = draft.ids.filter(existing => existing !== id)
        const { [id as SessionId]: _dead, ...rest } = draft.byId
        draft.byId = rest
        if (draft.current === id) draft.current = undefined
      })
      if (record.scopeFiber !== undefined) await record.scopeFiber.dispose()
      this.rootCtx.get('slots')?.pruneStoreScope(id)
    })
  }

  /**
   * Register a per-session standard-props provider (production `provide`
   * contract: hooks become `use<Name>` selector hooks on the render side,
   * props spread verbatim; duplicate names fail loud at materialization).
   * @param descriptor - static member roster plus per-session resolver.
   * @returns disposer removing the provider.
   */
  provide(descriptor: SessionProvideDescriptor): () => void {
    return this.channel.provide(descriptor)
  }

  /**
   * Resolve the definite per-session standard-props bundle (host face member).
   * @param id - session id.
   * @returns the identity-stable bundle, or undefined for unknown sessions.
   */
  provideInfo(id: string): SessionProvideInfo | undefined {
    const record = this.records.get(id as SessionId)
    if (record === undefined) return undefined
    record.provideInfo ??= this.channel.materializeInfo(this.bindingOf(id as SessionId, record))
    return record.provideInfo
  }

  /**
   * Resolve the current-session-optional standard kit (host face member):
   * unknown or absent ids return the static no-session projection.
   * @param id - current session id, when selected.
   * @returns a definite or no-session provide bundle.
   */
  maybeProvideInfo(id: string | undefined): SessionMaybeProvideInfo {
    return (id === undefined ? undefined : this.provideInfo(id)) ?? this.channel.maybeInfo
  }

  /**
   * Resolve (mint on first touch) the session-scoped Cordis context through
   * the production `createScope`, so real `scopeOf`/scope-addressed services
   * resolve it.
   * @param id - session id.
   * @returns the scoped context, or undefined for unknown sessions.
   */
  scope(id: string): Context | undefined {
    const record = this.records.get(id as SessionId)
    if (record === undefined) return undefined
    if (record.scope === undefined) {
      const handle = createScope(this.rootCtx, id as SessionId)
      record.scope = handle.ctx
      record.scopeFiber = handle.fiber
    }
    return record.scope
  }

  /**
   * Session assembly binding (inject factories and provide resolvers receive it).
   * @param id - session id.
   * @returns sessionId + behavior face + scoped ctx, or undefined when unknown.
   */
  binding(id: string): TestSessionBinding | undefined {
    const record = this.records.get(id as SessionId)
    if (record === undefined) return undefined
    return this.bindingOf(id as SessionId, record)
  }

  /**
   * Read the session scope tag off a context (service-method seam mirror).
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined {
    return scopeOf(ctx)
  }

  /**
   * Resolve the scoped session face off a context (production `sessionOf`
   * mirror).
   * @param ctx - any client context.
   * @returns the fixture session face, or undefined off-scope.
   */
  sessionOf(ctx: Context): SessionFace | undefined {
    const id = scopeOf(ctx)
    if (id === undefined) return undefined
    return this.records.get(id)?.session
  }

  /**
   * Service-level selection call (recorded, then applied to the list store
   * synchronously — inject callbacks call this outside any act window; the
   * store notify is microtask-batched so the next stabilized step observes it).
   * @param id - session id.
   */
  open(id: SessionId): void {
    this.calls.push({ method: 'open', args: [id] })
    this.require(id)
    this.list.update((draft) => { draft.current = id })
  }

  /** Clear the current selection (recorded; the production no-session flow). */
  clear(): void {
    this.calls.push({ method: 'clear', args: [] })
    this.list.update((draft) => { draft.current = undefined })
  }

  /**
   * The session face of a fixture (typed view for assertions; fixture
   * behavior methods are grafted onto it).
   * @param id - session id.
   * @returns the FixtureSession the binding and provide channel carry.
   */
  behavior(id: string): FixtureSession {
    return this.require(id).session
  }

  /** Dispose minted scope fibers (runtime dispose path). */
  async disposeScopes(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.scopeFiber !== undefined) {
        await record.scopeFiber.dispose()
        record.scope = undefined
        record.scopeFiber = undefined
      }
    }
  }

  private bindingOf(id: SessionId, record: SessionRecord): TestSessionBinding {
    const ctx = this.scope(id)
    /* v8 ignore next 2 -- bindingOf only runs for a live record, whose scope
     * always resolves; kept so a future caller cannot mint a ctx-less binding. */
    if (ctx === undefined) throw new Error(`test session "${id}" resolved no scope`)
    return { sessionId: id, session: record.session, ctx }
  }

  private require(id: string): SessionRecord {
    const record = this.records.get(id as SessionId)
    if (record === undefined) throw new Error(`test session "${id}" is not added`)
    return record
  }
}
