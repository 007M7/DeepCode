/** Sidebar shell slot registration and its plain runtime/layout callbacks. */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SidebarRootInjected } from '@deepseek-ai/dsh-client-ui-sidebar/client'

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const layout = { toggleSidebar: vi.fn() }
  const workspaces = { startSession: vi.fn() }
  ctx.provide('layout', layout)
  ctx.provide('workspaces', workspaces as never)
  const slots = ctx.get('slots') as SlotsService
  if (declare) {
    slots.register(
      { name: 'root', children: { 'sidebar': { kind: 'single', scope: 'root' } } } as never,
      () => null,
    )
  }
  return { ctx, slots, layout, workspaces }
}

describe('ui-sidebar apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'workspaces'])
  })

  it('registers the shell and declares the browsing-region hole', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar')).toHaveLength(1)
    expect(b.slots.spec('sidebar.workspaces')).toEqual({ kind: 'single', scope: 'root' })
    const injected = (b.slots.entries('sidebar')[0]!.inject as () => SidebarRootInjected)()
    expect(Object.keys(injected)).toEqual(['startSession', 'toggleSidebar'])
    injected.startSession('workspace' as never, 'prompt')
    expect(b.workspaces.startSession).toHaveBeenCalledWith('workspace', 'prompt')
    injected.toggleSidebar()
    expect(b.layout.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('fails when no live owner declared the sidebar slot', async () => {
    const b = await bench(false)
    await expect(b.ctx.plugin({ inject: [...inject], apply })).rejects.toThrow(/not declared/)
  })

  it('removes the entry and child declaration on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar')).toHaveLength(0)
    expect(b.slots.spec('sidebar.workspaces')).toBeUndefined()
  })
})
