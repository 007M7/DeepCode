/** Internal React bindings for the renderer host and active session provide bundle. */
import { createContext, useContext, type ReactNode } from 'react'
import type {
  HostObservable, MaybeSnapshotSelectorHook, SessionMaybeProvideInfo, SessionProvideInfo,
  SlotRendererHost, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from './bind.ts'

/**
 * A missing-provider assembly error: the shell wired the tree wrong. The slot
 * error boundary rethrows this class so misassembly stays fail-loud while
 * registrant errors (inject factories, entry components) are contained
 * per entry.
 */
export class SlotAssemblyError extends Error {}

/** In-package renderer host context. */
export const HostContext = createContext<SlotRendererHost | null>(null)

/**
 * Read the installed renderer host; throws outside the rendered root tree
 * (framework components must not render detached from the renderer).
 * @returns the host surface.
 */
export function useHost(): SlotRendererHost {
  const host = useContext(HostContext)
  if (!host) throw new SlotAssemblyError('slot machinery rendered outside the installed renderer tree')
  return host
}

const BindingContext = createContext<SessionMaybeProvideInfo | null>(null)

/** Read the current-session-optional bundle supplied at the root. */
export function useSessionMaybeProvideInfo(): SessionMaybeProvideInfo {
  const info = useContext(BindingContext)
  if (!info) throw new SlotAssemblyError('session-aware slot rendered outside the root binding provider')
  return info
}

/**
 * Read the enclosing session provide bundle; throws outside a SessionProvider
 * subtree (session slots must not render without a session).
 * @returns the enclosing bundle.
 */
export function useSessionProvideInfo(): SessionProvideInfo {
  const info = useSessionMaybeProvideInfo()
  if (info.sessionId === undefined) throw new SlotAssemblyError('strict session slot rendered without a session')
  return info as SessionProvideInfo
}

/**
 * Identity-stable selector hook per host observable. uSES resubscribes when
 * the subscribe reference changes, so the bound hook must be created once per
 * source — cached here by source identity (sources are host-owned singletons).
 * @param source - host-provided observable.
 * @returns the cached selector hook.
 */
export function observableHook<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  let hook = hookCache.get(source)
  if (hook === undefined) {
    hook = bindSnapshotSelector(source)
    hookCache.set(source, hook)
  }
  return hook as SnapshotSelectorHook<T>
}
const hookCache = new WeakMap<object, unknown>()

const absentSource: HostObservable<undefined> = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
}

/** Bind a source that disappears with the current session to an optional selector hook. */
export function maybeObservableHook<T>(source: HostObservable<T> | undefined): MaybeSnapshotSelectorHook<T> {
  if (source !== undefined) return observableHook(source)
  return useAbsentSnapshot
}

function useAbsentSnapshot<S>(_selector: (snapshot: never) => S, _equal?: (a: S, b: S) => boolean): S | undefined {
  // The uSES subscription must still run (hook-order stability); the absent
  // source always snapshots undefined, returned explicitly.
  observableHook(absentSource)(() => undefined)
  return undefined
}

/**
 * Root-level binding provider. It follows current selection without a key, so
 * session-maybe entries retain their React identity while the context value
 * moves between absent and definite session bundles.
 */
export function SessionMaybeProvider({ children }: { children: ReactNode }) {
  const host = useHost()
  const info = observableHook(host.sessions.provideInfo)(s => s)
  return (
    <BindingContext.Provider value={info}>
      {children}
    </BindingContext.Provider>
  )
}

/** SessionProvider surface: render-prop body plus the no-session branch. */
export interface SessionProviderProps {
  /** No-session body (also covers a current id whose session cannot be resolved). */
  empty?: (() => ReactNode) | undefined
  /** Session body; remounted per session via key={sessionId}. */
  children: (sessionId: string) => ReactNode
}

/**
 * Framework-wired session area: subscribes to the host's current provide
 * source and remounts the body under `key={sessionId}` so a session switch
 * rebuilds the session subtree. This dependency-inverted layer uses plain
 * string ids; `PropsRuntime` applies the branded type at the component
 * boundary.
 */
export function SessionProvider({ empty, children }: SessionProviderProps) {
  const host = useHost()
  const info = observableHook(host.sessions.provideInfo)(s => s)
  const id = info.sessionId
  if (id === undefined) return <>{empty?.() ?? null}</>
  return (
    <BindingContext.Provider value={info} key={id}>
      {children(id)}
    </BindingContext.Provider>
  )
}
