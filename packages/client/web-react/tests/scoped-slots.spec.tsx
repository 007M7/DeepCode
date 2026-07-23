// @vitest-environment jsdom
/**
 * createSlotRenderer machinery account over a behavioral fake host: root
 * outlet + per-kind child outlets, standard-kit synthesis (renderSlot
 * binding, session pair, global useSessions, store pair), inject execution
 * point (inside component bodies, contained per entry) and parameter
 * derivation, and cache granularity (entry x scope key). Ledger semantics
 * (declaration conflicts, store instance accounting) belong to the runtime
 * SlotsService suite, not here.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ActionsDecl, SlotEntryDef, SlotSpec, StoreHandle, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSlotRenderer, SessionProvider, SlotOwnershipError,
  type RenderOpts, type SessionCell,
  type SlotRendererHost, type StoreInstanceLike,
} from '@deepseek-ai/dsh-client-web-react'

type AnyProps = Record<string, unknown>
type RenderSlotFn = (key: string, owner: object, opts?: RenderOpts) => ReactNode
type DeclaredSpec = SlotSpec<SlotEntryDef>
/** Entry literal helper: fake entries default the mandatory options bag. */
const entryOf = (partial: Omit<StoredEntry, 'options'> & { options?: StoredEntry['options'] }): StoredEntry =>
  ({ options: {}, ...partial })

/**
 * Minimal store handle satisfying the StoreDecl contract shape (spec +
 * create(scopeKey?) + instance with clearPersisted): the machinery consumes
 * only the StoreInstanceLike face (bare snapshot source + baked actions),
 * but entry.store is typed to the full contract — the real defineStore lives
 * in runtime, which web-react tests must not import (dependency direction).
 */
function miniStore<T extends object>(init: () => T, mutators: Record<string, (state: T, ...params: never[]) => T>): StoreHandle<T, ActionsDecl<T>> {
  return {
    spec: { init, actions: {} },
    create: () => {
      let state = init()
      const listeners = new Set<() => void>()
      const actions: Record<string, (...params: never[]) => void> = {}
      for (const key of Object.keys(mutators)) {
        actions[key] = (...params: never[]) => {
          state = mutators[key]!(state, ...params)
          for (const fn of [...listeners]) fn()
        }
      }
      return {
        getSnapshot: () => state,
        subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
        actions,
        clearPersisted: () => {},
      } as StoreInstanceLike as ReturnType<StoreHandle<T, ActionsDecl<T>>['create']>
    },
  }
}

function observable<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } },
    set: (next: T) => { value = next; for (const fn of [...subs]) fn() },
  }
}

/**
 * Behavioral SlotRendererHost fake: registration mutates entries, bumps the
 * key version, and notifies synchronously (batching semantics belong to the
 * runtime host, not this package's outlets). Store instances resolve through
 * the entry's real handle, cached per (entry x scope key) like the real
 * ledger; session cells are identity-stable per id.
 */
