// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type {
  FC } from 'react'
import type {
  InjectFactory, RootBinding, SlotCore, SlotEntry, SlotEntryDef, SlotSpec,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSessionProvider, createSnapshotStore, RootBindingProvider, scopedSlots,
  type SessionBinding, type SessionProviderDeps,
} from '@deepseek-ai/dsh-client-web-react'

/**
 * Behavioral SlotCore fake (the real ui-slots is still a T0 stub): registration
 * mutates entries, bumps the key version, and notifies subscribers synchronously
 * (batching semantics belong to fw-slots' core, not this package's outlet).
 */
function makeFakeCore() {
  const specs = new Map<string, SlotSpec<SlotEntryDef>>()
  const entries = new Map<string, SlotEntry<SlotEntryDef>[]>()
  const versions = new Map<string, number>()
  const subs = new Map<string, Set<() => void>>()
  const bump = (key: string) => {
    versions.set(key, (versions.get(key) ?? 0) + 1)
    for (const fn of [...(subs.get(key) ?? [])]) fn()
  }
  const core = {
    define: (key: string, spec: SlotSpec<SlotEntryDef>) => {
      specs.set(key, spec)
      bump(key)
      return () => { specs.delete(key); bump(key) }
    },
    // Options widened beyond SlotOptions<SlotEntryDef>: fake keys ('fake.list')
    // are not in SlotMap, so calls resolve against this signature and need the
    // list/keyed fields the conditional type would otherwise narrow away.
    register: (
      key: string, component: FC<object>,
      options: { key?: string; id?: string; order?: number; label?: string; inject?: InjectFactory<SlotEntryDef> } = {},
    ) => {
      const list = entries.get(key) ?? []
      const entry: SlotEntry<SlotEntryDef> = { component, options }
      entries.set(key, [...list, entry])
      bump(key)
      return () => {
        entries.set(key, (entries.get(key) ?? []).filter((e) => e !== entry))
        bump(key)
      }
    },
    entries: (key: string) => entries.get(key) ?? [],
    spec: (key: string) => specs.get(key),
    subscribe: (key: string, fn: () => void) => {
      const set = subs.get(key) ?? new Set()
      set.add(fn)
      subs.set(key, set)
      return () => { set.delete(fn) }
    },
    getVersion: (key: string) => versions.get(key) ?? 0,
    onMutate: () => () => {},
  }
  return core as unknown as SlotCore & typeof core
}

const useSelectorStub = (() => { throw new Error('unused in these specs') }) as never

const makeBinding = (sessionId: string): SessionBinding => ({
  sessionId, session: { useSelector: useSelectorStub }, ctx: { tag: sessionId },
})

/** Mount ui under a SessionProvider bound to one switchable session. */
function sessionHarness(body: (id: string) => React.ReactNode, bindings: Record<string, SessionBinding>) {
  const current = createSnapshotStore<{ id: string | undefined }>({ id: undefined })
  const deps: SessionProviderDeps = {
    useCurrent: () => current.useSelector((s) => s.id),
    resolveBinding: (id) => bindings[id],
    renderBody: body,
  }
  const Provider = createSessionProvider(deps)
  return { current, Provider }
}

