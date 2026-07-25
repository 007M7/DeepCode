/**
 * Test-local selector-hook binder: the engine carries no hook since the store
 * migration (runtime is React-free); the renderer binds in production, specs
 * bind here. Delegates to web-react's bindSnapshotSelector SOURCE (same
 * with-selector uSES shim as production, so selector-level render economics —
 * a top-level snapshot swap with an unchanged slice does NOT re-render — hold
 * in Profiler-count specs). Source-relative import: the package dependency
 * edge to web-react is gone (store migration §7); tests reach the sibling
 * package the same way they reach their own src internals.
 */
import { bindSnapshotSelector } from '../../web-react/src/bind.ts'

/** Minimal observable source (engine stores and scripted fakes both satisfy it). */
export interface HookSource<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/**
 * Bind a selector hook over a snapshot source.
 * @param src - the source.
 * @returns a SnapshotSelectorHook-shaped hook.
 */
export function hookOf<T>(src: HookSource<T>) {
  return bindSnapshotSelector<T>(src)
}
