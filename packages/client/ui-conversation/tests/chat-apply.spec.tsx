// @vitest-environment jsdom
// apply wiring: services provided, chat view + footer chrome registered, the
// three slot registrations land against a root entry's children declarations
// (the AppFrame role), the shared store handle rides both session slots, and
// the bash samples resolve differentially (sub-session default scope).
// Full-chain rendering belongs to the shell e2e; this spec stops at the
// assembly surface.

import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject, ToolViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'

const ROOT = 'root-1' as SessionId
const CHILD = 'child-1' as SessionId

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotsService)
  await slotsFiber.await()

  const listStore = createSnapshotStore<SessionListState>({
    ids: [ROOT, CHILD],
    byId: {
      [ROOT]: { id: ROOT, title: 'R', running: false, updatedAt: 1 },
      [CHILD]: { id: CHILD, title: 'C', parentId: ROOT, running: false, updatedAt: 2 },
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
function renderEntryOf(slots: SlotsService, key: 'conversation' | 'details' | 'conversation.empty') {
  return slots.entries(key)[0] as undefined | { inject?: unknown; store?: unknown }
}

describe('apply wiring', () => {
  it('provides conversation and toolviews services', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.ctx.get('conversation')).toBeDefined()
    expect(b.ctx.get('toolviews')).toBeInstanceOf(ToolViewRegistry)
  })

  it('registers the chat view with the stats footer', async () => {
    const b = await bench()
    await b.fiber.await()
    const conversation = b.ctx.get('conversation') as ConversationService
    const views = conversation.views()
    expect(views.map((v) => v.id)).toEqual(['chat'])
    expect(views[0]?.chrome?.footer).toBeDefined()
  })

  it('occupies the three slots; session pair shares one store handle, empty declares none', async () => {
    const b = await bench()
    await b.fiber.await()
    const conversation = renderEntryOf(b.slots, 'conversation')
    const details = renderEntryOf(b.slots, 'details')
    const empty = renderEntryOf(b.slots, 'conversation.empty')
    expect(conversation?.inject).toBeTypeOf('function')
    expect(details?.inject).toBeTypeOf('function')
    expect(empty?.inject).toBeTypeOf('function')
    // The shared handle: one apply-built store value on BOTH session entries.
    expect(conversation?.store).toBeDefined()
    expect(details?.store).toBe(conversation?.store)
    // The empty slot is storeless (local state + useSessions derivation).
    expect(empty?.store).toBeUndefined()
  })

  it('bash samples resolve differentially: scoped row for sub-sessions, global for roots', async () => {
    const b = await bench()
    await b.fiber.await()
    const toolviews = b.ctx.get('toolviews') as ToolViewRegistry
    const forChild = toolviews.resolve('bash', CHILD)
    const forRoot = toolviews.resolve('bash', ROOT)
    expect(forChild).toBeDefined()
    expect(forRoot).toBeDefined()
    expect(forChild!.component).not.toBe(forRoot!.component)
  })

  it('plugin fiber disposal collects every registration (unload cascade)', async () => {
    const b = await bench()
    await b.fiber.await()
    await b.fiber.dispose()
    expect(b.slots.entries('conversation')).toHaveLength(0)
    expect(b.slots.entries('details')).toHaveLength(0)
    expect(b.slots.entries('conversation.empty')).toHaveLength(0)
    expect(b.ctx.get('conversation')).toBeUndefined()
    expect(b.ctx.get('toolviews')).toBeUndefined()
  })
})
