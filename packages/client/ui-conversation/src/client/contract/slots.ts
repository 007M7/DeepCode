/**
 * Slot-ring contract for the conversation package: the composed props shapes
 * its registrants mount into the layout-owned slots (conversation / details /
 * conversation.empty). Terminal slot design (§3): full component props are the
 * automatic shares — PropsRuntime<K> (framework standard kit) & PropsStore<H>
 * (declared store's read/write faces) & the injected business face declared
 * here. No renderSlot share: none of the three registrations declares
 * children, so the zero-renderSlot inference applies.
 */
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { createChatStore } from '../stores.ts'
import type { SelectionTarget, ViewEntry } from './views.ts'

/** The shared chat store handle type (apply constructs one; conversation and details both declare it). */
export type ChatStore = ReturnType<typeof createChatStore>

/**
 * Injected share of the conversation slot: plain data and callbacks only
 * (design §5 — hooks are framework-made). The store lines that used to ride
 * here live in the declared {@link ChatStore} now; ancestry derives from the
 * standard useSessions hook in-component; view rendering moved into the
 * component, which holds every share a view needs.
 */
export interface ConversationInjected {
  /** View registry read face (uSES triple from the conversation service). */
  views: {
    list(): readonly ViewEntry[]
    subscribe(fn: () => void): () => void
    version(): number
  }
  /** Send choreography: trims, clears the draft optimistically, restores it on failure. */
  send(text: string, mode: 'queue' | 'steer'): void
  /** Cancel the in-flight turn (failure surfaces via snapshot.promptError). */
  stop(): void
  /** Selection write + details panel opening in one gesture (store action + layout orchestration). */
  openDetails(target: SelectionTarget): void
  /** Pull one older history page. */
  loadOlder(): void
  /** Navigate to another session (breadcrumb ancestors). */
  open(id: SessionId): void
}

/** Full conversation-slot component props: runtime share & store share & injected share. */
export type ConversationSlotProps =
  PropsRuntime<'conversation'> & PropsStore<ChatStore> & ConversationInjected

/**
 * Injected share of the details slot: the panel is otherwise a pure reader of
 * the shared chat store, but its close button is a layout orchestration call.
 */
export interface DetailsInjected {
  /** Close the details panel (layout geometry stays with ctx.layout). */
  closeDetails(): void
}

/** Full details-slot component props: selection arrives through the shared store, call material through useSession. */
export type DetailsSlotProps = PropsRuntime<'details'> & PropsStore<ChatStore> & DetailsInjected

/** Injected share of the no-session empty-state slot. */
export interface EmptyStateInjected {
  /** The create → navigate → first-send chain, in one service call. */
  startSession(opts: { cwd?: string; text: string; mode: 'queue' | 'steer' }): Promise<void>
}

/** Full empty-state component props (root slot: no store; cwd options derive from useSessions in-component). */
export type EmptyStateSlotProps = PropsRuntime<'conversation.empty'> & EmptyStateInjected
