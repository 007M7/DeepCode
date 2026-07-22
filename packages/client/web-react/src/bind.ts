/**
 * uSES bridge: turns any {@link ObservableSnapshot} into a typed selector
 * hook. Client-side-rendered only, so no server snapshot is wired.
 */
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector.js'
import type { ObservableSnapshot, SnapshotSelectorHook } from './store/index.ts'

/**
 * Bind an observable snapshot source to a typed uSES selector hook.
 * subscribe/getSnapshot are captured once per source into stable closures
 * (also re-binds `this` for method-based sources), so components never
 * resubscribe across renders. Equality defaults to Object.is.
 * @param w - snapshot source (Session object or snapshot store).
 * @returns the selector hook.
 */
export function bindSnapshotSelector<T>(w: ObservableSnapshot<T>): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => w.subscribe(fn)
  const getSnapshot = () => w.getSnapshot()
  return function useSelector<S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean): S {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)
  }
}
