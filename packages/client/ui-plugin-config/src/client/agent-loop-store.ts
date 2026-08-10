/** The agent-loop card's state and writes over the `agent-loop` settings namespace. */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardController, fieldOf, shellOf, type CardField, type CardShell } from './card-store.ts'

/**
 * Namespace of the agent loop's user-owned settings. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const AGENT_LOOP_NS = 'agent-loop'

/**
 * The agent-loop fields this card edits. The Host section carries only this
 * field — the composed `agents` array is deliberately not part of it.
 */
export interface AgentLoopSettings {
  /** Upper bound on parallel-safe tool calls in flight per step. */
  maxParallelToolCalls?: number
}

/** What the agent-loop card renders. */
export interface AgentLoopCardState extends CardShell {
  /** Parallel tool-call cap. */
  maxParallelToolCalls: CardField<number>
}

/** The registration-side face the agent-loop card's slot entry injects. */
export interface AgentLoopCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useAgentLoopCard. */
    agentLoopCard: SnapshotStore<AgentLoopCardState>
  }
  /** Write the parallel tool-call cap. */
  setMaxParallelToolCalls: (next: number) => void
  /** Clear the cap so it re-inherits the composition layer. */
  resetMaxParallelToolCalls: () => void
}

/** Bridges the `agent-loop` scope onto the card's state and writes. */
export class AgentLoopCardController extends CardController<AgentLoopSettings, AgentLoopCardState> {
  /** @param scope - the bound settings scope for the `agent-loop` namespace. */
  constructor(scope: SettingsScope<AgentLoopSettings>) {
    super(scope, snapshot => ({
      ...shellOf(snapshot),
      maxParallelToolCalls: fieldOf(snapshot, 'maxParallelToolCalls', 0),
    }))
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its write actions.
   */
  inject(): AgentLoopCardFace {
    return {
      hooks: { agentLoopCard: this.store },
      setMaxParallelToolCalls: (next: number) => { void this.scope.set('maxParallelToolCalls', next) },
      resetMaxParallelToolCalls: () => { void this.scope.unset('maxParallelToolCalls') },
    }
  }
}
