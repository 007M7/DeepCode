/**
 * Declaration-aware registration deferral: the shared timing machinery for
 * registering into a slot whose declaring entry activates in unconstrained
 * order (dshClient.inject edges never sequence apply). Presence is judged on
 * the LEDGER, not a local flag — after an HMR collapse re-declares the slot,
 * the cascade has already removed the entry while the local disposer went
 * stale, and a flag guard would block the re-registration.
 */

/** Minimal registry face the deferral reads (SlotsService satisfies it). */
export interface DeferralRegistry {
  /** Declared spec lookup (undefined = not declared yet). */
  spec(name: string): unknown
  /** Current entries of the slot (component identity is the presence judge). */
  entries(name: string): readonly { component: unknown }[]
  /** Subscribe to the slot's ledger changes; returns the unsubscriber. */
  subscribe(name: string, listener: () => void): () => void
}

/** Handle over one deferred registration. */
export interface DeferredRegistration {
  /**
   * Drop the current registration (stale disposers are harmless no-ops) and
   * immediately re-attempt — the refresh path for registrants whose options
   * carry localized text.
   */
  refresh(): void
  /** Unsubscribe and unregister (idempotent through the slot core). */
  dispose(): void
}

/**
 * Register into `name` as soon as its declaration is on the ledger, and
 * re-register whenever the declaration reappears after a collapse.
 * @param registry - the slot registry face.
 * @param name - target slot name.
 * @param component - the component whose ledger presence marks "registered".
 * @param register - performs the actual registration; returns its disposer.
 * @param onFailure - owns a registration failure that fires from a LATER
 * ledger flush (a declaration landing after two providers deferred, say):
 * the deferral first removes its own subscription, then hands the error
 * over instead of throwing through the flush — the callback's chance to
 * roll back sibling deferrals and surface the conflict on a loud channel.
 * Absent, a late failure rethrows out of the flush.
 * @returns the deferral handle (dispose in the owning effect's disposer).
 * @throws the immediate registration's failure, after removing the
 * just-installed subscription — a throwing construction leaves nothing live.
 */
export function deferRegistration(
  registry: DeferralRegistry,
  name: string,
  component: unknown,
  register: () => () => void,
  onFailure?: (error: unknown) => void,
): DeferredRegistration {
  let dispose: (() => void) | undefined
  const tryRegister = (): void => {
    if (registry.spec(name) === undefined) return
    if (registry.entries(name).some(e => e.component === component)) return
    dispose = register()
  }
  const unsubscribe = registry.subscribe(name, () => {
    try {
      tryRegister()
    } catch (error) {
      unsubscribe()
      if (onFailure === undefined) throw error
      onFailure(error)
    }
  })
  try {
    tryRegister()
  } catch (error) {
    // A synchronous registration failure (the declared slot is already
    // occupied) must not leave the just-installed subscription behind: the
    // caller receives no handle to dispose it through.
    unsubscribe()
    throw error
  }
  return {
    refresh() {
      dispose?.()
      dispose = undefined
      tryRegister()
    },
    dispose() {
      unsubscribe()
      dispose?.()
    },
  }
}
