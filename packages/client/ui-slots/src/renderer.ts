/** React-free contracts between the slot host and an installed renderer. */
import type { ReactNode } from 'react'
import type { SlotEntryDef, SlotSpec, StoredEntry } from './index.ts'

/** Minimal observable surface for host-provided standard-kit data sources. */
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/**
 * Type-erased store instance face at the render seam (the typed twin is
 * {@link StoreInstance}): a bare snapshot source plus the draft-stripped
 * action callbacks. No React hook crosses this seam — the render machinery
 * binds `useStore` from the source at its own side (cached per instance);
 * typing lands at the component seam via {@link PropsStore}.
 */
export interface StoreInstanceLike {
  getSnapshot(): unknown
  /**
   * Subscribe to state changes (uSES subscribe side).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void
  readonly actions: Record<string, (...params: never[]) => void>
}

/** Session standard kit resolved per session id (identity-stable per session scope; a recreated scope yields a new cell). */
export interface SessionCell {
  sessionId: string
  /**
   * Bare conversation-snapshot source (wide here; runtime narrows at its
   * export seam). The React side binds the `useSession` hook per cell —
   * hooks never appear on the host contract.
   */
  session: HostObservable<unknown>
}

/** renderSlot dispatch options at the machinery level: keyed dispatch key, list filtering, empty fallback. */
export interface RenderOpts {
  entryKey?: string
  only?: string
  fallback?: ReactNode
}

/** Host surface the runtime SlotsService presents to the installed renderer. */
export interface SlotRendererHost {
  /**
   * Subscribe to a key's registration changes (microtask-batched).
   * @param key - slot key.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(key: string, fn: () => void): () => void
  /**
   * Monotonic version for uSES pairing.
   * @param key - slot key.
   * @returns current version.
   */
  getVersion(key: string): number
  /**
   * Snapshot the registered entries for a key (stable reference between mutations).
   * @param key - slot key.
   * @returns entries in registration (list: order) sequence.
   */
  entriesOf(key: string): readonly StoredEntry[]
  /**
   * Declared runtime spec from the declarations ledger.
   * @param key - slot key.
   * @returns the spec, or undefined while the key is undeclared (outlets render empty).
   */
  specOf(key: string): SlotSpec<SlotEntryDef> | undefined
  /**
   * Stale-authorization check: whether the entry is still in the ledger.
   * @param entry - a previously rendered entry.
   * @returns false once the entry's registration was disposed.
   */
  isLive(entry: StoredEntry): boolean
  /**
   * Resolve (create or return cached) the store instance for an entry's
   * declared handle under a scope key; lifecycle rides the ledger axis.
   * @param entry - entry whose declaration carries the handle.
   * @param scopeKey - session id for session-scope slots, undefined for root scope.
   * @returns the instance, or undefined when the entry declares no store.
   */
  storeOf(entry: StoredEntry, scopeKey: string | undefined): StoreInstanceLike | undefined
  /** Session-side standard-kit sources. */
  sessions: {
    /** Session list source backing the useSessions standard hook. */
    list: HostObservable<unknown>
    /** Current-session source used by SessionProvider. */
    current: HostObservable<string | undefined>
    /**
     * Resolve the session standard kit.
     * @param id - session id.
     * @returns the cell, or undefined for an unknown session (provider falls to empty).
     */
    cell(id: string): SessionCell | undefined
  }
}

/** The install seam: runtime owns install()/renderSlot(); web-react implements rendering. */
export interface SlotRenderer {
  /**
   * Render the root slot tree over the host surface (the only ctx-level entry).
   * @param host - the installing service's host surface.
   * @param ownerProps - owner props from the shell's renderSlot('root', ...) call.
   * @returns the rendered tree.
   */
  renderRoot(host: SlotRendererHost, ownerProps: object): ReactNode
}

/** Thrown when a retained renderSlot binding is invoked after its declaring entry was disposed. */
export class StaleAuthorizationError extends Error {}

/**
 * Thrown when a renderSlot binding is invoked for a key outside its entry's
 * children declaration (plain-JS backstop; typed callers are narrowed
 * statically).
 */
export class SlotOwnershipError extends Error {}