function makeHost() {
  const entries = new Map<string, StoredEntry[]>()
  const specs = new Map<string, DeclaredSpec>()
  const versions = new Map<string, number>()
  const subs = new Map<string, Set<() => void>>()
  const live = new Set<StoredEntry>()
  const storeCache = new Map<StoredEntry, Map<string, StoreInstanceLike>>()
  const list = observable<{ ids: string[] }>({ ids: [] })
  const current = observable<string | undefined>(undefined)
  const cells = new Map<string, SessionCell>()

  const bump = (key: string) => {
    versions.set(key, (versions.get(key) ?? 0) + 1)
    for (const fn of [...(subs.get(key) ?? [])]) fn()
  }
  const host: SlotRendererHost = {
    subscribe: (key, fn) => {
      const set = subs.get(key) ?? new Set()
      set.add(fn)
      subs.set(key, set)
      return () => { set.delete(fn) }
    },
    getVersion: (key) => versions.get(key) ?? 0,
    entriesOf: (key) => entries.get(key) ?? [],
    specOf: (key) => specs.get(key),
    isLive: (entry) => live.has(entry),
    storeOf: (entry, scopeKey) => {
      if (entry.store === undefined) return undefined
      let perScope = storeCache.get(entry)
      if (!perScope) {
        perScope = new Map()
        storeCache.set(entry, perScope)
      }
      const cacheKey = scopeKey ?? ''
      let instance = perScope.get(cacheKey)
      if (!instance) {
        // Fake entries always carry engine handles (never factories), and the
        // engine create() takes the scope key (persist suffixing).
        const handle = entry.store as { create(scopeKey?: string): StoreInstanceLike }
        instance = handle.create(scopeKey)
        perScope.set(cacheKey, instance)
      }
      return instance
    },
    sessions: {
      list,
      current,
      cell: (id) => cells.get(id),
    },
  }
  return {
    host,
    list,
    current,
    declare: (key: string, spec: DeclaredSpec) => { specs.set(key, spec); bump(key) },
    add: (key: string, partial: Omit<StoredEntry, 'options'> & { options?: StoredEntry['options'] }) => {
      const entry = entryOf(partial)
      entries.set(key, [...(entries.get(key) ?? []), entry])
      live.add(entry)
      bump(key)
      return () => {
        entries.set(key, (entries.get(key) ?? []).filter((e) => e !== entry))
        live.delete(entry)
        bump(key)
      }
    },
    addSession: (id: string): SessionCell => {
      // Bare source per cell (identity-stable): the machinery binds useSession from it.
      const cell: SessionCell = {
        sessionId: id,
        session: { getSnapshot: () => ({ sid: id }), subscribe: () => () => {} },
      }
      cells.set(id, cell)
      return cell
    },
  }
}

type Fake = ReturnType<typeof makeHost>

/** Mount a root entry whose component renders `body` with its kit renderSlot. */
function mountRoot(h: Fake, children: Record<string, DeclaredSpec>, body: (renderSlot: RenderSlotFn) => ReactNode) {
  const dispose = h.add('root', {
    component: (props: { renderSlot: RenderSlotFn }) => <>{body(props.renderSlot)}</>,
    children,
  })
  const renderer = createSlotRenderer()
  const view = render(<>{renderer.renderRoot(h.host, {})}</>)
  return { view, dispose }
}

const SINGLE_ROOT: DeclaredSpec = { kind: 'single', scope: 'root' }
const SINGLE_SESSION: DeclaredSpec = { kind: 'single', scope: 'session' }

describe('root outlet', () => {
  it('renders the root registration and fails loud when root is unregistered (boot order)', () => {
    const h = makeHost()
    h.add('root', { component: () => <b>shell</b> })
    const renderer = createSlotRenderer()
    const view = render(<>{renderer.renderRoot(h.host, {})}</>)
    expect(view.container.textContent).toBe('shell')

    const empty = makeHost()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<>{createSlotRenderer().renderRoot(empty.host, {})}</>))
      .toThrow(/boot order/)
    spy.mockRestore()
  })

  it('passes renderRoot owner props into the root component', () => {
    const h = makeHost()
    h.add('root', { component: ({ tag }: { tag?: string }) => <b>{tag}</b> })
    const view = render(<>{createSlotRenderer().renderRoot(h.host, { tag: 'OWNER' })}</>)
    expect(view.container.textContent).toBe('OWNER')
  })
})

