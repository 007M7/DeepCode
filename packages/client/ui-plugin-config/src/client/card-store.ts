/**
 * Shared projection from one settings scope onto a card's fields.
 *
 * A card shows the effective value of each field and whether the user set it.
 * Both come from the scope snapshot: `value` is what the plugin resolves, and
 * the presence of a key in the raw `user` layer is what makes it overridden —
 * an override equal to the composition default is still an override, and
 * comparing values could not tell them apart.
 */

import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One field as a card renders it. */
export interface CardField<V> {
  /** Effective value: the user layer over the composition layer over the schema default. */
  value: V
  /** Whether the raw user layer carries this field. */
  overridden: boolean
}

/** State every plugin card shares. */
export interface CardShell {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
}

/**
 * Read one field out of a scope snapshot.
 * @param snapshot - the scope snapshot to project.
 * @param field - the section field to read.
 * @param fallback - value shown before the Host serves a section.
 * @returns the field as a card renders it.
 */
export function fieldOf<T, V>(
  snapshot: SettingsScopeSnapshot<T>,
  field: string,
  fallback: V,
): CardField<V> {
  const section = snapshot.value as Record<string, unknown> | undefined
  const user = snapshot.user as Record<string, unknown> | undefined
  const value = section?.[field]
  return {
    value: value === undefined ? fallback : value as V,
    overridden: user !== undefined && Object.hasOwn(user, field),
  }
}

/**
 * Project the shell every card shares.
 * @param snapshot - the scope snapshot to project.
 * @returns availability and writability.
 */
export function shellOf<T>(snapshot: SettingsScopeSnapshot<T>): CardShell {
  return { available: snapshot.status === 'ready', writable: snapshot.writable }
}

/**
 * Keep a snapshot store synchronized with one settings scope.
 *
 * The store exists because slot components read through a snapshot selector,
 * while the scope publishes its own snapshot; this bridges the two and gives
 * each card a state shaped for rendering rather than for the wire.
 */
export class CardController<T, S> {
  /** Snapshot the card's component reads through its bound selector. */
  readonly store: SnapshotStore<S>

  /**
   * @param scope - the bound settings scope for this card's namespace.
   * @param project - build the card state from a scope snapshot.
   */
  constructor(
    protected readonly scope: SettingsScope<T>,
    private readonly project: (snapshot: SettingsScopeSnapshot<T>) => S,
  ) {
    this.store = createSnapshotStore(project(scope.getSnapshot()))
    scope.subscribe(() => {
      this.store.set(this.project(this.scope.getSnapshot()))
    })
  }
}
