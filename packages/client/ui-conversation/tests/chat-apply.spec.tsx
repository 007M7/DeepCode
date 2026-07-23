// @vitest-environment jsdom
// apply wiring: the conversation service provided, the chat view registered
// as the first 'conversation.view' ring entry declaring the keyed toolview
// hole, the three slot registrations land against a root entry's children
// declarations (the AppFrame role), the shared store handle rides all session
// entries, and the bash sample mounts through the load-order seam as a keyed
// entry. Full-chain rendering belongs to the machinery spec
// (chat-toolview-slot.spec.tsx) and the shell e2e; this spec stops at the
// assembly surface.

import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'

const ROOT = 'root-1' as SessionId
const CHILD = 'child-1' as SessionId

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotsService)
  await slotsFiber.await()

  const listStore = createSnapshotStore<SessionListState>({
    ids: [ROOT, CHILD],
    byId: {
      [ROOT]: { id: ROOT, title: 'R', displayTitle: 'R', running: false, updatedAt: 1 },
      [CHILD]: { id: CHILD, title: 'C', displayTitle: 'C', parentId: ROOT, running: false, updatedAt: 2 },
    },
    current: undefined,
  } as SessionListState)
  const sessionsFake = {
    list: listStore,
    manager: { get: vi.fn() },
    scope: () => undefined,
    cell: () => undefined,
    create: vi.fn(),
    open: vi.fn(),
  }
  ctx.provide('sessions', sessionsFake)
  ctx.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  ctx.provide('i18n', { bind: () => (key: string) => key })

  // Declared by ui-layout's root entry in production; a stand-in root
  // occupant declares them here so the contributions land (it consumes
  // renderSlot to satisfy the declare-means-render check).
  const slots = ctx.get('slots') as SlotsService
  slots.register({
    name: 'root',
    children: {
      'conversation': { kind: 'single', scope: 'session' },
      'details': { kind: 'single', scope: 'session' },
      'conversation.empty': { kind: 'single', scope: 'root' },
    },
  }, (_p: { renderSlot?: unknown }) => null)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  return { ctx, fiber, slots }
}

/** First stored entry for a key (inject/store live directly on StoredEntry). */
function renderEntryOf(slots: SlotsService, key: 'conversation' | 'conversation.view' | 'details' | 'conversation.empty') {
  return slots.entries(key)[0] as undefined | { inject?: unknown; store?: unknown }
}

describe('apply wiring', () => {
  it('provides the conversation service', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.ctx.get('conversation')).toBeDefined()
  })

  it('registers the chat view as the first ring entry, declaring the keyed toolview hole', async () => {
    const b = await bench()
    await b.fiber.await()
    const entries = b.slots.entries('conversation.view')
    expect(entries.map((e) => e.options.id)).toEqual(['chat'])
    expect(entries[0]?.options.label).toBe('Chat')
    expect(entries[0]?.options.order).toBe(0)
    // Declaring is claiming: the chat entry's registration put the hole on
    // the ledger with the contract's kind/scope.
    expect(b.slots.spec('conversation.chat.toolview')).toEqual({ kind: 'keyed', scope: 'session' })
  })

  it('occupies the three slots + the ring; session entries share one store handle, empty declares none', async () => {
    const b = await bench()
    await b.fiber.await()
    const conversation = renderEntryOf(b.slots, 'conversation')
    const chatView = renderEntryOf(b.slots, 'conversation.view')
    const details = renderEntryOf(b.slots, 'details')
    const empty = renderEntryOf(b.slots, 'conversation.empty')
    expect(conversation?.inject).toBeTypeOf('function')
    expect(chatView?.inject).toBeTypeOf('function')
    expect(details?.inject).toBeTypeOf('function')
    expect(empty?.inject).toBeTypeOf('function')
    // The shared handle: one apply-built store value on ALL session entries.
    expect(conversation?.store).toBeDefined()
    expect(details?.store).toBe(conversation?.store)
    expect(chatView?.store).toBe(conversation?.store)
    // The empty slot is storeless (local state + useSessions derivation).
    expect(empty?.store).toBeUndefined()
  })

  it('mounts the bash sample as a keyed entry through the load-order seam', async () => {
    const b = await bench()
    await b.fiber.await()
    // The sample plugin's inject: ['slots', 'conversation'] resolved — the
    // service being present implies the chat entry declared the hole first.
    const entries = b.slots.entries('conversation.chat.toolview')
    expect(entries.map((e) => e.options.key)).toEqual(['bash'])
  })

  it('plugin fiber disposal collects every registration (unload cascade, ring and hole included)', async () => {
    const b = await bench()
    await b.fiber.await()
    await b.fiber.dispose()
    expect(b.slots.entries('conversation')).toHaveLength(0)
    // The declared ring collapses with its declaring entry, and the chat
    // entry's keyed hole (with the sample's registration) collapses with it.
    expect(b.slots.entries('conversation.view')).toHaveLength(0)
    expect(b.slots.entries('conversation.chat.toolview')).toHaveLength(0)
    expect(b.slots.spec('conversation.chat.toolview')).toBeUndefined()
    expect(b.slots.entries('details')).toHaveLength(0)
    expect(b.slots.entries('conversation.empty')).toHaveLength(0)
    expect(b.ctx.get('conversation')).toBeUndefined()
  })
})
