/**
 * Slot-ring contract for the conversation package: the composed props shapes
 * its registrants mount into the layout-owned slots (conversation / details /
 * conversation.empty — the SlotMap declarations live with ui-layout, the
 * slot owner). Per the share-ownership rule, the owner share is REFERENCED
 * from ui-layout and each registrant's injected share is declared here, next
 * to the component that receives it; full component props = owner share &
 * standard share & own injected share.
 */
import type { ReactNode } from 'react'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook, UseSession } from '@deepseek-ai/dsh-client-web-react'
import type { ConvOwnerProps, DetailsOwnerProps, EmptyOwnerProps } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SelectionTarget, ViewEntry, ViewId } from './views.ts'

/** Injected share of the conversation slot (assembled by apply's inject factory). */
export interface ConversationInjected {
  /** Breadcrumb chain (root ancestor first, self last; ancestry(list) feed). */
  useAncestry: () => readonly SessionSummary[]
  /** View registry read face (uSES triple from the conversation service). */
  views: {
    list(): readonly ViewEntry[]
    subscribe(fn: () => void): () => void
    version(): number
  }
  /** Active view accessor (layout.viewFor backed; undefined falls to 'chat'). */
  useActiveView: () => ViewId | undefined
  /** Composer surface: draft store hook pair + send/stop choreography. */
  composer: {
    useDraft: () => string
    setDraft(text: string): void
    send(mode: 'queue' | 'steer'): void
    stop(): void
  }
  actions: {
    openView(view: ViewId): void
    open(id: SessionId): void
  }
  /** Renders the active view's body (the owner closes over ConvViewProps assembly). */
  renderView: (entry: ViewEntry) => ReactNode
}

/** Full conversation-slot component props: owner share & standard share & injected share. */
export type ConversationSlotProps = ConvOwnerProps & { useSession: UseSession } & ConversationInjected

/** Injected share of the details slot. */
export interface DetailsInjected {
  useSelection: SnapshotSelectorHook<SelectionTarget | null>
  actions: { closeDetails(): void }
}

/** Full details-slot component props. */
export type DetailsSlotProps = DetailsOwnerProps & { useSession: UseSession } & DetailsInjected

/** Injected share of the no-session empty-state slot (root slot: no standard share). */
export interface EmptyStateInjected {
  /** cwd options derived from sessions.list (deduped; assembled by the inject factory). */
  useCwds: SnapshotSelectorHook<readonly string[]>
  actions: { startSession(opts: { cwd?: string; text: string; mode: 'queue' | 'steer' }): Promise<void> }
}

/** Full empty-state component props. */
export type EmptyStateSlotProps = EmptyOwnerProps & EmptyStateInjected
