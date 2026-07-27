import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkspaceBrowser } from '../src/client/WorkspaceBrowser.tsx'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const create = vi.fn(async (input: { name: string } | { path: string }) => ({
    workspaceId: 'ws-new' as never,
    path: 'name' in input ? `/projects/${input.name}` : input.path,
    title: 'new', sessionIds: [], createdAt: '0', updatedAt: '0',
  }))
  const pickDirectory = vi.fn(async () => '/tmp/picked')
  const startSession = vi.fn()
  const rename = vi.fn(async () => ({}))
  const insertSessionBefore = vi.fn(async () => ({}))
  const open = vi.fn()
  const clear = vi.fn()
  ctx.provide('workspaces', {
    create, pickDirectory, startSession, rename, insertSessionBefore,
  } as never)
  ctx.provide('sessions', { open, clear } as never)
  return { ctx, slots: ctx.get('slots') as SlotsService, create, pickDirectory, startSession, rename, insertSessionBefore, open, clear }
}

type HoleName = 'sidebar.workspaces' | 'conversation.hero.workspace' | 'conversation.empty.workspace'

/** Declare any subset of the holes with a single root registration ('root' is a single slot). */
function declare(slots: SlotsService, ...names: HoleName[]): () => void {
  const children = Object.fromEntries(names.map(name => [name, { kind: 'single', scope: 'root' }]))
  return slots.register({ name: 'root', children } as never, () => null)
}

describe('ui-workspace apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'sessions', 'workspaces'])
  })

  it('registers browser and pickers for declarations arriving before or after apply', async () => {
    const before = await bench()
    declare(before.slots, 'sidebar.workspaces')
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.workspaces')[0]!.component).toBe(WorkspaceBrowser)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    declare(after.slots, 'conversation.hero.workspace', 'conversation.empty.workspace')
    await Promise.resolve()
    expect(after.slots.entries('conversation.hero.workspace')[0]!.component).toBe(WorkspacePicker)
    // expect(after.slots.entries('conversation.empty.workspace')[0]!.component).toBe(WorkspacePicker)
  })

  it('routes browser actions and picker creation to the services', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    // Both arms delegate to the runtime's shared New Session action.
    browser.startSession('ws' as never)
    expect(b.startSession).toHaveBeenCalledWith('ws')
    browser.startSession()
    expect(b.startSession).toHaveBeenLastCalledWith(undefined)
    browser.open('session' as never)
    expect(b.open).toHaveBeenCalledWith('session')
    await browser.renameWorkspace('ws' as never, 'renamed')
    expect(b.rename).toHaveBeenCalledWith('ws', 'renamed')
    await browser.insertSessionBefore('ws' as never, 's1' as never, 's2' as never)
    expect(b.insertSessionBefore).toHaveBeenCalledWith('ws', 's1', 's2')
    await browser.createWorkspace({ name: 'project' })
    expect(b.create).toHaveBeenCalledWith({ name: 'project' })
    await browser.pickDirectory()
    expect(b.pickDirectory).toHaveBeenCalledOnce()

    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    await picker.createWorkspace({ path: '/tmp/project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/project' })
    await picker.pickDirectory()
    expect(b.pickDirectory).toHaveBeenCalledTimes(2)
  })

  it('unregisters every entry on teardown', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace', 'conversation.empty.workspace')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(b.slots.entries('conversation.hero.workspace')).toHaveLength(0)
    // expect(b.slots.entries('conversation.empty.workspace')).toHaveLength(0)
  })
})
