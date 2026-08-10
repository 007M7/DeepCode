/** The shell plugin's card: the limits every command the agent runs is bound by. */

import { useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NumberField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { BashCardState } from './bash-store.ts'
import type {} from './slot-contract.ts'

/** Registration-side business face for the shell card. */
export interface BashCardInjected {
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

/** Props the renderer binds for the shell card. */
export type BashCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.pluginConfig'>
  & InjectFace<BashCardInjected>

/**
 * Render the shell card.
 * @param props - locale copy, the card snapshot, and its write actions.
 * @returns the card.
 */
export function BashCard(props: BashCardProps) {
  const { t } = props
  const state = props.useBashCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const disabled = !state.writable
  return (
    <PluginCard
      title={t('bashTitle')}
      description={t('bashDescription')}
      available={state.available}
      open={open}
      onToggle={() => { setOpen(!open) }}
      readOnly={disabled}
      readOnlyLabel={t('readOnly')}
    >
      <NumberField
        id="plugin-config-bash-timeout"
        label={t('bashTimeoutMs')}
        hint={t('bashTimeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        overridden={state.timeoutMs.overridden}
        disabled={disabled}
        value={state.timeoutMs.value}
        onCommit={props.setTimeoutMs}
        onReset={props.resetTimeoutMs}
      />
      <NumberField
        id="plugin-config-bash-output"
        label={t('bashMaxOutputBytes')}
        hint={t('bashMaxOutputBytesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        overridden={state.maxOutputBytes.overridden}
        disabled={disabled}
        value={state.maxOutputBytes.value}
        onCommit={props.setMaxOutputBytes}
        onReset={props.resetMaxOutputBytes}
      />
    </PluginCard>
  )
}
