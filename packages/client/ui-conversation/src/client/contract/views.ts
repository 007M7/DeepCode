/**
 * View-ring contract: the typed conversation view table and the props
 * surfaces handed to registered views. Shared face between the skeleton
 * domain (ConversationRoot renders views) and the chat domain (registers the
 * chat view); domain implementation files import this, never each other.
 */
import type { FC } from 'react'
import type { ScopedSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook, UseSession } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * One ConversationViewMap entry: per-view props extension shapes (design
 * ledger, view ring). `chromeProps` extends {@link ChromeProps} for the
 * view's chrome attachments; `extraProps` extends {@link ConvViewProps} for
 * the view component itself. Both optional — the common bases stay the floor.
 */
export interface ViewEntryDef { chromeProps?: object; extraProps?: object }

/**
 * Typed conversation view table; ui-trajectory merges {trajectory, waterfall}.
 * The chat entry is declared inline here (self-merge from a sibling module
 * trips TS6305 under tsc -b).
 */
export interface ConversationViewMap { chat: ViewEntryDef }

/** View id constrained to registered ConversationViewMap keys (all string literals; chat is declared inline). */
export type ViewId = keyof ConversationViewMap

/** Per-view chrome props: the common base plus the entry's declared extension. */
export type ChromePropsOf<Id extends ViewId> =
  ChromeProps & (ConversationViewMap[Id] extends { chromeProps: infer C extends object } ? C : object)

/** Per-view component props: the common base plus the entry's declared extension. */
export type ConvViewPropsOf<Id extends ViewId> =
  ConvViewProps & (ConversationViewMap[Id] extends { extraProps: infer E extends object } ? E : object)

/** Tool call identity as carried on the wire (branded upstream in connection). */
export type CallId = string

/** Translate function bound to a namespace via i18n. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** One registered conversation view (props positions keyed by the entry's declared shapes). */
export interface ViewEntry<Id extends ViewId = ViewId> {
  id: Id
  label: string
  order?: number
  component: FC<ConvViewPropsOf<Id>>
  /** Per-view chrome attachments (chat mounts the stats line as footer). */
  chrome?: { header?: FC<ChromePropsOf<Id>>; footer?: FC<ChromePropsOf<Id>> }
}

/** Props for view chrome attachments. */
export interface ChromeProps { sessionId: SessionId; useSession: UseSession }

/** Selection target for the details linkage channel (toolcall is the step special case). */
export interface SelectionTarget { turnSeq: number; stepSeq?: number; callId?: CallId; toolName?: string }

/** Props handed to registered conversation views. */
export interface ConvViewProps {
  sessionId: SessionId
  useSession: UseSession
  useSelection: SnapshotSelectorHook<SelectionTarget | null>
  actions: { openDetails(t: SelectionTarget): void; loadOlder(): void }
  /** Chat has no delegated sub-slots in P-I (toolviews go through the named registry). */
  slots: ScopedSlots<never>
}
