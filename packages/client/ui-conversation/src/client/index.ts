/**
 * Browser conversation plugin. `contract/` is the shared type boundary
 * between the independently implemented skeleton and chat domains; `apply.ts`
 * owns their slot assembly.
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
  EmptyStateInjected, EmptyStateSlotProps, EmptyWorkspaceOwnerProps, ToolRowOwnerProps, ToolRowProps,
} from './contract/slots.ts'
// Export discipline: packages/client/AGENTS.md.

declare module 'cordis' {
  interface Context {
    conversation: ConversationService
  }
}