describe('scopedSlots basics', () => {
  it('throws on renderSlot before define and on non-whitelisted keys', () => {
    const core = makeFakeCore()
    const slots = scopedSlots(core, 'fake.root' as never)
    expect(() => slots.renderSlot('fake.session' as never, {})).toThrow(/whitelist/)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<>{slots.renderSlot('fake.root' as never, {})}</>)).toThrow(/before define/)
    spy.mockRestore()
  })

  it('renders single-kind root slots, falls back when empty, live-updates on register/dispose', () => {
    const core = makeFakeCore()
    core.define('fake.root', { kind: 'single', scope: 'root' })
    const slots = scopedSlots(core, 'fake.root' as never)
    const view = render(<>{slots.renderSlot('fake.root' as never, {}, { fallback: <i>none</i> })}</>)
    expect(view.container.textContent).toBe('none')
    let dispose = () => {}
    act(() => { dispose = core.register('fake.root', () => <b>SB</b>) })
    expect(view.container.textContent).toBe('SB')
    act(() => { dispose() })
    expect(view.container.textContent).toBe('none')
  })

  it('renders list slots in order, honors only-filter, keyed slots dispatch by entryKey', () => {
    const core = makeFakeCore()
    core.define('fake.list', { kind: 'list', scope: 'root' })
    core.define('fake.keyed', { kind: 'keyed', scope: 'root' })
    core.register('fake.list', () => <span>b</span>, { id: 'b', order: 2 })
    core.register('fake.list', () => <span>a</span>, { id: 'a', order: 1 })
    core.register('fake.keyed', () => <span>goal</span>, { key: 'goal' })
    const slots = scopedSlots(core, 'fake.list' as never, 'fake.keyed' as never)
    const list = render(<>{slots.renderSlot('fake.list' as never, {})}</>)
    expect(list.container.textContent).toBe('ab')
    const only = render(<>{slots.renderSlot('fake.list' as never, {}, { only: 'b' })}</>)
    expect(only.container.textContent).toBe('b')
    const hit = render(<>{slots.renderSlot('fake.keyed' as never, {}, { entryKey: 'goal' })}</>)
    expect(hit.container.textContent).toBe('goal')
    const miss = render(
      <>{slots.renderSlot('fake.keyed' as never, {}, { entryKey: 'nope', fallback: <i>fb</i> })}</>)
    expect(miss.container.textContent).toBe('fb')
  })

  it('contains a throwing root inject factory to its own entry (P1 whiteout regression)', () => {
    const core = makeFakeCore()
    core.define('fake.list', { kind: 'list', scope: 'root' })
    core.register('fake.list', () => <span>never</span>, {
      id: 'bad', order: 1,
      inject: (() => { throw new Error('inject boom') }) as unknown as InjectFactory<SlotEntryDef>,
    })
    core.register('fake.list', () => <span>alive</span>, { id: 'ok', order: 2 })
    const slots = scopedSlots(core, 'fake.list' as never)
    const root: RootBinding = { ctx: {} }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(
      <RootBindingProvider value={root}>
        <main>{slots.renderSlot('fake.list' as never, {})}</main>
      </RootBindingProvider>,
    )
    spy.mockRestore()
    // The failing entry blacks out alone; the sibling and the tree above survive.
    expect(view.container.querySelector('main')).not.toBeNull()
    expect(view.container.textContent).toBe('alive')
    expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
  })

  it('contains a throwing session inject factory to its own entry', () => {
    const core = makeFakeCore()
    core.define('fake.session', { kind: 'single', scope: 'session' })
    core.register('fake.session', () => <span>never</span>, {
      inject: (() => { throw new Error('session inject boom') }) as unknown as InjectFactory<SlotEntryDef>,
    })
    const slots = scopedSlots(core, 'fake.session' as never)
    const bindings = { s1: makeBinding('s1') }
    const { current, Provider } = sessionHarness(
      (id) => <main data-shell={id}>{slots.renderSlot('fake.session' as never, {})}</main>, bindings)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(<Provider />)
    act(() => { current.update((d) => { d.id = 's1' }) })
    spy.mockRestore()
    expect(view.container.querySelector('[data-shell]')).not.toBeNull()
    expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
  })

  it('isolates a crashing entry without collapsing siblings', () => {
    const core = makeFakeCore()
    core.define('fake.list', { kind: 'list', scope: 'root' })
    core.register('fake.list', () => { throw new Error('entry boom') }, { id: 'bad', order: 1 })
    core.register('fake.list', () => <span>alive</span>, { id: 'ok', order: 2 })
    const slots = scopedSlots(core, 'fake.list' as never)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(<>{slots.renderSlot('fake.list' as never, {})}</>)
    spy.mockRestore()
    expect(view.container.textContent).toBe('alive')
    expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
  })
})

