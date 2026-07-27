// Notifier: subscription + microtask-batched notification primitive shared by Session and
// SessionManager. Semantics: N markDirty calls collapse into one microtask flush;
// the flush rebuilds the snapshot cache BEFORE notifying (useSyncExternalStore requires a stable
// getSnapshot reference). With no listeners the rebuild is skipped and only the dirty bit is set
// (keeps frame storms cheap); the next getSnapshot rebuilds lazily.
//
// Freshness and notification are SEPARATE bits: a pull (ensureFresh) between
// markDirty and the scheduled flush rebuilds the snapshot but must not
// swallow the notification — push subscribers (object-layer watchers) would
// otherwise starve whenever any reader pulls first.

/** Subscription + microtask-batched notification primitive (shared by Session and SessionManager). */
export class Notifier {
  private listeners = new Set<() => void>()
  private dirty = false
  private notifyPending = false
  private scheduled = false

  /** @param rebuild - snapshot rebuild function injected by the owner (writes the owner's snapshotCache). */
  constructor(private readonly rebuild: () => void) {}

  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** State-change entry: mark dirty and schedule the batched flush. */
  markDirty(): void {
    this.dirty = true
    this.notifyPending = true
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.notifyPending) return
      if (this.listeners.size === 0) return // lazy: no subscribers; dirty (if still set) rebuilds on next getSnapshot
      this.notifyPending = false
      if (this.dirty) {
        this.dirty = false
        this.rebuild()
      }
      for (const listener of this.listeners) listener()
    })
  }

  /**
   * Synchronous flush: controlled-input writes must notify in the same tick as
   * onChange, or React rolls the DOM back to the stale value and the caret jumps to the end.
   */
  notifyNow(): void {
    this.dirty = true
    this.notifyPending = true
    if (this.listeners.size === 0) return // lazy: same as markDirty, next getSnapshot rebuilds
    this.notifyPending = false
    this.dirty = false
    this.rebuild()
    for (const listener of this.listeners) listener()
  }

  /**
   * Pre-getSnapshot check: rebuild synchronously when dirty (read path
   * before first subscribe / while unobserved). Notification stays pending.
   */
  ensureFresh(): void {
    if (!this.dirty) return
    this.dirty = false
    this.rebuild()
  }
}
