/**
 * Browser conversation plugin. `contract/` is the shared type boundary
 * between the independently implemented skeleton and chat domains; `apply.ts`
 * owns their slot assembly.
 */
export { apply, inject } from './apply.ts'
export type { IConversation } from './service.ts'
export type { DraftAttachmentId } from './input/contract.ts'

export type {
  CallId, ChatStoreState, SelectionTarget, ViewTab,
} from './contract/views.ts'
export type { ToolCallBlock } from './contract/tool-call-model.ts'
export type { ConversationKey } from './locales.ts'
export type {
  ChatStore, ChatViewInjected, ChatViewSlotProps, CommandRowOwnerProps, CommandRowProps,
  ComposerAttachment, ComposerBarInjected, ComposerChainProps, ConversationInjected,
  ConversationSessionHeaderInjected, ConversationSessionInjected, ConversationSlotProps,
  ConvViewOwnerProps, ConvViewProps, DetailsInjected, DetailsSlotProps,
  EmptyWorkspaceOwnerProps, ToolRowOwnerProps, ToolRowProps, TurnTailOwnerProps,
} from './contract/slots.ts'
// Export discipline: packages/client/AGENTS.md.

declare module 'cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    conversation: import('./service.ts').IConversation
  }
}
