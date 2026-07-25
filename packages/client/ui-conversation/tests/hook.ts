/**
 * Test-local selector binding through the production uSES implementation.
 * Runtime remains React-free, so specs bind observable sources here.
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
