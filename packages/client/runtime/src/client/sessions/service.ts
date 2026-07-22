/**
 * SessionsService: root sessions service — list snapshot store (manager
 * projection; carries `current`, the persisted selection every
 * session-scoped surface keys off — migrated here from ui-layout per the
 * slot-parity design), session scope tree (mintScope pattern: no-op plugin
 * Fiber + ctx.extend scope tag), stable SessionBinding cache, ancestry walk.
 *
 * Scope lifecycle is watch-driven: a scope is minted lazily on first
 * resolution; a session leaving the list tears its scope down only when
 * nobody is watching it. "Watched" is approximated as the most recently
 * resolved binding id — SessionProvider re-resolves on every selection
 * change (keyed remount), so a switch away always re-evaluates the deferred
 * teardown; a host-side death without list removal keeps the scope (frozen
 * read-only view).
 */
import type { Context, Fiber } from 'cordis'
import type { IApiClient, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionCell } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '../store/index.ts'
import { createSnapshotStore } from '../store/index.ts'
import { SessionManager } from './manager.ts'
import type { Session } from './session.ts'

/** Session list row projected from the host list RPC plus live stream increments. */
export interface SessionSummary {
  id: SessionId
  title: string
  cwd?: string
  parentId?: SessionId
  running: boolean
  updatedAt: number
}

/**
 * Session list store shape. `current` rides the same snapshot (arbitrated:
 * the single useSessions standard hook reads list and selection together —
 * sidebar highlighting and SessionProvider share one fact source).
 */
export interface SessionListState { ids: SessionId[]; byId: Record<SessionId, SessionSummary>; current: SessionId | undefined }

/** Session assembly handle for SessionProvider/inject factories (identity-stable per session). */
export interface SessionBinding {
  readonly sessionId: SessionId
  readonly session: Session
  readonly ctx: Context
}

/** Scope tag key (client counterpart of the host dsh-scope pattern). */
const kScope = Symbol('dsh.client.scope')

/**
 * Read the session scope tag off a context.
 * @param ctx - any client context.
 * @returns the session id, or undefined on root contexts.
 */
export function scopeOf(ctx: Context): SessionId | undefined {
  return (ctx as Context & { [kScope]?: SessionId })[kScope]
}

/** Shared no-op plugin backing each session scope fiber. */
function sessionScope(): void {}

/**
 * Display title projection. The wire summary carries no title yet (P-I
 * ledger): the project directory's basename stands in, then the raw id.
 */
function titleOf(cwd: string | undefined, id: SessionId): string {
  if (cwd !== undefined && cwd !== '') {
    const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
    if (base !== undefined && base !== '') return base
  }
  return id
}

interface ScopeRecord {
  fiber: Fiber
  ctx: Context
  binding: SessionBinding
  /** Render-layer standard kit (identity-stable per scope; the renderer's per-cell caches key off it). */
  cell: SessionCell
}

/** Root sessions service: list store, current selection, object-layer manager, scope tree, bindings, ancestry. */
export class SessionsService {
  /** List snapshot store (list RPC + host stream increments; re-pulled on reconnect) — the useSessions standard feed, current included. */
  readonly list: SnapshotStore<SessionListState>
  /** The object-layer instance cluster and frame dispatch entry (wired to the connection by the runtime apply). */
  readonly manager: SessionManager

  /**
   * Persisted selection cell (the durable half of `list.current`). Private on
   * purpose: reads go through the list snapshot; writes through {@link
   * SessionsService.open}. Projection validates it against the live list
   * instead of destructively pruning, so a selection survives transient list
   * states (reconnect re-pull) and resurfaces when its session returns.
   */
  private readonly selection: SnapshotStore<{ sessionId?: SessionId }>

  private readonly scopes = new Map<SessionId, ScopeRecord>()
  /** Most recently resolved binding id — the watch approximation for deferred teardown. */
  private watched: SessionId | undefined
  /** Removed-while-watched sessions whose teardown waits for the watch to move away. */
  private readonly deferredRemovals = new Set<SessionId>()

