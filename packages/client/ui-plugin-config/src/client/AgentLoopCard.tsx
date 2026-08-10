/** The agent loop's card: how many tool calls one step may run at once. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { CardActions } from './card-store.ts'
import type { AgentLoopCardState } from './agent-loop-store.ts'
import type {} from './slot-contract.ts'

/** Registration-side business face for the agent-loop card. */
export interface AgentLoopCardInjected extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useAgentLoopCard. */
    agentLoopCard: SnapshotStore<AgentLoopCardState>
  }
}

/** Props the renderer binds for the agent-loop card. */
export type AgentLoopCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.pluginConfig'>
  & InjectFace<AgentLoopCardInjected>

/**
 * Render the agent-loop card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function AgentLoopCard(props: AgentLoopCardProps) {
  const { t } = props
  const state = props.useAgentLoopCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="agentLoopTitle"
      descriptionKey="agentLoopDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-agent-loop-parallel"
        label={t('agentLoopMaxParallel')}
        hint={t('agentLoopMaxParallelHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={!state.writable}
        {...state.maxParallelToolCalls}
        onEdit={(text) => { props.edit('maxParallelToolCalls', text) }}
        onReset={() => { props.resetField('maxParallelToolCalls') }}
      />
    </PluginCard>
  )
}