describe('inject caching and props merge', () => {
  it('root inject runs once per entry and receives the root binding ctx', () => {
    const core = makeFakeCore()
    core.define('fake.root', { kind: 'single', scope: 'root' })
    const inject = vi.fn((b: RootBinding) => ({ tag: (b.ctx as { tag: string }).tag }))
    core.register('fake.root', ({ tag }: { tag?: string }) => <b>{tag}</b>,
      { inject: inject as unknown as InjectFactory<SlotEntryDef> })
    const slots = scopedSlots(core, 'fake.root' as never)
    const root: RootBinding = { ctx: { tag: 'ROOT' } }
    const view = render(
      <RootBindingProvider value={root}>
        {slots.renderSlot('fake.root' as never, {})}
      </RootBindingProvider>,
    )
    expect(view.container.textContent).toBe('ROOT')
    view.rerender(
      <RootBindingProvider value={root}>
        {slots.renderSlot('fake.root' as never, {})}
      </RootBindingProvider>,
    )
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('root slots with inject throw without RootBindingProvider; plain entries do not need it', () => {
    const core = makeFakeCore()
    core.define('fake.root', { kind: 'single', scope: 'root' })
    core.register('fake.root', () => <b>plain</b>)
    const slots = scopedSlots(core, 'fake.root' as never)
    const view = render(<>{slots.renderSlot('fake.root' as never, {})}</>)
    expect(view.container.textContent).toBe('plain')

    const core2 = makeFakeCore()
    core2.define('fake.root', { kind: 'single', scope: 'root' })
    core2.register('fake.root', () => <b>x</b>,
      { inject: (() => ({})) as unknown as InjectFactory<SlotEntryDef> })
    const slots2 = scopedSlots(core2, 'fake.root' as never)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<>{slots2.renderSlot('fake.root' as never, {})}</>))
      .toThrow(/RootBindingProvider/)
    spy.mockRestore()
  })

  it('session inject caches per (entry x binding): session switch re-invokes, switch-back reuses', () => {
    const core = makeFakeCore()
    core.define('fake.session', { kind: 'single', scope: 'session' })
    const inject = vi.fn((b: { sessionId: string }) => ({ sid: b.sessionId }))
    core.register('fake.session', ({ sid }: { sid?: string }) => <b>{sid}</b>,
      { inject: inject as unknown as InjectFactory<SlotEntryDef> })
    const slots = scopedSlots(core, 'fake.session' as never)
    const bindings = { s1: makeBinding('s1'), s2: makeBinding('s2') }
    const { current, Provider } = sessionHarness(
      () => slots.renderSlot('fake.session' as never, {}), bindings)
    const view = render(<Provider />)
    act(() => { current.update((d) => { d.id = 's1' }) })
    expect(view.container.textContent).toBe('s1')
    expect(inject).toHaveBeenCalledTimes(1)
    act(() => { current.update((d) => { d.id = 's2' }) })
    expect(view.container.textContent).toBe('s2')
    expect(inject).toHaveBeenCalledTimes(2)
    act(() => { current.update((d) => { d.id = 's1' }) })   // back: cache hit
    expect(view.container.textContent).toBe('s1')
    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('session slots receive standard useSession injection and owner props win the merge', () => {
    const core = makeFakeCore()
    core.define('fake.session', { kind: 'single', scope: 'session' })
    const seen: Record<string, unknown>[] = []
    core.register('fake.session', (props: object) => {
      seen.push(props as Record<string, unknown>)
      return null
    }, { inject: (() => ({ fromInject: 'inject', shared: 'inject' })) as unknown as InjectFactory<SlotEntryDef> })
    const slots = scopedSlots(core, 'fake.session' as never)
    const bindings = { s1: makeBinding('s1') }
    const { current, Provider } = sessionHarness(
      () => slots.renderSlot('fake.session' as never, { owner: 'owner', shared: 'owner' } as never), bindings)
    render(<Provider />)
    act(() => { current.update((d) => { d.id = 's1' }) })
    const props = seen.at(-1)!
    expect(props.useSession).toBe(bindings.s1.session.useSelector)
    expect(props.fromInject).toBe('inject')
    expect(props.owner).toBe('owner')
    expect(props.shared).toBe('owner')   // three-source merge: owner overrides inject
  })

  it('session slots outside a SessionProvider fail loud', () => {
    const core = makeFakeCore()
    core.define('fake.session', { kind: 'single', scope: 'session' })
    core.register('fake.session', () => <b>x</b>)
    const slots = scopedSlots(core, 'fake.session' as never)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<>{slots.renderSlot('fake.session' as never, {})}</>))
      .toThrow(/outside SessionProvider/)
    spy.mockRestore()
  })
})
