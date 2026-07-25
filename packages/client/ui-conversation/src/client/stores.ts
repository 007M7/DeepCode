/**
 * Per-session chat store shared by conversation and details registrations.
 * The plugin creates its handle at apply time so identity follows the fiber.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatStoreState, SelectionTarget } from './contract/views.ts'

/** Declared action shape used to give the exported factory a stable return type. */
type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setDraft: (draft: ChatStoreState, text: string) => void
  addImages: (draft: ChatStoreState, ids: readonly string[]) => void
  removeImage: (draft: ChatStoreState, id: string) => void
  pruneImages: (draft: ChatStoreState, available: readonly string[]) => void
  clearDraft: (draft: ChatStoreState) => void
  restoreDraft: (draft: ChatStoreState, text: string, imageIds: readonly string[]) => void
  setView: (draft: ChatStoreState, view: string) => void
}

/**
 * Declares the per-session chat state and write surface.
 * @returns the store handle.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    // Anchored to the contract shape: consumers read the store through
    // PropsStore<ChatStore>'s SnapshotSelectorHook<ChatStoreState>, so init
    // and the contract cannot drift.
    init: (): ChatStoreState => ({ selection: null, draft: '', imageIds: [], view: null }),
    persist: 'dsh.conversation.chat',
    actions: {
      select: (d, target: SelectionTarget | null) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      addImages: (d, ids: readonly string[]) => { d.imageIds.push(...ids) },
      removeImage: (d, id: string) => {
        d.imageIds = d.imageIds.filter(candidate => candidate !== id)
      },
      pruneImages: (d, available: readonly string[]) => {
        const keep = new Set(available)
        d.imageIds = d.imageIds.filter(id => keep.has(id))
      },
      clearDraft: (d) => {
        d.draft = ''
        d.imageIds = []
      },
      // Optimistic-send failure restore keeps any newer typing/images while
      // restoring the submitted draft material that disappeared on clear.
      restoreDraft: (d, text: string, imageIds: readonly string[]) => {
        if (d.draft === '') d.draft = text
        const current = new Set(d.imageIds)
        d.imageIds = [...imageIds.filter(id => !current.has(id)), ...d.imageIds]
      },
      setView: (d, view: string) => { d.view = view },
    },
  })
}
