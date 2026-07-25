/** Conversation slot declarations and their composed component props. */
import type { RefObject } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingInteraction, SessionId, ToolCallBlock, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { createChatStore } from '../stores.ts'
import type { CallId, SelectionTarget, ViewTab } from './views.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The conversation view ring: one list entry per view tab (chat here;
     * trajectory/waterfall from ui-trajectory), rendered one-at-a-time by
     * ConversationRoot via `only: <active id>`. Declared by this package's
     * 'conversation' entry (declaring is claiming). Session scope: views read
     * the conversation snapshot through the standard kit.
     */
    'conversation.view': { kind: 'list'; scope: 'session'; owner: ConvViewOwnerProps }
    /**
     * The chat view's per-tool row hole: keyed dispatch on the wire tool name
     * (the key space is runtime-open — SlotMap declares slots, never keys).
     * Declared by the chat view entry (declaring is claiming); the render
     * site dispatches via `entryKey: toolName` with GenericToolCard as the
     * `fallback` for unregistered tools.
     */
    'conversation.chat.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolRowOwnerProps }
    /**
     * The composer takeover chain: entries are selector-routed replacements
     * of the default InputBar. Declared by this package's 'conversation'
     * entry; the owner dispatches the {@link ComposerChainProps} currency and
     * routing lives in entry selectors — new takeover kinds register with
     * zero owner changes.
     */
    'conversation.composer': { kind: 'chain'; scope: 'session'; owner: ComposerChainProps }
    /** Shared Workspace picker hole used by the page-local Session Intent hero. */
    'conversation.empty.workspace': { kind: 'single'; scope: 'root'; owner: EmptyWorkspaceOwnerProps }
  }
}

/**
 * View-slot owner share: deliberately empty — ConversationRoot supplies
 * nothing at its renderSlot site (sessionId and the snapshot hook arrive as
 * framework-standard props; tool rows go through each view's own declared
 * toolview hole). Kept as the named owner seat so a future cross-view
 * payload has a home.
 */
export interface ConvViewOwnerProps {}

/**
 * Owner share of a per-view toolview slot: the call material the rendering
 * view supplies per row. Uniform across views — the trajectory/waterfall
 * toolview slots (same kind/scope/owner, names fixed by the slot-naming
 * discipline) land with their own row render sites; today only the chat slot
 * is declared (RendersCheck rejects a declaration nobody renders).
 */
export interface ToolRowOwnerProps {
  /** Tool call identity (details linkage; stable across running → settled). */
  callId: CallId
  /** Wire tool name (also the keyed dispatch key at the render site). */
  toolName: string
  /** Frozen call slice: the running call or the settled result node. */
  block: ToolCallBlock
  /** Open the details panel for this call (session-level facility, supplied by the view). */
  openDetails(): void
}

/**
 * Full props of a registered tool-row component: the slot's runtime share
 * (owner payload + session standard kit + global seat). Registrants type
 * their component `FC<ToolRowProps & I>` with `I` inferred from their inject
 * factory. Declared against the chat slot; the three per-view toolview slots
 * share one declaration shape, so this alias serves them all.
 */
export type ToolRowProps = PropsRuntime<'conversation.chat.toolview'>

/**
 * Base props of a conversation view entry: the framework standard kit for the
 * session-scope 'conversation.view' slot (useSession narrowed to the
 * conversation snapshot by the runtime merge, sessionId, useSessions).
 * Entries declaring the shared store or an inject face compose their shares
 * on top (the chat entry's {@link ChatViewSlotProps}); store-less pure
 * readers (ui-trajectory) take this base alone.
 */
export type ConvViewProps = PropsRuntime<'conversation.view'>

/** The shared chat store handle type (apply constructs one; the conversation, details, and chat-view registrations all declare it). */
export type ChatStore = ReturnType<typeof createChatStore>

/** Business callbacks injected into the conversation slot. */
export interface ConversationInjected {
  /** Views projected from the `conversation.view` slot ledger. */
  views: {
    list(): readonly ViewTab[]
    subscribe(fn: () => void): () => void
    version(): number
  }
  /** Send choreography: trims, clears the draft optimistically, restores it on failure. */
  send(text: string, mode: 'queue' | 'steer'): void
  /** Cancel the in-flight turn (failure surfaces via snapshot.promptError). */
  stop(): void
  /** Select a real Session through the runtime navigation owner. */
  open(sessionId: SessionId): void
  /** Update the scoped Session's retained prompt. */
  updateSessionPrompt(text: string): void
  /** Retry the scoped Session's retained prompt. */
  retrySessionPrompt(): void
}

/**
 * Composer chain currency: what ConversationRoot dispatches at its
 * renderSlotChain site. The owner declares the currency only — never a
 * per-entry contract; takeover packages narrow it in their own selectors
 * (`interactions.find(i => i.kind === ...)`), so new takeover kinds register
 * with zero owner changes.
 */
export interface ComposerChainProps {
  interactions: readonly PendingInteraction[]
}

/** Full conversation-slot component props: runtime & child-render (view ring + composer chain) & store & injected shares. */
export type ConversationSlotProps =
  PropsRuntime<'conversation'> & PropsRenderSlots<'conversation.view' | 'conversation.composer'>
  & PropsStore<ChatStore> & ConversationInjected

/**
 * Injected share of the chat view entry: the two callbacks whose targets live
 * outside the view (layout orchestration; the session object layer).
 */
export interface ChatViewInjected {
  /** Selection write + details panel opening in one gesture (store action + layout orchestration). */
  openDetails(target: SelectionTarget): void
  loadOlder(): void
}

/** Full chat-view component props: runtime share & the declared toolview hole's render share & store share & injected share. */
export type ChatViewSlotProps =
  PropsRuntime<'conversation.view'> & PropsRenderSlots<'conversation.chat.toolview'>
  & PropsStore<ChatStore> & ChatViewInjected

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

/** Owner share common to the empty hero's Workspace picker. */
export interface EmptyWorkspaceOwnerProps {
  open: boolean
  anchorRef?: RefObject<HTMLElement>
  onPick(workspaceId: WorkspaceId): void
  onClose(): void
}

/** Runtime-owned actions injected into the empty-state occupant. */
export interface EmptyStateInjected {
  /** Replace the current Session intent, optionally preserving a prompt while retargeting. */
  startSession(workspaceId?: WorkspaceId, prompt?: string): void
  /** Update the current Session intent's controlled prompt. */
  updateSessionPrompt(text: string): void
  /** Materialize and send the current Session intent. */
  sendSession(): void
}

/** Full empty-state component props: runtime projections, picker child slot, and injected actions. */
export type EmptyStateSlotProps =
  PropsRuntime<'conversation.empty'> & PropsRenderSlots<'conversation.empty.workspace'> & EmptyStateInjected
