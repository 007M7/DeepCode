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
 * @returns the deferral handle (dispose in the owning effect's disposer).
 */
export function deferRegistration(
  registry: DeferralRegistry,
  name: string,
  component: unknown,
  register: () => () => void,
): DeferredRegistration {
  let dispose: (() => void) | undefined
  const tryRegister = (): void => {
    if (registry.spec(name) === undefined) return
    if (registry.entries(name).some(e => e.component === component)) return
    dispose = register()
  }
  const unsubscribe = registry.subscribe(name, () => { tryRegister() })
  tryRegister()
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