  /**
   * @param ctx - client root context (scope fibers mount under it).
   * @param api - wire client shared with every Session.
   */
  constructor(private readonly rootCtx: Context, api: IApiClient) {
    this.manager = new SessionManager(api)
    this.selection = createSnapshotStore<{ sessionId?: SessionId }>(
      {},
      { persist: { name: 'dsh.sessions.current' } })
    this.list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, current: undefined })
    // The manager owns wire truth; the store is its projection. Manager
    // notifications are already microtask-batched.
    this.manager.subscribe(() => { this.projectList() })
    rootCtx.reflect.provide('sessions', this, undefined)
  }

  /**
   * Select a session as current. Unknown ids fail loud instead of navigating
   * nowhere (the sole selection write path).
   * @param id - session id (must exist in the list store).
   */
  open(id: SessionId): void {
    if (this.list.getSnapshot().byId[id] === undefined) {
      throw new Error(`sessions.open: unknown session ${id}`)
    }
    this.selection.update((draft) => { draft.sessionId = id })
    this.list.update((draft) => { draft.current = id })
  }

  /**
   * Create a session on the host.
   * @param opts - creation options (project directory).
   * @returns the new session id.
   */
  async create(opts: { cwd?: string } = {}): Promise<SessionId> {
    const result = await this.manager.create(opts.cwd)
    if (!result.ok) throw new Error(`session create failed: ${result.error.code}: ${result.error.message}`)
    return result.value.sessionId
  }

  /**
   * Resolve a session-scoped context view (use-and-discard).
   * @param id - session id.
   * @returns scoped ctx, or undefined for a session neither listed nor already scoped.
   */
  scope(id: SessionId): Context | undefined {
    return this.resolve(id)?.ctx
  }

  /**
   * Resolve the stable session binding (SessionProvider's resolveBinding feed).
   * @param id - session id.
   * @returns binding, or undefined for a session neither listed nor already scoped.
   */
  binding(id: SessionId): SessionBinding | undefined {
    const record = this.resolve(id)
    if (record === undefined) return undefined
    if (this.watched !== id) {
      this.watched = id
      this.sweepDeferred()
    }
    return record.binding
  }

  /**
   * Resolve the render-layer session cell (SessionProvider's feed through
   * the renderer host; ctx never enters the render layer). Marks the session
   * watched, same as {@link SessionsService.binding}.
   * @param id - session id.
   * @returns cell, or undefined for a session neither listed nor already scoped.
   */
  cell(id: string): SessionCell | undefined {
    const record = this.resolve(id as SessionId)
    if (record === undefined) return undefined
    if (this.watched !== id) {
      this.watched = id as SessionId
      this.sweepDeferred()
    }
    return record.cell
  }

  /**
   * Breadcrumb feed: walk parentId links inside the list store.
   * @param id - session id.
   * @returns summaries from root ancestor to the session itself (empty when unknown; a broken link stops the walk).
   */
  ancestry(id: SessionId): SessionSummary[] {
    const { byId } = this.list.getSnapshot()
    const chain: SessionSummary[] = []
    let cursor: SessionId | undefined = id
    while (cursor !== undefined) {
      const summary: SessionSummary | undefined = byId[cursor]
      if (summary === undefined || chain.includes(summary)) break
      chain.unshift(summary)
      cursor = summary.parentId
    }
    return chain
  }

  /** Lazily mint the scope + binding for a listed (or already-scoped) session. */
  private resolve(id: SessionId): ScopeRecord | undefined {
    const existing = this.scopes.get(id)
    if (existing !== undefined) return existing
    // Frozen scopes outlive the list; new scopes are only minted for listed sessions.
    if (this.list.getSnapshot().byId[id] === undefined) return undefined
    const fiber = this.rootCtx.plugin(sessionScope)
    const ctx = fiber.ctx.extend({ [kScope]: id })
    const session = this.manager.get(id)
    const record: ScopeRecord = {
      fiber,
      ctx,
      binding: { sessionId: id, session, ctx },
      // Bare source form (store migration): the Session object IS the
      // observable; the React side binds the useSession hook per cell.
      cell: { sessionId: id, session },
    }
    this.scopes.set(id, record)
    return record
  }

  /** Project the manager's list snapshot into the store (title derivation is display-only). */
  private projectList(): void {
    const items = this.manager.getListSnapshot().items
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    for (const entry of items) {
      ids.push(entry.sessionId)
      byId[entry.sessionId] = {
        id: entry.sessionId,
        title: titleOf(entry.cwd, entry.sessionId),
        running: entry.running,
        updatedAt: entry.updatedAt,
        ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
        ...(entry.parentSessionId !== undefined ? { parentId: entry.parentSessionId } : {}),
      }
    }
    // current = the persisted selection, masked while its session is absent
    // (falls to the empty state; resurfaces if the session returns).
    const selected = this.selection.getSnapshot().sessionId
    const current = selected !== undefined && byId[selected] !== undefined ? selected : undefined
    this.list.set({ ids, byId, current })
    this.pruneScopes(byId)
  }

  /** Tear down scopes for removed sessions nobody watches; the watched one defers until the watch moves. */
  private pruneScopes(byId: Record<SessionId, SessionSummary>): void {
    for (const [id, record] of this.scopes) {
      if (byId[id] !== undefined) continue
      if (id === this.watched) {
        this.deferredRemovals.add(id)
        continue
      }
      this.scopes.delete(id)
      this.deferredRemovals.delete(id)
      this.dropScope(id, record)
    }
  }

  /** Dispose a scope fiber and its session-keyed slot-store instances together (single lifecycle axis). */
  private dropScope(id: SessionId, record: ScopeRecord): void {
    void record.fiber.dispose()
    // Optional lookup: slots and sessions are sibling services with no
    // declared dependency; a slots-less boot (object-layer tests) skips.
    this.rootCtx.get('slots')?.pruneStoreScope(id)
  }

  /** Run deferred teardowns whose session is no longer watched (called when the watch moves). */
  private sweepDeferred(): void {
    for (const id of [...this.deferredRemovals]) {
      /* v8 ignore next -- defensive: only the watched id ever defers, and every
       * watch move sweeps first, so the set cannot contain the id the watch just
       * moved to; kept as a guard against future extra sweep call sites. */
      if (id === this.watched) continue
      // Still absent from the list? (A re-added id cancels the deferred teardown.)
      if (this.list.getSnapshot().byId[id] !== undefined) {
        this.deferredRemovals.delete(id)
        continue
      }
      const record = this.scopes.get(id)
      this.deferredRemovals.delete(id)
      /* v8 ignore next -- defensive: prune deletes a scope and its deferral
       * together, so a deferred id always still owns its record; kept so a
       * future teardown path cannot double-dispose. */
      if (record !== undefined) {
        this.scopes.delete(id)
        this.dropScope(id, record)
      }
    }
  }
}
