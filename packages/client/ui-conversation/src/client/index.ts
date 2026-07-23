/**
 * Conversation domain plugin, browser half: skeleton (header/tabs/composer),
 * typed view registry, scope-addressed ConversationService, named toolview
 * registry, minimal details panel. Contract: api-contracts v3 section 7.
 * Thin shell: type surfaces live in contract/, assembly in apply.ts; the
 * three implementation domains (skeleton/chat/toolviews) never import each
 * other — contract/ is their only shared face.
 */
import type { ConversationService } from './service.ts'
import type { ToolViewRegistry } from './toolviews/registry.ts'

export { apply, inject } from './apply.ts'
export { ConversationService } from './service.ts'
export { ToolViewRegistry } from './toolviews/registry.ts'

export type {
  CallId, ChatStoreState, ChromeProps, ChromePropsOf, ConversationViewMap, ConvViewProps,
  ConvViewPropsOf, SelectionTarget, Translate, ViewEntry, ViewEntryDef, ViewId,
} from './contract/views.ts'
export type {
  ResolvedToolView, ToolCallBlock, ToolViewOptions, ToolViewProps, ToolViewResolver,
} from './contract/toolview.ts'
export type {
  ChatStore, ConversationInjected, ConversationSlotProps, DetailsInjected, DetailsSlotProps,
  EmptyStateInjected, EmptyStateSlotProps,
} from './contract/slots.ts'
// Export discipline: packages/client/AGENTS.md.

declare module 'cordis' {
  interface Context {
    conversation: ConversationService
    toolviews: ToolViewRegistry
  }
}
