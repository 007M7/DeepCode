/** The shell card's state and writes over the `bash` settings namespace. */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardController, fieldOf, shellOf, type CardField, type CardShell } from './card-store.ts'

/**
 * Namespace of the shell capability. Spelled here rather than imported: a
 * client package must not depend on a Host package, and the executor families
 * that own it spell the same value.
 */
export const BASH_NS = 'bash'

/** The shell fields this card edits — a subset of the served schema by design. */
export interface BashSettings {
  /** Foreground command timeout in milliseconds. */
  timeoutMs?: number
  /** Per-stream in-memory output cap in bytes. */
  maxOutputBytes?: number
}

/** What the shell card renders. */
export interface BashCardState extends CardShell {
  /** Command timeout in milliseconds. */
  timeoutMs: CardField<number>
  /** Per-stream output cap in bytes. */
  maxOutputBytes: CardField<number>
}

/** The registration-side face the shell card's slot entry injects. */
export interface BashCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useBashCard. */
    bashCard: SnapshotStore<BashCardState>
  }
  /** Write the foreground command timeout. */
  setTimeoutMs: (next: number) => void
  /** Clear the timeout so it re-inherits the composition layer. */
  resetTimeoutMs: () => void
  /** Write the per-stream output cap. */
  setMaxOutputBytes: (next: number) => void
  /** Clear the output cap so it re-inherits the composition layer. */
  resetMaxOutputBytes: () => void
}

/** Bridges the `bash` scope onto the shell card's state and writes. */
export class BashCardController extends CardController<BashSettings, BashCardState> {
  /** @param scope - the bound settings scope for the `bash` namespace. */
  constructor(scope: SettingsScope<BashSettings>) {
    super(scope, snapshot => ({
      ...shellOf(snapshot),
      // The fallbacks only show before the Host serves a section; every served
      // section is already schema-defaulted by the owning executor.
      timeoutMs: fieldOf(snapshot, 'timeoutMs', 0),
      maxOutputBytes: fieldOf(snapshot, 'maxOutputBytes', 0),
    }))
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its write actions.
   */
  inject(): BashCardFace {
    return {
      hooks: { bashCard: this.store },
      setTimeoutMs: (next: number) => { void this.scope.set('timeoutMs', next) },
      resetTimeoutMs: () => { void this.scope.unset('timeoutMs') },
      setMaxOutputBytes: (next: number) => { void this.scope.set('maxOutputBytes', next) },
      resetMaxOutputBytes: () => { void this.scope.unset('maxOutputBytes') },
    }
  }
}
