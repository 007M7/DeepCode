/**
 * Conversation domain plugin, browser half: skeleton (header/tabs/composer),
 * the 'conversation.view' slot ring (chat entry here; other plugins
 * contribute view tabs through ctx.slots), the chat view's keyed
 * 'conversation.chat.toolview' row hole, scope-addressed ConversationService,
 * minimal details panel. Contract: api-contracts v3 section 7. Thin shell:
 * type surfaces live in contract/, assembly in apply.ts; the implementation
 * domains (skeleton/chat) never import each other — contract/ is their only
 * shared face.
 */
import type { ConversationService } from './service.ts'

export { apply, inject } from './apply.ts'
export { ConversationService } from './service.ts'

export type {
  CallId, ChatStoreState, SelectionTarget, ViewTab,
} from './contract/views.ts'
export type { ToolCallBlock } from './contract/tool-call-model.ts'
export type {
  ChatStore, ChatViewInjected, ChatViewSlotProps, ComposerChainProps, ConversationInjected,
  ConversationSlotProps, ConvViewOwnerProps, ConvViewProps, DetailsInjected, DetailsSlotProps,
  EmptyStateInjected, EmptyStateSlotProps, ToolRowOwnerProps, ToolRowProps,
} from './contract/slots.ts'
// Export discipline: packages/client/AGENTS.md.

declare module 'cordis' {
  interface Context {
    conversation: ConversationService
  }
}
