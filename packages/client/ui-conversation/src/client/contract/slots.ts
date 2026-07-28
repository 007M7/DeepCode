/** Conversation slot declarations and their composed component props. */
import type { ReactNode, RefObject } from 'react'
import type {
  InjectFace, MaybeSnapshotSelectorHook, PropsRenderSlots, PropsRuntime, PropsStore, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandNode, ConversationSnapshot, ObservableSnapshot, PendingInteraction, SessionId, ToolCallBlock, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ComposerKeyboard, InputActions, InputNotice, InputState } from '../input/contract.ts'
import type { createChatStore } from '../stores.ts'
import type { CallId, SelectionTarget, ViewTab } from './views.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Strict-session content inside the resident conversation shell. This
     * subtree owns the per-session chat store, header, and view ring and is
     * remounted when the current session id changes.
     */
    'conversation.session': { kind: 'single'; scope: 'session'; owner: ConversationSessionOwnerProps }
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
     * The chat view's per-command row hole: keyed dispatch on the command
     * name (`command/run.name`; a run-less cross-window node has none and
     * always lands on the fallback). Declared by the chat view entry; the
     * render site dispatches via `entryKey: name` with GenericCommandCard as
     * the `fallback` — a slash command renders durably with zero
     * registration, and a domain upgrades by registering one row component.
     */
    'conversation.chat.commandview': { kind: 'keyed'; scope: 'session'; owner: CommandRowOwnerProps }
    /**
     * The composer takeover chain: entries are selector-routed replacements
     * of the default InputBar. Declared by this package's 'conversation'
     * entry; the owner dispatches the {@link ComposerChainProps} currency and
     * routing lives in entry selectors — new takeover kinds register with
     * zero owner changes.
     */
    'conversation.composer': { kind: 'chain'; scope: 'session'; owner: ComposerChainProps }
    /**
     * The hero-phase Workspace picker hole: rendered by ConversationRoot
     * while the session is blank (picking another workspace switches to that
     * workspace's blank session, draft carried). Root scope: the picker
     * reads the global workspace list.
     */
    'conversation.hero.workspace': { kind: 'single'; scope: 'root'; owner: EmptyWorkspaceOwnerProps }
    // 'conversation.input.overlay' merges in ui-slash (dedup ruling: the
    // dependency direction is the hard constraint — ui-slash cannot import
    // this package, while this package's input contract already imports
    // ui-slash, so the type arrives transitively). The runtime declaration
    // (children table in apply.ts) stays here with the other input slots.
    /**
     * Stacked strip above the input (queue rows / GoalBar / attachments;
     * design §6 MIX evidence: entries coexist in fixed order).
     */
    'conversation.input.dock': { kind: 'list'; scope: 'session'; owner: InputZone }
    /** The composer top-edge band (stats line family). */
    'conversation.composer.dock': { kind: 'list'; scope: 'session'; owner: InputZone }
    /** Tool-row left region inside the input card (existing chrome stays in place beside entries). */
    'conversation.input.left': { kind: 'list'; scope: 'session'; owner: InputZone }
    /** Tool-row right region inside the input card. */
    'conversation.input.right': { kind: 'list'; scope: 'session'; owner: InputZone }
    /**
     * The default composer body: a single slot rendered as the composer
     * chain's fallback (decision 20 — a real entry, not a chain rider, so a
     * takeover election hides rather than unmounts it and the textarea DOM
     * survives). InputBar registers here from this package's apply; its
     * machine state arrives through the standard provide channel (useInput +
     * inputActions), the keyboard command face through its own inject.
     */
    'conversation.composer.bar': { kind: 'single'; scope: 'session'; owner: ComposerBarOwnerProps }
    /**
     * The Plan-mode status seat in the composer tool row (left group,
     * right of the access-mode control). Declared by the composer-bar
     * entry; empty until a plan plugin registers (B ruling: no placeholder
     * fallback).
     */
    'conversation.input.plan': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
    /**
     * The model-select seat in the composer tool row (right group). Same
     * empty-until-registered contract as the plan seat.
     */
    'conversation.input.model': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
  }

  /**
   * ui-conversation's members of the session standard kit, provided through
   * `sessions.provide` (decision 19/20): every session-scope slot component
   * receives the input machine's state hook and the two public actions.
   */
  interface SessionStandardProps {
    /** Selector hook over the session's live input machine state. */
    useInput: SnapshotSelectorHook<InputState>
    /** The public input action face (stable identity per session). */
    inputActions: InputActions
  }

  /** Input members for the resident composer while current session is optional. */
  interface SessionMaybeStandardProps {
    useInput: MaybeSnapshotSelectorHook<InputState>
    inputActions: InputActions | undefined
  }
}

/** Owner share of the strict session content seat. */
export interface ConversationSessionOwnerProps {
}

/**
 * The input-region slot currency (plan §1.4): dock/left/right entries read
 * the conversation snapshot and the live input state as owner props (both
 * are point-in-time snapshots — the dispatching skeleton re-renders on
 * either store's change, so entries stay current without subscribing).
 */
