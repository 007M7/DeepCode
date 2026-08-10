/** The agent-loop plugin's card: how many tool calls may run at once. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NumberField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { AgentLoopCardState } from './agent-loop-store.ts'
import type {} from './slot-contract.ts'

/** Registration-side business face for the agent-loop card. */
export interface AgentLoopCardInjected {
  hooks: {
    /** Card snapshot bound by the renderer as useAgentLoopCard. */
    agentLoopCard: SnapshotStore<AgentLoopCardState>
  }
  /** Write the parallel tool-call cap. */
  setMaxParallelToolCalls: (next: number) => void
  /** Clear the cap so it re-inherits the composition layer. */
  resetMaxParallelToolCalls: () => void
}

/** Props the renderer binds for the agent-loop card. */
export type AgentLoopCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.pluginConfig'>
  & InjectFace<AgentLoopCardInjected>

/**
 * Render the agent-loop card.
 * @param props - locale copy, the card snapshot, and its write actions.
 * @returns the card.
 */
export function AgentLoopCard(props: AgentLoopCardProps) {
  const { t } = props
  const state = props.useAgentLoopCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="agentLoopTitle"
      descriptionKey="agentLoopDescription"
      available={state.available}
      readOnly={disabled}
    >
      <NumberField
        id="plugin-config-agent-loop-parallel"
        label={t('agentLoopMaxParallel')}
        hint={t('agentLoopMaxParallelHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        overridden={state.maxParallelToolCalls.overridden}
        disabled={disabled}
        value={state.maxParallelToolCalls.value}
        onCommit={props.setMaxParallelToolCalls}
        onReset={props.resetMaxParallelToolCalls}
      />
    </PluginCard>
  )
}
