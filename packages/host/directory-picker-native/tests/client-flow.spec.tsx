// @vitest-environment jsdom
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { apply, inject, NativeDirectoryFlow } from '../src/client/index.ts'

afterEach(cleanup)

const HOLES = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'] as const

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const pickDirectory = vi.fn(async (): Promise<string | null> => '/tmp/picked')
  ctx.provide('workspaces', { pickDirectory } as never)
  const slots = ctx.get('slots') as SlotsService
  const declare = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  return { ctx, slots, pickDirectory, declare }
}

function owner(overrides: Partial<DirectoryFlowOwnerProps> = {}): DirectoryFlowOwnerProps {
  return {
    open: true, busy: false,
    onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn(),
    ...overrides,
  }
}

describe('directory-picker-native client half', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'workspaces'])
  })

  it('fills both directory-flow holes for declarations before or after apply, and leaves with its fiber', async () => {
    const before = await bench()
    before.declare()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    // Registry-contribution disposal proof: the fiber going down empties the holes.
    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declare()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('rejects a second flow occupant at load (single-kind hole)', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(() => b.slots.register({ name: HOLES[0] } as never, () => null))
      .toThrow(/already has a registration/)
  })

  it('drives the injected pick through the hole entry and reports the picked path', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries(HOLES[0])[0]!
    const injected = (entry.inject as () => { pick: () => Promise<string | null> })()
    await expect(injected.pick()).resolves.toBe('/tmp/picked')
    expect(b.pickDirectory).toHaveBeenCalledOnce()
  })

  it('runs one pick per open edge and reports the path to the latest onPicked', async () => {
    let resolve!: (path: string | null) => void
    const pick = vi.fn(() => new Promise<string | null>((settle) => { resolve = settle }))
    const first = owner()
    const view = render(<NativeDirectoryFlow {...first} pick={pick} />)
    expect(pick).toHaveBeenCalledOnce()
    // Re-renders while open (busy flips, handler identity changes) must not relaunch the chooser.
    const second = owner()
    view.rerender(<NativeDirectoryFlow {...second} busy pick={pick} />)
    expect(pick).toHaveBeenCalledOnce()
    // Even a fresh injected face (re-registration re-runs the inject factory)
    // must not relaunch while the same request is still open.
    const replacedPick = vi.fn(() => new Promise<string | null>(() => {}))
    view.rerender(<NativeDirectoryFlow {...second} busy pick={replacedPick} />)
    expect(replacedPick).not.toHaveBeenCalled()
    await act(async () => { resolve('/tmp/project') })
    expect(second.onPicked).toHaveBeenCalledWith('/tmp/project')
    expect(first.onPicked).not.toHaveBeenCalled()
  })

  it('reports null as cancellation and re-arms after the owner withdraws open', async () => {
    const pick = vi.fn(async () => null as string | null)
    const props = owner()
    const view = render(<NativeDirectoryFlow {...props} pick={pick} />)
    await act(async () => {})
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(props.onPicked).not.toHaveBeenCalled()
    // Withdraw and reopen: a fresh request runs a fresh pick.
    view.rerender(<NativeDirectoryFlow {...props} open={false} pick={pick} />)
    view.rerender(<NativeDirectoryFlow {...props} pick={pick} />)
    await act(async () => {})
    expect(pick).toHaveBeenCalledTimes(2)
  })

  it('folds pick failures into onError messages', async () => {
    const props = owner()
    render(<NativeDirectoryFlow {...props} pick={vi.fn(async () => { throw new Error('no chooser installed') })} />)
    await act(async () => {})
    expect(props.onError).toHaveBeenCalledWith('no chooser installed')

    const nonError = owner()
    render(<NativeDirectoryFlow {...nonError} pick={vi.fn(async () => { throw 'denied' })} />)
    await act(async () => {})
    expect(nonError.onError).toHaveBeenCalledWith('denied')
  })

  it('renders nothing while closed and while open', () => {
    const closed = render(<NativeDirectoryFlow {...owner({ open: false })} pick={vi.fn(async () => null)} />)
    expect(closed.container.innerHTML).toBe('')
    const opened = render(<NativeDirectoryFlow {...owner()} pick={vi.fn(async () => null)} />)
    expect(opened.container.innerHTML).toBe('')
  })
})
