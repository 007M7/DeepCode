/**
 * Agent-preset surface plugin, browser half — three surfaces over one roster:
 * a General-settings row for the default preset, a composer seat for the
 * session about to start, and a settings section that authors the compositions
 * themselves.
 *
 * A running session keeps the composition it began with (the host refuses to
 * adopt an existing session under a different preset), so the General row is
 * a new-session preference rather than a live switch, and the seat stops
 * offering a choice once the conversation starts.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentPresetRow } from './AgentPresetRow.tsx'
import type { AgentPresetRowInjected } from './AgentPresetRow.tsx'
import { AgentPresetSeat } from './AgentPresetSeat.tsx'
import type { AgentPresetSeatInjected } from './AgentPresetSeat.tsx'
import { AgentPresetSection } from './AgentPresetSection.tsx'
import type { AgentPresetSectionInjected } from './AgentPresetSection.tsx'
import { AgentPresetSeatController } from './seat-store.ts'
import { AgentPresetSectionController } from './section-store.ts'
import { en, zh } from './locales.ts'
import { AGENT_PRESET_SETTINGS_NS, AgentPresetSettingsController } from './settings-store.ts'

export type { AgentPresetRowInjected, AgentPresetRowProps } from './AgentPresetRow.tsx'
export type { AgentPresetSeatInjected, AgentPresetSeatProps } from './AgentPresetSeat.tsx'
export type { AgentPresetSectionInjected, AgentPresetSectionProps } from './AgentPresetSection.tsx'
export type { AgentPresetSeatState } from './seat-store.ts'
export {
  draftBlocker, type AgentPresetSectionState, type PresetDraft, type PresetRow,
} from './section-store.ts'
export type { AgentPresetOption, AgentPresetSettingsState } from './settings-store.ts'
export { AGENT_PRESET_SETTINGS_NS, writeDefaultPreset } from './settings-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Mount the General-settings row.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const controller = new AgentPresetSettingsController(api)
  const section = new AgentPresetSectionController(api)

  ctx.effect(() => ctx.locale.register('settings.agentPreset', { zh, en }), 'ui-agent-preset: settings row dictionaries')

  const injected = (): AgentPresetRowInjected => ({
    hooks: { agentPreset: controller.store },
    load: () => controller.load(),
    select: (id: string) => controller.select(id),
  })

  ctx.effect(() => {
    // The roster is a live directory and the default is a settings field, so
    // both an external settings edit and a reconnect can move this row.
    const refresh = (ns?: string): void => {
      if (ns !== undefined && ns !== AGENT_PRESET_SETTINGS_NS) return
      void controller.load()
      // The section reads the same roster and marks the same default, so a
      // change made from either surface converges both.
      if (section.store.getSnapshot().status !== 'idle') void section.load()
    }
    const disposers = [
      ctx.on('settings/changed', refresh),
      ctx.on('connection/reset', () => { refresh() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-agent-preset: settings refresh')

  // The composer seat: one controller per session, because the switch and the
  // "may it still switch" bit are both per-session facts.
  ctx.inject(['slots', 'conversation', 'sessions'], (scope: ClientContext) => {
    const api = (scope.get('connection') as ConnectionHandle).api
    const seats = new Map<SessionId, AgentPresetSeatController>()
    const seatFor = (sessionId: SessionId): AgentPresetSeatController => {
      const existing = seats.get(sessionId)
      if (existing !== undefined) return existing
      const created = new AgentPresetSeatController(api, sessionId, () => {
        const summary = scope.sessions.list.getSnapshot().byId[sessionId]
        return summary === undefined
          ? undefined
          : { blank: summary.blank, ...summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset } }
      })
      seats.set(sessionId, created)
      return created
    }
    scope.effect(() => scope.slots.register({
      name: 'conversation.input.agentPreset',
      locale: 'settings.agentPreset',
      inject: (sessionId: SessionId): AgentPresetSeatInjected => {
        const seat = seatFor(sessionId)
        return {
          hooks: { agentPresetSeat: seat.store },
          load: () => seat.load(),
          select: (id: string) => seat.select(id),
        }
      },
    }, AgentPresetSeat), 'ui-agent-preset: composer seat registration')
  })

  const sectionInjected = (): AgentPresetSectionInjected => ({
    hooks: { agentPresetSection: section.store },
    load: () => section.load(),
    open: (id: string) => section.open(id),
    createFrom: (from?: string) => section.createFrom(from),
    close: () => { section.close() },
    setId: (id: string) => { section.setId(id) },
    setContent: (content: string) => { section.setContent(content) },
    save: () => section.save(),
    confirmDelete: (id: string | null) => { section.confirmDelete(id) },
    remove: () => section.remove(),
    makeDefault: (id: string) => section.makeDefault(id),
  })

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'agent-preset',
    order: -25,
    locale: 'settings.agentPreset',
    inject: injected,
  }, AgentPresetRow))
  // Ordered after Models: choosing a model is routine, and composing an
  // agent is the deployment-shaping act behind it.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agent-presets',
    order: 20,
    label: () => ctx.locale.bind('settings.agentPreset')('nav'),
    locale: 'settings.agentPreset',
    inject: sectionInjected,
  }, AgentPresetSection))
}
