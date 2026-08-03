/**
 * Agent-preset surface plugin, browser half — one General-settings row that
 * writes the default preset for sessions created later.
 *
 * A running session keeps the composition it began with (the host refuses to
 * adopt an existing session under a different preset), so this row is a
 * new-session preference rather than a live switch. Per-session choice at
 * creation time belongs to the session-start surface, which reads the same
 * roster.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentPresetRow } from './AgentPresetRow.tsx'
import type { AgentPresetRowInjected } from './AgentPresetRow.tsx'
import { en, zh } from './locales.ts'
import { AGENT_PRESET_SETTINGS_NS, AgentPresetSettingsController } from './settings-store.ts'

export type { AgentPresetRowInjected, AgentPresetRowProps } from './AgentPresetRow.tsx'
export type { AgentPresetOption, AgentPresetSettingsState } from './settings-store.ts'
export { AGENT_PRESET_SETTINGS_NS } from './settings-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Mount the General-settings row.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new AgentPresetSettingsController((ctx.get('connection') as ConnectionHandle).api)

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
    }
    const disposers = [
      ctx.on('settings/changed', refresh),
      ctx.on('connection/reset', () => { refresh() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-agent-preset: settings refresh')

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'agent-preset',
    order: -25,
    locale: 'settings.agentPreset',
    inject: injected,
  }, AgentPresetRow))
}
