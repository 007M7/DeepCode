// @vitest-environment jsdom
// apply wiring: services provided, chat view + footer chrome registered, the
// three slot registrations land against ui-layout-shaped specs, and the bash
// samples resolve differentially (sub-session default scope). Full-chain
// rendering belongs to the shell e2e; this spec stops at the assembly surface.

import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject, ToolViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls ui-layout's SlotMap declaration merge into this spec's
// program so the slot keys below typecheck in the client lane.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

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
  })
  const sessionsFake = {
    list: listStore,
    manager: { get: vi.fn() },
    ancestry: () => [],
    scope: () => undefined,
    create: vi.fn(),
  }
  ctx.provide('sessions', sessionsFake)
  ctx.provide('layout', {
    current: createSnapshotStore<{ viewFor: Record<string, string> }>({ viewFor: {} }),
    open: vi.fn(), openView: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
  })
  ctx.provide('i18n', { bind: () => (key: string) => key })

  // Specs owned by ui-layout in production; declared here so registrations land.
  const slots = ctx.get('slots') as SlotsService
  slots.define('conversation', { kind: 'single', scope: 'session' })
  slots.define('details', { kind: 'single', scope: 'session' })
  slots.define('conversation.empty', { kind: 'single', scope: 'root' })

  const fiber = ctx.plugin({ inject: [...inject], apply })
  return { ctx, fiber, slots }
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

  it('occupies conversation/details/conversation.empty with inject factories', async () => {
    const b = await bench()
    await b.fiber.await()
    for (const key of ['conversation', 'details', 'conversation.empty'] as const) {
      const entries = b.slots.entries(key)
      expect(entries, key).toHaveLength(1)
      expect((entries[0]!.options as { inject?: unknown }).inject, key).toBeTypeOf('function')
    }
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
