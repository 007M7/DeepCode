/**
 * ModelSelect's injected face. The target 'conversation.input.model' seat is
 * declared (children table) and typed by ui-conversation's composer-bar
 * entry; this package only contributes the single occupant, so no SlotMap
 * merge lives here.
 */
import type { ModelTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState, ModelEffort } from './directory.ts'

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /** Refresh the advisory directory (fire-and-forget; errors land on the store). */
  load(): void
  /**
   * Select a complete provider/model target through the shared route.
   * @param target - target picked from one provider group.
   * @returns whether the host accepted the selection.
   */
  select(target: ModelTarget): Promise<boolean>
  /**
   * Set the displayed thinking-effort level (client-local echo; see the
   * directory state contract).
   * @param effort - the level to display.
   */
  setEffort(effort: ModelEffort): void
}
