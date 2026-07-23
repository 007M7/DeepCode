/**
 * Chat store factory (slot terminal design §4): selection + draft + active
 * view for one session, shared by the conversation and details registrations
 * (apply constructs one handle and passes it to both). Session-scope
 * derivation: both mount slots are scope=session, so the framework creates
 * one instance per session; the persist key is scope-suffixed by the
 * framework, aligning with the previous per-session draft persistence.
 *
 * Module exports the factory only — a module-level handle would pin identity
 * in the module cache (a de-facto singleton surviving plugin reloads).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatStoreState, SelectionTarget, ViewId } from './contract/views.ts'

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setDraft: (draft: ChatStoreState, text: string) => void
  clearDraft: (draft: ChatStoreState) => void
  restoreDraft: (draft: ChatStoreState, text: string) => void
  setView: (draft: ChatStoreState, view: ViewId) => void
}

/**
 * Declare the per-session chat store. `selection` is the details-linkage
 * channel (conversation writes, details reads); `draft` is the composer text
 * (persisted so it survives session switches and reloads); `view` is the
 * active conversation view id (previously layout.viewFor — store seat is the
 * cross-remount survival channel, null falls back to the first registered view).
 * @returns the store handle (spec + identity + factory in one value).
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    // Anchored to the contract shape: views consume the store through
    // ConvViewProps' SnapshotSelectorHook<ChatStoreState>, so init and the
    // contract cannot drift.
    init: (): ChatStoreState => ({ selection: null, draft: '', view: null }),
    persist: 'dsh.conversation.chat',
    actions: {
      select: (d, target: SelectionTarget | null) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      clearDraft: (d) => { d.draft = '' },
      // Optimistic-send failure restore: only when the user typed nothing new
      // since the clear (send choreography lives in the inject factory).
      restoreDraft: (d, text: string) => { if (d.draft === '') d.draft = text },
      setView: (d, view: ViewId) => { d.view = view },
    },
  })
}