describe('child outlets and the renderSlot binding', () => {
  it('renders declared single slots live: fallback when empty, register, dispose back', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT },
      (renderSlot) => renderSlot('k.single', {}, { fallback: <i>none</i> }))
    expect(view.container.textContent).toBe('none')
    let dispose = () => {}
    act(() => { dispose = h.add('k.single', { component: () => <b>SB</b> }) })
    expect(view.container.textContent).toBe('SB')
    act(() => { dispose() })
    expect(view.container.textContent).toBe('none')
  })

  it('renders an undeclared key as empty (declaring entry unloaded = natural blank, not a crash)', () => {
    const h = makeHost()
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT },
      (renderSlot) => <main>{renderSlot('k.single', {}, { fallback: <i>fb</i> })}</main>)
    // Declared by children (authorization) but absent from the ledger (specOf
    // undefined): the outlet renders nothing, not even the fallback path's spec dispatch.
    expect(view.container.querySelector('main')!.textContent).toBe('')
  })

  it('orders list entries, honors only-filter, dispatches keyed entries by entryKey', () => {
    const h = makeHost()
    h.declare('k.list', { kind: 'list', scope: 'root' })
    h.declare('k.keyed', { kind: 'keyed', scope: 'root' })
    h.add('k.list', { component: () => <span>b</span>, options: { id: 'b', order: 2 } })
    h.add('k.list', { component: () => <span>a</span>, options: { id: 'a', order: 1 } })
    h.add('k.keyed', { component: () => <span>goal</span>, options: { key: 'goal' } })
    const children = { 'k.list': { kind: 'list', scope: 'root' } as DeclaredSpec, 'k.keyed': { kind: 'keyed', scope: 'root' } as DeclaredSpec }
    const { view } = mountRoot(h, children, (renderSlot) => <>
      <main>{renderSlot('k.list', {})}</main>
      <aside>{renderSlot('k.list', {}, { only: 'b' })}</aside>
      <nav>{renderSlot('k.keyed', {}, { entryKey: 'goal' })}</nav>
      <footer>{renderSlot('k.keyed', {}, { entryKey: 'nope', fallback: <i>fb</i> })}</footer>
    </>)
    expect(view.container.querySelector('main')!.textContent).toBe('ab')
    expect(view.container.querySelector('aside')!.textContent).toBe('b')
    expect(view.container.querySelector('nav')!.textContent).toBe('goal')
    expect(view.container.querySelector('footer')!.textContent).toBe('fb')
  })

  it('keeps the binding identity-stable across re-renders and throws SlotOwnershipError off-declaration', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const seen: RenderSlotFn[] = []
    mountRoot(h, { 'k.single': SINGLE_ROOT }, (renderSlot) => {
      seen.push(renderSlot)
      return renderSlot('k.single', {})
    })
    // Bump the 'root' key to force a root-entry re-render (the single-kind
    // outlet only reads entries[0], so the extra entry is inert).
    act(() => { h.add('root', { component: () => null }) })
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(seen[0])
    expect(() => seen[0]!('k.undeclared', {})).toThrow(SlotOwnershipError)
  })

  it('isolates a crashing entry without collapsing siblings', () => {
    const h = makeHost()
    h.declare('k.list', { kind: 'list', scope: 'root' })
    h.add('k.list', { component: () => { throw new Error('entry boom') }, options: { id: 'bad', order: 1 } })
    h.add('k.list', { component: () => <span>alive</span>, options: { id: 'ok', order: 2 } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { view } = mountRoot(h, { 'k.list': { kind: 'list', scope: 'root' } },
      (renderSlot) => renderSlot('k.list', {}))
    spy.mockRestore()
    expect(view.container.textContent).toBe('alive')
    expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
  })
})

