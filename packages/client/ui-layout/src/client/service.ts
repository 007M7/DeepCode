/**
 * LayoutService implementation: the shell-level viewing-state authority.
 * Four persisted stores (nav + two panels); actions clamp and validate. The
 * concession chain lives in columns.ts and never writes back into these
 * stores — persisted preferences survive window shrinking.
 */
import type { Context } from 'cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/** Active conversation view id (keys merged into ConversationViewMap by ui-conversation). */
export type ViewId = string

/** Navigation state: selected session and per-session active view. */
export interface NavState { sessionId?: SessionId; viewFor: Record<SessionId, ViewId> }

/** Panel viewing state: open flag plus persisted width. */
export interface PanelState { open: boolean; width: number }

/** Shell-level viewing-state authority (zustand + persist). */
export class LayoutService {
  /** Navigation state store. */
  readonly current: SnapshotStore<NavState>
  /** Sidebar panel store (default 300, clamp [240, 420]). */
  readonly sidebar: SnapshotStore<PanelState>
  /** Details panel store (default 360, clamp [300, 520]; P-I global, not per-session). */
  readonly details: SnapshotStore<PanelState>

  #sessions: SessionsService
  #unprune: () => void

  /**
   * @param ctx - root context (resolves the sessions service for open validation and list pruning).
   */
  constructor(ctx: Context) {
    // ctx.get instead of ctx.sessions: the typed Context merge is suspended
    // while the client/host `sessions` declaration collision awaits
    // arbitration (see the runtime package's Context merge note).
    const sessions = ctx.get('sessions')
    if (sessions === undefined) throw new Error('layout: sessions service unavailable')
    this.#sessions = sessions
    this.current = createSnapshotStore<NavState>(
      { viewFor: {} },
      { persist: { name: 'dsh.layout.nav' } })
    this.sidebar = createSnapshotStore<PanelState>(
      { open: true, width: SIDEBAR_DEFAULT },
      { persist: { name: 'dsh.layout.sidebar' } })
    this.details = createSnapshotStore<PanelState>(
      { open: false, width: DETAILS_DEFAULT },
      { persist: { name: 'dsh.layout.details' } })
    // Prune is one-directional: list removals clear keyed viewing state, and a
    // selection pointing at a removed session falls back to the empty state.
    this.#unprune = sessions.list.subscribe(() => { this.#prune() })
  }

  /** Drop the sessions.list subscription (plugin teardown). */
  dispose(): void {
    this.#unprune()
  }

  #prune(): void {
    const byId = this.#sessions.list.getSnapshot().byId
    const nav = this.current.getSnapshot()
    // Object.keys erases the branded key type; these entries were written with SessionId keys.
    const viewKeys = Object.keys(nav.viewFor) as SessionId[]
    const staleView = viewKeys.some(id => byId[id] === undefined)
    const staleCurrent = nav.sessionId !== undefined && byId[nav.sessionId] === undefined
    if (!staleView && !staleCurrent) return
    this.current.update((draft) => {
      // Rebuild instead of dynamic delete: viewFor is a plain keyed record and
      // the survivors are the entries whose session still exists.
      draft.viewFor = Object.fromEntries(
        Object.entries(draft.viewFor).filter(([id]) => byId[id as SessionId] !== undefined))
      if (draft.sessionId !== undefined && byId[draft.sessionId] === undefined) delete draft.sessionId
    })
  }

  /**
   * Select a session. Unknown ids fail loud instead of navigating nowhere.
   * @param id - session id (must exist in sessions.list).
   */
  open(id: SessionId): void {
    if (this.#sessions.list.getSnapshot().byId[id] === undefined) {
      throw new Error(`layout.open: unknown session ${id}`)
    }
    this.current.update((draft) => { draft.sessionId = id })
  }

  /**
   * Activate a view for a session.
   * @param sessionId - session id.
   * @param view - view id.
   */
  openView(sessionId: SessionId, view: ViewId): void {
    this.current.update((draft) => { draft.viewFor[sessionId] = view })
  }

  /** Toggle the sidebar panel. */
  toggleSidebar(): void {
    this.sidebar.update((draft) => { draft.open = !draft.open })
  }

  /**
   * Set the sidebar width (clamped to [240, 420]).
   * @param px - width in pixels.
   */
  setSidebarWidth(px: number): void {
    this.sidebar.update((draft) => { draft.width = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) })
  }

  /** Open the details panel. */
  openDetails(): void {
    this.details.update((draft) => { draft.open = true })
  }

  /** Close the details panel. */
  closeDetails(): void {
    this.details.update((draft) => { draft.open = false })
  }

  /**
   * Set the details width (clamped to [300, 520]).
   * @param px - width in pixels.
   */
  setDetailsWidth(px: number): void {
    this.details.update((draft) => { draft.width = clampWidth(px, DETAILS_MIN, DETAILS_MAX) })
  }
}
