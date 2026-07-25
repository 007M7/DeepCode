/** Internal React bindings for the renderer host and active session cell. */
import { createContext, useContext, type ReactNode } from 'react'
import type {
  HostObservable, SessionCell, SlotRendererHost, SnapshotSelectorHook,
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

const BindingContext = createContext<SessionCell | null>(null)

/**
 * Read the enclosing session cell; throws outside a SessionProvider subtree
 * (session slots must not render without a session).
 * @returns the enclosing cell.
 */
export function useSessionCell(): SessionCell {
  const cell = useContext(BindingContext)
  if (!cell) throw new SlotAssemblyError('session slot rendered outside SessionProvider')
  return cell
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

/** SessionProvider surface: render-prop body plus the no-session branch. */
export interface SessionProviderProps {
  /** No-session body (also covers a current id whose session cannot be resolved). */
  empty?: (() => ReactNode) | undefined
  /** Session body; remounted per session via key={sessionId}. */
  children: (sessionId: string) => ReactNode
}

/**
 * Framework-wired session area: subscribes to the host's current-session
 * source, resolves the session cell, and remounts the body under
 * `key={sessionId}` so a session switch rebuilds the session subtree. This
 * dependency-inverted layer uses plain string ids; `PropsRuntime` applies the
 * branded type at the component boundary.
 */
export function SessionProvider({ empty, children }: SessionProviderProps) {
  const host = useHost()
  const id = observableHook(host.sessions.current)((s) => s)
  const cell = id === undefined ? undefined : host.sessions.cell(id)
  if (id === undefined || cell === undefined) return <>{empty?.() ?? null}</>
  return (
    <BindingContext.Provider value={cell} key={id}>
      {children(id)}
    </BindingContext.Provider>
  )
}
