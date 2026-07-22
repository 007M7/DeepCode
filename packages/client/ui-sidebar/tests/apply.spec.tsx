/**
 * apply wiring on a real cordis Context + SlotsService (terminal register
 * form): SidebarRoot registered into the layout-declared sidebar slot, the
 * thin inject surface (three plain service callbacks closed over the plugin
 * ctx — no hooks, no store lines), load-order fail-loud, and fiber-teardown
 * unregistration. Component behavior is covered props-direct in
 * sidebar-root.spec.tsx; no renderer machinery here.
 */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SidebarRootInjected } from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: ui-layout's SlotMap merge so the sidebar slot key typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

const sid = (s: string) => s as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const list = createSnapshotStore<SessionListState>({
    ids: [sid('a')],
    byId: { [sid('a')]: { id: sid('a'), title: 'alpha', cwd: '/proj', running: false, updatedAt: 1 } },
    current: undefined,
  })
  const sessions = { list, create: vi.fn(async () => sid('minted')), open: vi.fn() }
  const layout = { toggleSidebar: vi.fn() }
  ctx.provide('sessions', sessions)
  ctx.provide('layout', layout)
  const slots = ctx.get('slots') as SlotsService
  // Stand-in for ui-layout's root entry: the sidebar slot only exists while
  // a live entry declares it in children (declaration account: design §2.2).
  slots.register(
    { name: 'root', children: { 'sidebar': { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
  return { ctx, slots, sessions, layout }
}

/** The sidebar entry's injected share, read off the stored entry. */
function injectedOf(slots: SlotsService): SidebarRootInjected {
  const entries = slots.entries('sidebar')
  expect(entries).toHaveLength(1)
  // The typed StoredEntry.inject is declaration-derived ((...args: never[])
  // shape); the sidebar factory is parameterless, so the call is safe here.
  const inject = entries[0]!.inject as (() => SidebarRootInjected) | undefined
  return inject!()
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'layout', 'sessions'])
  })

  it('fails loud when mounted without the inject declaration', async () => {
    // ctx.slots rides the cordis property proxy: reading it from a plugin
    // that never declared the dependency throws instead of yielding undefined.
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    await expect(ctx.plugin({ apply })).rejects.toThrow(/without inject/)
  })

  it('fails loud when no live entry has declared the sidebar slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    ctx.provide('sessions', {})
    ctx.provide('layout', {})
    await expect(ctx.plugin({ inject: [...inject], apply })).rejects.toThrow(/slot "sidebar" is not declared/)
  })

  it('registers SidebarRoot with the thin three-callback inject surface', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const injected = injectedOf(slots)
    // The whole business face: three plain callbacks, no hooks, no store lines.
    expect(Object.keys(injected).sort()).toEqual(['onCreate', 'onOpen', 'onToggleSidebar'])
  })

  it('routes the callbacks to the layout/sessions services', async () => {
    const { ctx, slots, sessions, layout } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const injected = injectedOf(slots)

    injected.onToggleSidebar()
    expect(layout.toggleSidebar).toHaveBeenCalledOnce()

    injected.onOpen(sid('a'))
    expect(sessions.open).toHaveBeenCalledWith('a')

    injected.onCreate()
    expect(sessions.create).toHaveBeenCalledWith({})
    // create-then-open lands after the create promise resolves.
    await Promise.resolve()
    await Promise.resolve()
    expect(sessions.open).toHaveBeenCalledWith('minted')

    injected.onCreate('/proj')
    expect(sessions.create).toHaveBeenCalledWith({ cwd: '/proj' })
  })

  it('teardown unregisters the slot entry', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('sidebar')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('sidebar')).toHaveLength(0)
  })
})
