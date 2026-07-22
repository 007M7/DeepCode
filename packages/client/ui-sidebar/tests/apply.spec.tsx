// @vitest-environment jsdom
/**
 * apply wiring on a real cordis Context + SlotsService: tree store built and
 * subscribed, SidebarRoot registered into the layout-owned sidebar slot with
 * the inject surface bound off the root binding ctx, effect teardown
 * unregisters and drops the list subscription. Behavior-level assertions
 * only — the inject factory's cast shape is due to change with the slot
 * type-chain redesign.
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import { scopedSlots, RootBindingProvider } from '@deepseek-ai/dsh-client-web-react'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: ui-layout's SlotMap merge so the sidebar slot key typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

const sid = (s: string) => s as SessionId

afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const list = createSnapshotStore<SessionListState>({
    ids: [sid('a')],
    byId: { [sid('a')]: { id: sid('a'), title: 'alpha', cwd: '/proj', running: false, updatedAt: 1 } },
  })
  const sessions = { list, create: vi.fn(async () => sid('minted')) }
  const layout = {
    current: createSnapshotStore<{ sessionId?: SessionId }>({}),
    open: vi.fn(),
    toggleSidebar: vi.fn(),
  }
  ctx.provide('sessions', sessions)
  ctx.provide('layout', layout)
  const slots = ctx.get('slots') as SlotsService
  slots.define('sidebar', { kind: 'single', scope: 'root' })
  return { ctx, slots, sessions, layout }
}

function mountSlot(ctx: Context, slots: SlotsService) {
  const surface = scopedSlots(slots.core, 'sidebar')
  return render(
    <RootBindingProvider value={{ ctx }}>
      {surface.renderSlot('sidebar', {})}
    </RootBindingProvider>,
  )
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'layout', 'sessions'])
  })

  it('fails loud when mounted without the inject declaration', async () => {
    // ctx.sessions rides the cordis property proxy: reading it from a plugin
    // that never declared the dependency throws instead of yielding undefined.
    // Await the fiber thenable itself, not a second .await() chain: the test
    // invariant host wraps plugin() with an eager readiness promise, and only
    // the thenable settles it (a parallel .await() leaves it unhandled).
    const ctx = new Context()
    await ctx.plugin(SlotsService).await()
    await expect(ctx.plugin({ apply })).rejects.toThrow(/without inject/)
  })

  it('registers SidebarRoot which renders from the live list', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    mountSlot(ctx, slots)
    expect(screen.getByText('proj')).toBeTruthy()
    expect(screen.getByText('1 session')).toBeTruthy()
  })

  it('binds actions to layout/sessions off the root binding', async () => {
    const { ctx, slots, sessions, layout } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    mountSlot(ctx, slots)

    act(() => { fireEvent.click(screen.getByLabelText('Collapse sidebar')) })
    expect(layout.toggleSidebar).toHaveBeenCalledOnce()

    act(() => { fireEvent.click(screen.getByText('proj')) })
    act(() => { fireEvent.click(screen.getByText('alpha')) })
    expect(layout.open).toHaveBeenCalledWith('a')

    act(() => { fireEvent.click(screen.getByText('New Session')) })
    expect(sessions.create).toHaveBeenCalledWith({})
    // create-then-open lands after the create promise resolves.
    await act(async () => { await Promise.resolve() })
    expect(layout.open).toHaveBeenCalledWith('minted')

    act(() => { fireEvent.click(screen.getAllByLabelText('New session here')[0]!) })
    expect(sessions.create).toHaveBeenCalledWith({ cwd: '/proj' })
  })

  it('throws from the inject factory when binding ctx lacks the services', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const bare = new Context()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const surface = scopedSlots(slots.core, 'sidebar')
      render(
        <RootBindingProvider value={{ ctx: bare }}>
          {surface.renderSlot('sidebar', {})}
        </RootBindingProvider>,
      )
      // The slot error boundary absorbs the throw and logs it.
      expect(document.querySelector('[data-slot-error="sidebar"]')).toBeTruthy()
    } finally {
      spy.mockRestore()
    }
  })

  it('search input drives the plugin-owned tree store', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    mountSlot(ctx, slots)
    act(() => {
      fireEvent.change(screen.getByPlaceholderText('Search name, keywords...'), { target: { value: 'zzz' } })
    })
    expect(screen.getByText('No matches')).toBeTruthy()
  })

  it('expansion toggles route through the injected tree actions', async () => {
    const { ctx, slots, sessions } = await bench()
    sessions.list.update((draft) => {
      draft.ids.push(sid('kid'))
      draft.byId[sid('kid')] = {
        id: sid('kid'), title: 'child', cwd: '/proj', parentId: sid('a'), running: false, updatedAt: 2,
      }
    })
    await ctx.plugin({ inject: [...inject], apply }).await()
    mountSlot(ctx, slots)
    act(() => { fireEvent.click(screen.getByText('proj')) })
    expect(screen.getByText('alpha')).toBeTruthy()
    act(() => { fireEvent.click(screen.getByLabelText('Expand')) })
    expect(screen.getByText('child')).toBeTruthy()
  })

  it('teardown unregisters the slot and drops the list subscription', async () => {
    const { ctx, slots, sessions } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('sidebar')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('sidebar')).toHaveLength(0)
    // A post-teardown list change must not reach a disposed store.
    expect(() => {
      sessions.list.update((draft) => { draft.ids = [] })
    }).not.toThrow()
  })
})
