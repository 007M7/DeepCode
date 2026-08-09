/**
 * Browser conversation plugin. `contract/` is the shared type boundary
 * between the independently implemented skeleton and chat domains; `apply.ts`
 * owns their slot assembly.
 */
export { apply, inject } from './apply.ts'
export { ConversationService } from './service.ts'
export { registerAssistantConversationNode } from './conversation-nodes/assistant.ts'
export { registerChatConversationView } from './conversation-nodes/chat-snapshot-builder.ts'
export { registerCommandConversationNode } from './conversation-nodes/command.ts'
export { registerCompactionConversationNode } from './conversation-nodes/compaction.ts'
export { registerUnknownConversationFallback } from './conversation-nodes/fallback.ts'
export { registerInboxConversationNodes } from './conversation-nodes/inbox.ts'
export { registerMessageConversationNode } from './conversation-nodes/message.ts'
export { registerRetryConversationNode } from './conversation-nodes/retry.ts'
export { registerToolConversationNode } from './conversation-nodes/tool.ts'
export { registerTurnErrorConversationNode } from './conversation-nodes/turn-error.ts'
export { registerTurnTailConversationNode } from './conversation-nodes/turn-tail.ts'
export type { IConversation } from './service.ts'

export type {
  CallId, ChatStoreState, SelectionTarget, ViewTab,
} from './contract/views.ts'
export type { ConversationKey } from './locales.ts'
export type {
  AssistantChatData, ChatNode, ChatNodeDataMap, ChatNodeKind, ManualCompactionChatData,
  RetryChatData, ToolChatData, TurnTailChatData,
} from './contract/chat-nodes.ts'
export type {
  ChatFileMentions, ChatNodeOwnerProps, ChatNodeViewProps,
  ChatStore, ChatViewInjected, ChatViewSlotProps, CommandRowOwnerProps, CommandRowProps, ComposerBarInjected,
  ComposerChainProps, ConversationInjected,
  ConversationSessionHeaderInjected, ConversationSessionInjected, ConversationSlotProps, ConvViewOwnerProps,
  ConvViewProps, DetailsInjected, DetailsSlotProps, DetailsToolOwnerProps, EmptyWorkspaceOwnerProps,
  TurnTailOwnerProps, UseChatNodeTurnData,
} from './contract/slots.ts'
// Export discipline: packages/client/AGENTS.md.

declare module 'cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    conversation: import('./service.ts').IConversation
  }
}
