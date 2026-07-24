/**
 * Slot-ring contract for the conversation package: the 'conversation.view'
 * slot this package declares (the view ring — one list entry per conversation
 * view tab), the chat view's per-tool row hole ('conversation.chat.toolview',
 * keyed on the wire tool name), and the composed props shapes its registrants
 * mount into the layout-owned slots (conversation / details /
 * conversation.empty) plus its own slots. Terminal slot design (§3): full
 * component props are the automatic shares — PropsRuntime<K> (framework
 * standard kit) & PropsRenderSlots<S> (declared children) & PropsStore<H>
 * (declared store's read/write faces) & the injected business face declared
 * here.
 */
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingInteraction, PendingWait, PermissionSelect, SessionId, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
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

/**
 * Injected share of the conversation slot: plain data and callbacks only
 * (design §5 — hooks are framework-made). The store lines that used to ride
 * here live in the declared {@link ChatStore}; ancestry derives from the
 * standard useSessions hook in-component; views render through the declared
 * 'conversation.view' child slot, with this face projecting the tab strip.
 */
export interface ConversationInjected {
  /** View tab read face (uSES triple over the 'conversation.view' slot ledger). */
  views: {
    list(): readonly ViewTab[]
    subscribe(fn: () => void): () => void
    version(): number
  }
  /** Send choreography: trims, clears the draft optimistically, restores it on failure. */
  send(text: string, mode: 'queue' | 'steer'): void
  /** Cancel the in-flight turn (failure surfaces via snapshot.promptError). */
  stop(): void
  /** Navigate to another session (breadcrumb ancestors). */
  open(id: SessionId): void
  /** Read the permission select (options + effective current value); null hides the control. */
  permissions(): Promise<PermissionSelect | null>
  /** Switch the permission preset; resolves the confirmed value, or null on failure (caller keeps the old value). */
  setPermission(value: string): Promise<string | null>
}

/**
 * Composer chain currency: what ConversationRoot dispatches at its
 * renderSlotChain site. The owner declares the currency only — never a
 * per-entry contract; takeover packages narrow it in their own selectors
 * (`interactions.find(i => i.kind === ...)`), so new takeover kinds register
 * with zero owner changes.
 */
export interface ComposerChainProps {
  /** The session's live pending waits, in arrival order (snapshot reference). */
  interactions: readonly PendingInteraction[]
}

/** Full conversation-slot component props: runtime & child-render (view ring + composer chain) & store & injected shares. */
export type ConversationSlotProps =
  PropsRuntime<'conversation'> & PropsRenderSlots<'conversation.view' | 'conversation.composer'>
  & PropsStore<ChatStore> & ConversationInjected

/** The pending approval carrier the owner dispatches into the composer chain. */
export type ApprovalWait = PendingWait<'approval'>

/**
 * Approval domain face over the carrier (the ui-question PendingQuestion
 * pattern): render identity and question material forwarded transparently;
 * answer owns the wire encoding — the ApprovalResponsePayload value shape
 * with the audit correlation the host reconciles — and turns a rejected
 * carrier receipt into a thrown error. Minted per carrier via useMemo.
 */
export class PendingApproval {
  /**
   * @param wait - the runtime carrier for one pending approval question.
   */
  constructor(private readonly wait: ApprovalWait) {}

  /** Opaque render identity (React key / one-shot latch remount axis), forwarded from the carrier. */
  get key(): string {
    return this.wait.key
  }

  /** The tool the question is about (headline fallback), forwarded from the carrier payload. */
  get toolName(): string {
    return this.wait.payload.toolName
  }

  /** The asker's human-readable WHY (headline when present), forwarded from the carrier payload. */
  get reason(): string | undefined {
    return this.wait.payload.reason
  }

  /** The paired tool call's id when the ask names one (command-line lookup key), forwarded from the carrier payload. */
  get callId(): string | undefined {
    return this.wait.payload.callId
  }

  /**
   * Deliver the user's decision; a rejected carrier receipt throws. Panel
   * removal stays frame-driven: the broadcast `approval/resolved` settles the
   * wait and drops it from the pending list.
   * @param outcome - the only two client-answerable outcomes.
   */
  async answer(outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const receipt = await this.wait.respond({
      ok: true,
      value: { sessionId: this.wait.sessionId, approvalId: this.wait.payload.approvalId, outcome },
    })
    if (!receipt.accepted) {
      throw new Error(`approval response rejected: ${receipt.reason}`)
    }
  }
}

/**
 * Full approval-composer props: the framework runtime share (chain currency +
 * session/global standard kit) plus the chain `matched` share — the entry's
 * selector result, already narrowed to the approval carrier. No injected
 * share: the carrier plus the domain face above carry the whole behavior
 * surface; the paired command line derives from useSession in-component.
 */
export type ApprovalComposerProps = PropsRuntime<'conversation.composer'> & { matched: ApprovalWait }

/**
 * Injected share of the chat view entry: the two callbacks whose targets live
 * outside the view (layout orchestration; the session object layer).
 */
export interface ChatViewInjected {
  /** Selection write + details panel opening in one gesture (store action + layout orchestration). */
  openDetails(target: SelectionTarget): void
  /** Pull one older history page. */
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

/** Injected share of the no-session empty-state slot. */
export interface EmptyStateInjected {
  /** The create → navigate → first-send chain, in one service call. */
  startSession(opts: { cwd?: string; text: string; mode: 'queue' | 'steer' }): Promise<void>
  /**
   * Create a workspace folder under the host cwd, mint a session there, and
   * open it (Create-new modal success path).
   */
  createWorkspaceSession(name: string): Promise<void>
}

/** Full empty-state component props (root slot: no store; cwd options derive from useSessions in-component). */
export type EmptyStateSlotProps = PropsRuntime<'conversation.empty'> & EmptyStateInjected