describe('standard-kit synthesis', () => {
  it('delivers a live useSessions hook to every slot component', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    h.add('k.single', {
      component: ({ useSessions }: { useSessions: <S>(sel: (s: { ids: string[] }) => S) => S }) =>
        <b>{useSessions((s) => s.ids.length)}</b>,
    })
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT }, (renderSlot) => renderSlot('k.single', {}))
    expect(view.container.textContent).toBe('0')
    act(() => { h.list.set({ ids: ['a', 'b'] }) })
    expect(view.container.textContent).toBe('2')
  })

  it('delivers the session pair (bound useSession + sessionId) under SessionProvider', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.addSession('s1')
    const seen: AnyProps[] = []
    h.add('k.session', {
      component: (props: { useSession?: <S>(sel: (s: { sid: string }) => S) => S; sessionId?: string }) => {
        seen.push({ ...props, read: props.useSession!((s) => s.sid) })
        return null
      },
    })
    mountRoot(h, { 'k.session': SINGLE_SESSION }, (renderSlot) => (
      <SessionProvider empty={() => <i>empty</i>}>
        {() => renderSlot('k.session', {})}
      </SessionProvider>
    ))
    act(() => { h.current.set('s1') })
    const props = seen.at(-1)!
    // The hook is BOUND by the machinery from the cell's bare source: it
    // reads the source's snapshot and stays identity-stable across renders
    // (per-source cache), which the switch-back cache tests cover.
    expect(props['read']).toBe('s1')
    expect(props['sessionId']).toBe('s1')
  })

  it('hands the SessionProvider seat to entries declaring a session-scope child', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.declare('k.single', SINGLE_ROOT)
    h.addSession('s1')
    h.add('k.session', { component: ({ sessionId }: { sessionId?: string }) => <b>{sessionId}</b> })
    const rootSeen: AnyProps[] = []
    // Root entry uses its INJECTED provider seat (no value import of SessionProvider).
    h.add('root', {
      component: (props: AnyProps) => {
        rootSeen.push(props)
        const Provider = props['SessionProvider'] as typeof SessionProvider
        const renderSlot = props['renderSlot'] as RenderSlotFn
        return (
          <Provider empty={() => <i>empty</i>}>
            {() => renderSlot('k.session', {})}
          </Provider>
        )
      },
      children: { 'k.session': SINGLE_SESSION },
    })
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    expect(view.container.textContent).toBe('empty')
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('s1')

    // Entries whose children are all root-scope get no provider seat.
    const h2 = makeHost()
    h2.declare('k.single', SINGLE_ROOT)
    const seen2: AnyProps[] = []
    h2.add('root', {
      component: (props: AnyProps) => { seen2.push(props); return null },
      children: { 'k.single': SINGLE_ROOT },
    })
    render(<>{createSlotRenderer().renderRoot(h2.host, {})}</>)
    expect(seen2.at(-1)!['SessionProvider']).toBeUndefined()
  })

  it('fails loud when a session slot renders outside SessionProvider', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.add('k.session', { component: () => <b>x</b> })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => mountRoot(h, { 'k.session': SINGLE_SESSION },
      (renderSlot) => renderSlot('k.session', {}))).toThrow(/outside SessionProvider/)
    spy.mockRestore()
  })

  it('delivers the store pair for store-declaring entries and writes through baked actions', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const handle = miniStore(() => ({ n: 0 }), { inc: (s) => ({ n: s.n + 1 }) })
    let bump = () => {}
    h.add('k.single', {
      component: ({ useStore, actions }: {
        useStore: <S>(sel: (s: { n: number }) => S) => S
        actions: { inc: () => void }
      }) => {
        bump = actions.inc
        return <b>{useStore((s) => s.n)}</b>
      },
      store: handle,
    })
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT }, (renderSlot) => renderSlot('k.single', {}))
    expect(view.container.textContent).toBe('0')
    act(() => { bump() })
    expect(view.container.textContent).toBe('1')
  })

  it('resolves session-slot stores per scope key: values survive a switch-away and back', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.addSession('s1')
    h.addSession('s2')
    const handle = miniStore(() => ({ draft: '' }), { setDraft: (_s, text: string) => ({ draft: text }) })
    let setDraft: (text: string) => void = () => {}
    h.add('k.session', {
      component: ({ useStore, actions }: {
        useStore: <S>(sel: (s: { draft: string }) => S) => S
        actions: { setDraft: (text: string) => void }
      }) => {
        setDraft = actions.setDraft
        return <b>{useStore((s) => s.draft) || '(blank)'}</b>
      },
      store: handle,
    })
    const { view } = mountRoot(h, { 'k.session': SINGLE_SESSION }, (renderSlot) => (
      <SessionProvider>{() => renderSlot('k.session', {})}</SessionProvider>
    ))
    act(() => { h.current.set('s1') })
    act(() => { setDraft('draft-one') })
    expect(view.container.textContent).toBe('draft-one')
    act(() => { h.current.set('s2') })
    expect(view.container.textContent).toBe('(blank)')   // distinct instance per session
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('draft-one') // same scope key = same instance
  })
})

