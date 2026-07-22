/**
 * Chat-side registration entry, called from the plugin apply (the assembly
 * point): registers the chat view with the stats-line footer chrome. The
 * chat domain touches the tool ring only through the contract resolver face;
 * bash sample registration moved to apply (cross-domain assembly).
 */
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationService } from '../service.ts'
import type { Translate } from '../contract/views.ts'
import type { ToolViewResolver } from '../contract/toolview.ts'
import { createChatView } from './ChatView.tsx'
import { StatsLine } from './StatsLine.tsx'

/** Read face of the sessions list store (subscription not needed: the filter
 *  reads the latest snapshot at each resolve). */
export interface SessionListReader { getSnapshot(): SessionListState }

/**
 * Default scoped-sample filter: the sub-session family. Sub-agent rows
 * rendering differently is the registry's canonical product scenario, and
 * forking gives W5 acceptance a real entry point to observe the differential.
 * @param list - injected sessions list read face.
 * @returns filter matching sessions with a parent.
 */
export function childSessionScope(list: SessionListReader): (sessionId: SessionId) => boolean {
  return sessionId => list.getSnapshot().byId[sessionId]?.parentId !== undefined
}

/** Assembly inputs for {@link registerChat} (resolved by apply, not here). */
export interface RegisterChatDeps {
  conversation: ConversationService
  /** Toolview read face consumed by the chat rows' outlet. */
  toolviews: ToolViewResolver
  /** Translator bound to the conversation namespace. */
  t: Translate
}

/**
 * Register the chat view (footer chrome included).
 * @param deps - assembled service instances.
 * @returns disposer removing the registration.
 */
export function registerChat(deps: RegisterChatDeps): () => void {
  const { conversation, toolviews, t } = deps
  return conversation.registerView({
    id: 'chat',
    label: 'Chat',
    order: 0,
    component: createChatView({ toolviews, t }),
    chrome: { footer: StatsLine },
  })
}
