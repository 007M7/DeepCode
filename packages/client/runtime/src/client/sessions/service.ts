/**
 * SessionsService: root sessions service — list snapshot store (manager
 * projection; carries `current`, the persisted selection every
 * session-scoped surface keys off — migrated here from ui-layout per the
 * slot-parity design), session scope tree (mintScope pattern: no-op plugin
 * Fiber + ctx.extend scope tag), stable SessionBinding cache, ancestry walk.
 *
 * Scope lifecycle is stage-driven: a scope is minted lazily on first
 * resolution (pure — resolution has no side effects and is render-safe);
 * the event window and deferred teardown key off the STAGED session, which
 * follows `list.current` exactly. Staging is the open signal: the window
 * opens ⟺ the session is on stage (today the stage is `current`; the staged
 * state can widen to a multi-pane list later). A session leaving the list
 * tears its scope down immediately unless it is the staged one, whose scope
 * survives frozen (read-only view) until the stage moves on.
 */
import type { Context, Fiber } from 'cordis'
import type { IApiClient, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionCell } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import { SessionManager } from './manager.ts'
import type { Session } from './session.ts'

/** Session list row projected from the host list RPC plus live stream increments. */
export interface SessionSummary {
  id: SessionId
  /** Latest durable log-backed title, absent until the host projects one. */
  title?: string
  /** Human-facing label: durable title, project basename, then session id. */
  displayTitle: string
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
 * Display title projection: durable title, project directory basename, then
 * the raw id.
 */
function displayTitleOf(title: string | undefined, cwd: string | undefined, id: SessionId): string {
  if (title !== undefined) return title
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
   * SessionsService.open} / {@link SessionsService.clear}. Projection
   * validates it against the live list instead of destructively pruning, so a
   * selection survives transient list states (reconnect re-pull) and
   * resurfaces when its session returns.
   */
  private readonly selection: SnapshotStore<{ sessionId?: SessionId }>

  private readonly scopes = new Map<SessionId, ScopeRecord>()
  /**
   * The staged session id — follows `list.current` exactly, holding its last
   * defined value across masked gaps (a transiently absent selection blanks
   * `current` without moving the stage, so reconnect re-pulls and removals
   * keep the staged scope's frozen view alive until the stage moves on).
   */
  private watched: SessionId | undefined
  /** Removed-while-staged sessions whose teardown waits for the stage to move away. */
  private readonly deferredRemovals = new Set<SessionId>()

  /**
   * @param ctx - client root context (scope fibers mount under it).
   * @param api - wire client shared with every Session.
   */
  constructor(private readonly rootCtx: Context, private readonly api: IApiClient) {
    this.manager = new SessionManager(api)
    this.selection = createSnapshotStore<{ sessionId?: SessionId }>(
      {},
      { persist: { name: 'dsh.sessions.current' } })
    this.list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, current: undefined })
    // The manager owns wire truth; the store is its projection. Manager
    // notifications are already microtask-batched.
    this.manager.subscribe(() => { this.projectList() })
    // Stage follower: every current write (open() and projection alike)
    // re-evaluates staging, so startup restore (persisted selection validated
    // by the projection) and reconnect resurfacing open their window with no
    // dedicated code path. Safe to run synchronously inside the store notify:
    // the follower writes no list state — session.open()'s synchronous prefix
    // touches only session-side state and its own microtask-batched notifier.
    this.list.subscribe(() => { this.followCurrent() })
    rootCtx.reflect.provide('sessions', this, undefined)
  }

  /**
   * Select a session as current. Unknown ids fail loud instead of navigating
   * nowhere.
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
   * Clear the current selection so the layout shows the no-session empty
   * state. Wipes the persisted selection too — a reload stays on empty until
   * the user opens or starts a session. Staging holds the previous occupant
   * across the blank (same masked-gap rule as a transient list miss).
   */
  clear(): void {
    this.selection.set({})
    this.list.update((draft) => { draft.current = undefined })
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
   * Create a workspace folder under the host process cwd and a session in it.
   * Name is a single path segment (no separators); the host mkdir runs inside
   * session.create. Caller opens the returned id when it wants the session staged.
   * @param name - workspace folder basename.
   * @returns the new session id.
   */
  async createWorkspace(name: string): Promise<SessionId> {
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('sessions.createWorkspace: name is required')
    if (/[/\\]/.test(trimmed)) {
      throw new Error('sessions.createWorkspace: name must not contain path separators')
    }
    const { result } = await this.api.host.describe({})
    if (!result.ok) {
      throw new Error(`host.describe failed: ${result.error.code}: ${result.error.message}`)
    }
    const hostCwd = result.value.cwd.replace(/[/\\]+$/, '')
    return this.create({ cwd: `${hostCwd}/${trimmed}` })
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
   * Read the session scope tag off a context. Service-method seam: fetch
   * bundles must reach scope resolution through ctx.sessions — a cross-bundle
   * value import of the standalone helper would inline a second module
   * instance whose private tag Symbol never matches.
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined {
    return scopeOf(ctx)
  }

  /**
   * Resolve the stable session binding (scope-addressed assembly feed). Pure
   * resolution — no staging, no window side effects.
   * @param id - session id.
   * @returns binding, or undefined for a session neither listed nor already scoped.
   */
  binding(id: SessionId): SessionBinding | undefined {
    return this.resolve(id)?.binding
  }

  /**
   * Resolve the render-layer session cell (SessionProvider's feed through
   * the renderer host; ctx never enters the render layer). Pure resolution —
   * render-safe: SessionProvider calls this during render, so no staging, no
   * window side effects (StrictMode double-invokes and concurrent discarded
   * passes must stay free).
   * @param id - session id.
   * @returns cell, or undefined for a session neither listed nor already scoped.
   */
  cell(id: string): SessionCell | undefined {
    return this.resolve(id as SessionId)?.cell
  }

  /**
   * Move the stage to the list's current session: sweep teardowns deferred
   * behind the previous occupant and pull the new occupant's history window.
   * Staging IS the open signal — the window opens ⟺ the session is on stage
   * — and open() is idempotent (an in-flight or completed open no-ops; a
   * failed one retries the next time current is touched).
   */
  private followCurrent(): void {
    const current = this.list.getSnapshot().current
    // A masked gap (current blanked while the selection's session is
    // transiently absent) holds the stage: tearing down on the gap would
    // destroy exactly the frozen scope the mask exists to preserve.
    if (current === undefined || current === this.watched) return
    this.watched = current
    this.sweepDeferred()
    const record = this.resolve(current)
    /* v8 ignore next 3 -- defensive: current is always a listed id (open()
     * validates and the projection masks absent selections), so resolve
     * cannot miss; kept so a future current writer cannot crash the notify. */
    if (record !== undefined) {
      void record.binding.session.open()
    }
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
        displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),
        running: entry.running,
        updatedAt: entry.updatedAt,
        ...(entry.title !== undefined ? { title: entry.title } : {}),
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

  /** Tear down scopes for removed sessions off stage; the staged one defers until the stage moves. */
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

  /** Run deferred teardowns whose session is no longer staged (called when the stage moves). */
  private sweepDeferred(): void {
    for (const id of [...this.deferredRemovals]) {
      /* v8 ignore next -- defensive: only the staged id ever defers, and every
       * stage move sweeps first, so the set cannot contain the id the stage just
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