describe('inject: execution point, parameter derivation, cache granularity', () => {
  it('root inject runs once per entry with no arguments (no store declared)', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const inject = vi.fn(() => ({ tag: 'FROM-INJECT' }))
    h.add('k.single', { component: ({ tag }: { tag?: string }) => <b>{tag}</b>, inject })
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT }, (renderSlot) => renderSlot('k.single', {}))
    expect(view.container.textContent).toBe('FROM-INJECT')
    act(() => { h.add('k.single', { component: () => null }) })   // sibling bump re-renders the outlet
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenCalledWith()
  })

  it('session inject receives sessionId and caches per (entry x session): switch-back reuses', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.addSession('s1')
    h.addSession('s2')
    const inject = vi.fn((sessionId: string) => ({ sid: sessionId }))
    h.add('k.session', {
      component: ({ sid }: { sid?: string }) => <b>{sid}</b>,
      inject: inject as unknown as StoredEntry['inject'],
    })
    const { view } = mountRoot(h, { 'k.session': SINGLE_SESSION }, (renderSlot) => (
      <SessionProvider>{() => renderSlot('k.session', {})}</SessionProvider>
    ))
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('s1')
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenLastCalledWith('s1')
    act(() => { h.current.set('s2') })
    expect(view.container.textContent).toBe('s2')
    expect(inject).toHaveBeenCalledTimes(2)
    act(() => { h.current.set('s1') })   // back: (entry x cell) cache hit
    expect(view.container.textContent).toBe('s1')
    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('store-declaring entries get baked actions appended to the inject parameters', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    h.declare('k.session', SINGLE_SESSION)
    h.addSession('s1')
    const handle = miniStore(() => ({ n: 0 }), { inc: (s) => ({ n: s.n + 1 }) })
    const rootInject = vi.fn((actions: { inc: () => void }) => ({ viaRoot: actions }))
    const sessionInject = vi.fn((sessionId: string, actions: { inc: () => void }) => ({ sid: sessionId, viaSession: actions }))
    const seenRoot: AnyProps[] = []
    const seenSession: AnyProps[] = []
    h.add('k.single', {
      component: (props: object) => { seenRoot.push(props as AnyProps); return null },
      inject: rootInject as unknown as StoredEntry['inject'],
      store: handle,
    })
    h.add('k.session', {
      component: (props: object) => { seenSession.push(props as AnyProps); return null },
      inject: sessionInject as unknown as StoredEntry['inject'],
      store: handle,
    })
    mountRoot(h, { 'k.single': SINGLE_ROOT, 'k.session': SINGLE_SESSION }, (renderSlot) => <>
      {renderSlot('k.single', {})}
      <SessionProvider>{() => renderSlot('k.session', {})}</SessionProvider>
    </>)
    act(() => { h.current.set('s1') })
    // The inject-received actions are the same baked callbacks the component
    // gets as props.actions (one instance per entry x scope key).
    expect(rootInject).toHaveBeenCalledTimes(1)
    expect(seenRoot.at(-1)!['viaRoot']).toBe(seenRoot.at(-1)!['actions'])
    expect(sessionInject).toHaveBeenCalledTimes(1)
    expect(sessionInject.mock.calls[0]![0]).toBe('s1')
    expect(seenSession.at(-1)!['viaSession']).toBe(seenSession.at(-1)!['actions'])
  })

  it('contains a throwing inject factory to its own entry (runs inside the component body)', () => {
    const h = makeHost()
    h.declare('k.list', { kind: 'list', scope: 'root' })
    h.add('k.list', {
      component: () => <span>never</span>,
      options: { id: 'bad', order: 1 },
      inject: () => { throw new Error('inject boom') },
    })
    h.add('k.list', { component: () => <span>alive</span>, options: { id: 'ok', order: 2 } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { view } = mountRoot(h, { 'k.list': { kind: 'list', scope: 'root' } },
      (renderSlot) => <main>{renderSlot('k.list', {})}</main>)
    spy.mockRestore()
    // The failing entry blacks out alone; the sibling and the tree above survive.
    expect(view.container.querySelector('main')).not.toBeNull()
    expect(view.container.textContent).toBe('alive')
    expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
  })

  it('merges kit, inject, and owner props with owner winning', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const seen: AnyProps[] = []
    h.add('k.single', {
      component: (props: object) => { seen.push(props as AnyProps); return null },
      inject: () => ({ fromInject: 'inject', shared: 'inject' }),
    })
    mountRoot(h, { 'k.single': SINGLE_ROOT },
      (renderSlot) => renderSlot('k.single', { owner: 'owner', shared: 'owner' }))
    const props = seen.at(-1)!
    expect(typeof props['useSessions']).toBe('function')   // kit always present
    expect(props['fromInject']).toBe('inject')
    expect(props['owner']).toBe('owner')
    expect(props['shared']).toBe('owner')   // owner overrides inject
  })
})
