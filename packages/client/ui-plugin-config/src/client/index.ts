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
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { bindSettingsScope, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
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
export { SecretField, ValueField, type FieldProps } from './fields.tsx'
export {
  CardForm, numberField, textField,
  type CardActions, type CardFieldSpec, type CardFieldState, type CardSecretSpec, type CardShell,
} from './card-store.ts'
export { AGENT_LOOP_NS, AgentLoopCardController, type AgentLoopCardState } from './agent-loop-store.ts'
export { BASH_NS, BashCardController, type BashCardState } from './bash-store.ts'
export { WEB_SEARCH_NS, WebSearchCardController, type WebSearchCardState } from './web-search-store.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.pluginConfig'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Mount the plugin configuration section and the cards this package ships.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plugin-config: section dictionaries')

  const bash = new BashCardController(bindSettingsScope(ctx, { namespace: BASH_NS }))
  const agentLoop = new AgentLoopCardController(bindSettingsScope(ctx, { namespace: AGENT_LOOP_NS }))
  const webSearch = new WebSearchCardController(bindSettingsScope(ctx, { namespace: WEB_SEARCH_NS }), api)

  // The section renders the empty line rather than an empty list when no card
  // is registered; the ledger is read at render time so a card arriving later
  // (or leaving with its plugin) is reflected without the section subscribing.
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
