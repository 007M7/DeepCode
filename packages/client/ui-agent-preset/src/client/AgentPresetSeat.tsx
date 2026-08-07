/**
 * Composer seat for the session's agent preset.
 *
 * The switch exists only while the conversation has not started: after the
 * first turn the session's history was produced under this preset's tools, so
 * the seat becomes a plain label rather than offering a choice it cannot honor.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the agentPreset seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentPresetSeatState } from './seat-store.ts'
import { PresetMenu } from './PresetMenu.tsx'
import css from './AgentPresetSeat.module.css'

/** Registration-side business face for the composer seat. */
export interface AgentPresetSeatInjected {
  hooks: {
    /** Seat snapshot bound by the renderer as useAgentPresetSeat. */
    agentPresetSeat: SnapshotStore<AgentPresetSeatState>
  }
  /** Load the roster and this session's state when the seat first renders. */
  load: () => Promise<void>
  /** Switch this session to another preset. */
  select: (id: string) => Promise<void>
}

/** Full component props. */
export type AgentPresetSeatProps =
  PropsRuntime<'conversation.input.agentPreset'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetSeatInjected>

/**
 * Render the session's agent-preset seat.
 * @param props - composed slot props; `locked` is the composer's own busy state.
 * @returns the seat, or null when the deployment composes no presets.
 */
export function AgentPresetSeat({ load, select, useAgentPresetSeat, locked, t }: AgentPresetSeatProps) {
  const state = useAgentPresetSeat(snapshot => snapshot)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.switchable) return
    setOpen(false)
  }, [state.switchable])

  // Nothing to choose between: the deployment composes no presets and every
  // session shares the host composition.
  if (state.options.length === 0 || state.current === '') return null

  // Past the first turn the preset is a fact about this session, not a
  // control — showing a disabled menu would suggest it could still be changed.
  if (!state.switchable) {
    return <span className={`${css.seat} ${css.locked}`} title={t('lockedHint')}>{state.current}</span>
  }

  return (
    <PresetMenu
      options={state.options}
      selectedId={state.current}
      label={state.current}
      userTrustLabel={t('userTrust')}
      buttonClassName={css.seat}
      chevronClassName={css.chevron}
      disabled={locked || state.busy}
      title={state.error ?? t('seatHint')}
      open={open}
      onOpenChange={setOpen}
      onSelect={(id) => { void select(id) }}
    />
  )
}