export interface InputZone {
  readonly session: ConversationSnapshot
  readonly input: InputState
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
  /** Session workspace root; path summaries display relative to it. */
  cwd?: string | undefined
  /**
   * Open a tool-arg filesystem path with the host OS default application.
   * The chat view resolves relative paths against the session cwd.
   */
  openFile: (path: string) => void
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
 * Owner share of the per-command row slot: the frozen {@link CommandNode}
 * slice off the snapshot (cache-stable reference — memo premise). The node
 * carries the whole lifecycle (structured name/args, pairing id,
 * outcome-or-executing), so a
 * registrant needs no second data channel; domain state arrives through its
 * own projection cell.
 */
export interface CommandRowOwnerProps {
  /** Folded command lifecycle node (run + optional done). */
  node: CommandNode
}

/** Full props of a registered command-row component (same shape rule as {@link ToolRowProps}). */
export type CommandRowProps = PropsRuntime<'conversation.chat.commandview'>

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
  /**
   * Connect the selected Workspace and open its reusable/new blank session.
   * When a blank session is already current, carry its draft to the target.
   */
  selectWorkspace: (workspaceId: WorkspaceId) => Promise<void>
}

/** Business callbacks injected into the strict session content seat. */
export interface ConversationSessionInjected {
  /** Views projected from the `conversation.view` slot ledger. */
  views: {
    list: () => readonly ViewTab[]
    subscribe: (fn: () => void) => () => void
    version: () => number
  }
  /** Bind the input machine's draft persistence mirror to the session store. */
  bindDraftMirror: (write: (text: string) => void) => () => void
  /** Select a real Session through the runtime navigation owner. */
  open: (sessionId: SessionId) => void
}

/**
 * Owner share of the composer-bar slot: ConversationRoot's layout-phase
 * inputs plus the input-region child-slot content it renders (the region
 * slots stay declared/rendered by the conversation entry; the bar hosts the
 * results as chrome).
 */
export interface ComposerBarOwnerProps {
  /** Hero = empty-state centered card; composer = resident bottom bar. */
  variant: 'hero' | 'composer'
  placeholder?: string
  /** Optional content rendered above the textarea. */
  accessory?: ReactNode
  /** Floating overlay anchor content (menu / popup shell entries), rendered inside the card. */
  overlay?: ReactNode
  /** input.left slot entries (tool row, beside the resident chrome). */
  leftItems?: ReactNode
  /** input.right slot entries (tool row, before the primary button). */
  rightItems?: ReactNode
  onAdd?: () => void
  addLabel?: string
}

/** Injected share of the composer-bar entry (package-internal faces). */
export interface ComposerBarInjected {
  /** The InputBar-exclusive keyboard/DOM command face (decision 20 private plane). */
  keyboard: ComposerKeyboard
  /** Cancel the in-flight turn. */
  stop: () => void
  /** Registrant hooks compartment: the renderer binds these to useNotices/useLexicon. */
  hooks: {
    /** Latest surfaced notice (null after none; seq keys re-render of repeats). */
    notices: ObservableSnapshot<InputNotice | null>
    /** Hot plain-text reference lexicon for the decoration scan (decision 21). */
    lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>>
  }
}

/**
 * Owner share of the two named composer control seats (plan / model): the
 * bar passes its disable state; the filling entry owns everything else.
 */
export interface InputControlOwnerProps {
  /** Session-removed lock (the bar's chrome disable state). */
  locked: boolean
}

/** Full composer-bar component props: standard kit & owner share & control-seat render share & injected share (hooks compartment bound). */
export type ComposerBarProps =
  PropsRuntime<'conversation.composer.bar'>
  & PropsRenderSlots<'conversation.input.plan' | 'conversation.input.model'>
  & InjectFace<ComposerBarInjected>

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

/**
 * Full conversation-slot component props: runtime & child-render (view ring
 * + composer chain/bar + input-region + hero picker slots) & store & injected shares.
 */
export type ConversationSlotProps =
  PropsRuntime<'conversation'> & PropsRenderSlots<
    | 'conversation.session' | 'conversation.composer' | 'conversation.composer.bar'
    | 'conversation.input.overlay'
    | 'conversation.input.dock' | 'conversation.composer.dock'
    | 'conversation.input.left' | 'conversation.input.right'
    | 'conversation.hero.workspace'
  >
  & ConversationInjected

/** Full strict-session content props: per-session store, view ring, and callbacks. */
export type ConversationSessionSlotProps =
  PropsRuntime<'conversation.session'>
  & PropsRenderSlots<'conversation.view'>
  & PropsStore<ChatStore>
  & ConversationSessionInjected

/**
 * Injected share of the chat view entry: the two callbacks whose targets live
 * outside the view (layout orchestration; the session object layer).
 */
export interface ChatViewInjected {
  /** Selection write + details panel opening in one gesture (store action + layout orchestration). */
  openDetails: (target: SelectionTarget) => void
  /**
   * Open a tool-arg filesystem path with the host OS default application
   * (relative paths resolve against the session cwd).
   */
  openFile: (path: string) => void
  loadOlder: () => void
}

/** Full chat-view component props: runtime share & the declared toolview/commandview holes' render share & store share & injected share. */
export type ChatViewSlotProps =
  PropsRuntime<'conversation.view'> & PropsRenderSlots<'conversation.chat.toolview' | 'conversation.chat.commandview'>
  & PropsStore<ChatStore> & ChatViewInjected

/**
 * Injected share of the details slot: the panel is otherwise a pure reader of
 * the shared chat store, but its close button is a layout orchestration call.
 */
export interface DetailsInjected {
  /** Close the details panel (layout geometry stays with ctx.layout). */
  closeDetails: () => void
}

/** Full details-slot component props: selection arrives through the shared store, call material through useSession. */
export type DetailsSlotProps = PropsRuntime<'details'> & PropsStore<ChatStore> & DetailsInjected

/** Owner share common to the hero / New-Session Workspace pickers. */
export interface EmptyWorkspaceOwnerProps {
  open: boolean
  anchorRef?: RefObject<HTMLElement>
  /** Currently active workspace (renders a trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
  onPick: (workspaceId: WorkspaceId) => void
  onClose: () => void
}
