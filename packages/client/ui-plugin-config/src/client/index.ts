/**
 * Plugin configuration surface, browser half — one settings section holding
 * an expandable card per Host plugin whose configuration a user owns.
 *
 * The section owns no knowledge of any namespace: it declares the
 * `settings.plugin.item` slot and renders whatever cards were registered into
 * it, so a plugin that ships a browser half contributes its own card and its
 * own controls. The three cards this package registers are the host-plane
 * sections the deployment already exposes; each binds its namespace through
 * the client settings scope, which keeps them unaware of one another.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry)
// and the ctx.settingsScope Context merge. Cross-plugin collaboration goes
// through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AgentLoopCard } from './AgentLoopCard.tsx'
import { BashCard } from './BashCard.tsx'
import { PluginConfigSection } from './PluginConfigSection.tsx'
import { WebSearchCard } from './WebSearchCard.tsx'
import { AGENT_LOOP_NS, AgentLoopCardController } from './agent-loop-store.ts'
import { BASH_NS, BashCardController } from './bash-store.ts'
import { WEB_SEARCH_NS, WebSearchCardController } from './web-search-store.ts'
import { en, zh } from './locales.ts'

export type { PluginConfigSectionInjected, PluginConfigSectionProps } from './PluginConfigSection.tsx'
export type { PluginCardProps } from './PluginCard.tsx'
export type { SettingsPluginItemOwnerProps } from './slot-contract.ts'
export type { FieldProps } from './fields.tsx'
export type {
  CardActions, CardFieldSpec, CardFieldState, CardSecretSpec, CardShell,
} from './card-store.ts'
export type { AgentLoopCardFace, AgentLoopCardState } from './agent-loop-store.ts'
export type { BashCardFace, BashCardState } from './bash-store.ts'
export type { WebSearchCardFace, WebSearchCardState } from './web-search-store.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.pluginConfig'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Mount the plugin configuration section and the cards this package ships.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plugin-config: section dictionaries')

  const bash = new BashCardController(ctx.settingsScope.bind({ namespace: BASH_NS }))
  const agentLoop = new AgentLoopCardController(ctx.settingsScope.bind({ namespace: AGENT_LOOP_NS }))
  const webSearch = new WebSearchCardController(ctx.settingsScope.bind({ namespace: WEB_SEARCH_NS }), api)

  // The credential a card reports is not part of any settings section, so its
  // scope publishes nothing when one is written. This is the only signal that
  // a key written on another surface reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/updated', (ref) => { webSearch.refreshCredential(ref) }),
    'ui-plugin-config: credential invalidations',
  )

  // The section renders the empty line rather than an empty list when no plugin
  // contributed a card. The count is read once: the renderer caches a root
  // entry's inject face per registration, so this reports what was registered
  // when the section mounted, not what is visible now. Both gaps are bounded by
  // this deployment always registering the three cards below — a card that
  // arrives later would not raise the count, and a namespace this deployment
  // does not expose leaves its card rendering nothing inside a non-empty list.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugins',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ cardCount: ctx.slots.entries('settings.plugin.item').length }),
    children: { 'settings.plugin.item': { kind: 'list', scope: 'root' } },
  }, PluginConfigSection))

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'bash',
      order: 0,
      locale: NS,
      inject: () => bash.inject(),
    }, BashCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'agent-loop',
      order: 10,
      locale: NS,
      inject: () => agentLoop.inject(),
    }, AgentLoopCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'web-search',
      order: 20,
      locale: NS,
      inject: () => webSearch.inject(),
    }, WebSearchCard)
  })
}
