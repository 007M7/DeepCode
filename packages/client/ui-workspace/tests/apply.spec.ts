import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspacePickerInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const create = vi.fn(async (input: { name: string } | { path: string }) => ({
    workspaceId: 'ws-new' as never,
    path: 'name' in input ? `/projects/${input.name}` : input.path,
    title: 'new', sessionIds: [], createdAt: '0', updatedAt: '0',
  }))
  ctx.provide('workspaces', { create })
  return { ctx, slots: ctx.get('slots') as SlotsService, create }
}

function declare(slots: SlotsService, name: 'sidebar.workspace' | 'conversation.empty.workspace'): () => void {
  return slots.register(
    { name: 'root', children: { [name]: { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
}

function injectedOf(slots: SlotsService, name: 'sidebar.workspace' | 'conversation.empty.workspace'): WorkspacePickerInjected {
  const entry = slots.entries(name)[0]!
  return (entry.inject as () => WorkspacePickerInjected)()
}

describe('ui-workspace apply', () => {
  it('declares the independent Workspace service', () => {
    expect(inject).toEqual(['slots', 'workspaces'])
  })

  it('registers the shared picker for declarations that arrive before or after apply', async () => {
    const before = await bench()
    declare(before.slots, 'sidebar.workspace')
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.workspace')[0]!.component).toBe(WorkspacePicker)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    declare(after.slots, 'conversation.empty.workspace')
    await Promise.resolve()
    expect(after.slots.entries('conversation.empty.workspace')[0]!.component).toBe(WorkspacePicker)
  })

  it('routes name and path creation to WorkspacesService', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = injectedOf(b.slots, 'sidebar.workspace')
    await injected.createWorkspace({ name: 'project' })
    await injected.createWorkspace({ path: '/tmp/project' })
    expect(b.create).toHaveBeenNthCalledWith(1, { name: 'project' })
    expect(b.create).toHaveBeenNthCalledWith(2, { path: '/tmp/project' })
  })

  it('unregisters picker entries on teardown', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspace')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.workspace')).toHaveLength(0)
  })
})
