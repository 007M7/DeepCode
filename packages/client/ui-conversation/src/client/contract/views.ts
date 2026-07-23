/**
 * Shared conversation contract primitives: the view tab projection (slot
 * entries in 'conversation.view' surface as tabs), the chat store state
 * shared through the declared store, and the selection primitives every
 * domain consumes. Shared face between the skeleton domain (tab strip +
 * view outlet) and the chat domain; domain implementation files import this,
 * never each other. The view ring itself IS the 'conversation.view' slot
 * (contract in slots.ts) — the package-local view registry is retired, and
 * so is the hand-threaded translate channel (framework-level per-slot i18n
 * injection is the planned replacement).
 */

/** Tool call identity as carried on the wire (branded upstream in connection). */
export type CallId = string

/** Selection target for the details linkage channel (toolcall is the step special case). */
export interface SelectionTarget { turnSeq: number; stepSeq?: number; callId?: CallId; toolName?: string }

/**
 * One conversation view tab, projected from a 'conversation.view' slot
 * entry's registration options (label falls back to the entry id).
 */
export interface ViewTab { id: string; label: string }

/**
 * Chat store state (slot terminal design §4): the per-session store shared by
 * the conversation, chat-view, and details registrations. `createChatStore`
 * implements this shape. `view` may carry a stale persisted id after a view
 * plugin unloads — the slot ledger is the runtime validator (unknown ids fall
 * back to the first registered view).
 */
export interface ChatStoreState {
  /** Details-linkage channel (conversation writes, details reads). */
  selection: SelectionTarget | null
  /** Composer draft (persisted; survives session switches and reloads). */
  draft: string
  /** Active conversation view id ('conversation.view' entry id); null falls back to the first view. */
  view: string | null
}
