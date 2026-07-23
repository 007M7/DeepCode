/**
 * ConversationService implementation: scope-addressed send/cancel, view
 * registry with a uSES read face, and the empty-state startSession chain.
 * Contract: api-contracts v3 section 7. Selection/draft state moved to the
 * declared chat store (slot terminal design §4) — the per-scope store maps,
 * lazy construction, and prune bookkeeping this service used to carry are
 * retired; what remains is the send/stop orchestration face.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with scopeOf (same mechanism as the host tool
 * registry). Mutable state lives in plain objects reached by one property
 * read — field assignment through the tracker's shadow proxy is off-limits,
 * as are `#` hard-private fields.
 */
import { Service } from 'cordis'
import type { Context } from 'cordis'
// Value import MUST use the /client subpath: only that specifier is in the
// bundle externals (CLIENT_EXTERNALS), so it resolves to the shared runtime
// module at load time. A bare-specifier value import gets INLINED as a second
// module instance whose private scope-tag Symbol never matches the one
// SessionsService tags contexts with — scopeOf then always returns undefined
// in the browser while unit tests (single-instance path resolution) stay green.
import { scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { Session, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { ViewEntry, ViewId } from './index.ts'

/** Mutable view-registry cell (plain object: mutation never crosses the tracker proxy). */
interface ViewsState {
  entries: Map<string, ViewEntry>
  /** Sorted projection cache; null = rebuild on next read. */
  cache: readonly ViewEntry[] | null
  tick: number
  listeners: Set<() => void>
}

/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
export class ConversationService extends Service {
  private readonly viewsState: ViewsState = {
    entries: new Map(), cache: null, tick: 0, listeners: new Set(),
  }

  /**
   * @param ctx - owning root context (the plugin apply context; the service
   * registers itself and follows that fiber's lifetime).
   */
  constructor(ctx: Context) {
    super(ctx, 'conversation')
  }

  /**
   * Send a prompt into the scoped session. Business failures also land in the
   * session snapshot's promptError (object-layer surface); the rejection here
   * exists for caller choreography (the composer restores the draft on it).
   * @param text - prompt text, sent verbatim as one text block.
   * @param mode - queue after the current turn, or steer into it.
   */
  async send(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const session = this.scopedSession('send')
    const result = await session.prompt([{ type: 'text', text }], mode)
    if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
  }

  /** Cancel the scoped session's in-flight turn (failures land in promptError and reject, as in send). */
  async cancel(): Promise<void> {
    const session = this.scopedSession('cancel')
    const result = await session.cancel()
    if (!result.ok) throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Register a conversation view. Duplicate ids throw; the registration is an
   * effect on the caller's fiber (plugin unload collects it).
   * @param entry - the view entry.
   * @returns disposer removing the view.
   */
  registerView<Id extends ViewId>(entry: ViewEntry<Id>): () => void {
    const views = this.viewsState
    const dispose = this.ctx.effect(() => {
      if (views.entries.has(entry.id)) {
        throw new Error(`conversation view "${entry.id}" is already registered`)
      }
      views.entries.set(entry.id, entry)
      bumpViews(views)
      return () => {
        views.entries.delete(entry.id)
        bumpViews(views)
      }
    }, 'conversation.registerView()')
    // The effect disposer settles asynchronously; the registry face stays a
    // synchronous fire-and-forget disposer.
    return () => { void dispose() }
  }

  /**
   * Registered views ordered by `order` (ties keep registration sequence).
   * Stable array reference between mutations (uSES getSnapshot source).
   * @returns the view entries.
   */
  views(): readonly ViewEntry[] {
    const state = this.viewsState
    state.cache ??= [...state.entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    return state.cache
  }

  /**
   * Subscribe to view registry changes (synchronous, like the toolview registry).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribeViews(fn: () => void): () => void {
    const { listeners } = this.viewsState
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  /**
   * Monotonic view registry version for uSES pairing.
   * @returns current version.
   */
  viewsVersion(): number {
    return this.viewsState.tick
  }

  /**
   * Empty-state first-send chain (root-context method; does not read scope):
   * create the session, navigate to it, then send through the new scope.
   * The create → open ordering is safe: the manager merges the new summary
   * synchronously before create() resolves, so the list store is projected by
   * the time open() validates against it (manager notification batching is
   * microtask-based; SessionsService projects on the same flush that create
   * awaited through the RPC round trip).
   * @param opts - project directory, prompt text, and send mode.
   */
  async startSession(opts: { cwd?: string; text: string; mode: 'queue' | 'steer' }): Promise<void> {
    const sessions = this.requireSessions()
    const id = await sessions.create(opts.cwd === undefined ? {} : { cwd: opts.cwd })
    // The manager notifier flushes per microtask; one await guarantees the
    // list-store projection landed before sessions.open validates against it.
    await Promise.resolve()
    sessions.open(id)
    const scoped = sessions.scope(id)
    if (scoped === undefined) throw new Error(`conversation.startSession: created session "${id}" resolved no scope`)
    // ctx.get, not scoped.conversation: property access walks the fiber
    // topology (a scope fiber never injects services), while get reads the
    // global store and still binds this service to the scoped ctx.
    const scopedConversation = scoped.get('conversation')
    if (scopedConversation === undefined) throw new Error('conversation.startSession: conversation service unavailable through the new scope')
    await scopedConversation.send(opts.text, opts.mode)
  }

  /** Resolve the caller scope's Session or throw on root contexts. */
  private scopedSession(op: string): Session {
    const id = scopeOf(this.ctx)
    if (id === undefined) {
      throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`)
    }
    return this.requireSessions().manager.get(id)
  }

  private requireSessions(): SessionsService {
    // ctx.get instead of ctx.sessions: the typed Context merge is suspended
    // while the client/host `sessions` declaration collision awaits
    // arbitration (see the runtime package's Context merge note).
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('conversation: sessions service unavailable')
    return sessions
  }
}

function bumpViews(state: ViewsState): void {
  state.cache = null
  state.tick += 1
  for (const fn of [...state.listeners]) fn()
}
