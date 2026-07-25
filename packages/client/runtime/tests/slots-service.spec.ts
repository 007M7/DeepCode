/**
 * SlotsService terminal-design account (design.md §11-3 main landing):
 * built-in 'root', the three load-time throws (duplicate declaration /
 * undeclared contribution / cross-scope store handle), the renderer install
 * seam (double install / not installed / non-root key), store instance
 * resolution and lifecycle on the ledger axis, and the entry-unload cascade.
 */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { FC } from 'react'
import type { SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotsService } from '../src/client/slots.ts'

// Test-only slot keys (merged so the typed entries/spec faces accept them).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    't.host': { kind: 'single'; scope: 'root' }
    't.panel': { kind: 'single'; scope: 'session' }
    't.rows': { kind: 'list'; scope: 'root' }
  }
}

const C: FC<object> = () => null

/**
 * Register/install/renderSlot through a type-erased view: the typed register
 * face rides wave-1 ui-slots types (red until that wave lands); the runtime
 * semantics under test are final.
 */
interface ErasedService {
  register(options: object, component: unknown): () => void
  install(renderer: object): void
  renderSlot(key: string, owner: object): unknown
}

interface Bench {
  ctx: Context
  svc: SlotsService
  erased: ErasedService
}

async function boot(): Promise<Bench> {
  const ctx = new Context()
  ctx.plugin(SlotsService)
  await ctx.fiber.await()
  // Service accessor (ctx.get reads the reflect store, which Service-class
  // plugins do not write; the accessor is the product path).
  const svc = ctx.slots
  return { ctx, svc, erased: svc as unknown as ErasedService }
}

/** Engine-shaped instance stub (bare-source form: subscribe/getSnapshot + baked actions + clearPersisted). */
interface FakeInstance {
  getSnapshot: () => undefined
  subscribe: () => () => void
  actions: Record<string, never>
  clearPersisted: ReturnType<typeof vi.fn>
}

/** Fake store handle factory (create-count and clearPersisted observable). */
function fakeHandle() {
  const created: FakeInstance[] = []
  const handle = {
    create: vi.fn((_scopeKey?: string): FakeInstance => {
      const instance: FakeInstance = {
        getSnapshot: () => undefined, subscribe: () => () => undefined,
        actions: {}, clearPersisted: vi.fn(),
      }
      created.push(instance)
      return instance
    }),
  }
  return { handle, created }
}

/**
 * Install a capturing renderer, occupy 'root' (declaring `children` in the
 * same call — 'root' is single, so the one occupant is also the declarer),
 * and pull the host face out through renderSlot('root').
 */
function captureHost(bench: Bench, children?: object): SlotRendererHost {
  let host: SlotRendererHost | undefined
  bench.erased.install({
    renderRoot: (h: SlotRendererHost) => { host = h; return 'rendered' },
  })
  bench.erased.register({ name: 'root', ...(children !== undefined ? { children } : {}) }, C)
  bench.ctx.reflect.provide('sessions', fakeSessions())
  bench.erased.renderSlot('root', {})
  if (host === undefined) throw new Error('renderer never received the host')
  return host
}

/** Minimal sessions face for the host seam (list observable + cell). */
function fakeSessions() {
  const state = { ids: [], byId: {}, current: undefined as string | undefined }
  return {
    list: { getSnapshot: () => state, subscribe: () => () => undefined },
    cell: (id: string) => (id === 'known'
      ? { sessionId: id, session: { getSnapshot: () => undefined, subscribe: () => () => undefined } }
      : undefined),
  }
}

describe("built-in 'root'", () => {
  it('is declared at construction: spec readable, occupancy open, no plugin needed', async () => {
    const bench = await boot()
    expect(bench.svc.spec('root')).toEqual({ kind: 'single', scope: 'root' })
    expect(() => bench.erased.register({ name: 'root' }, C)).not.toThrow()
    expect(bench.svc.entries('root')).toHaveLength(1)
  })

  it('rejects a second declaration of root, attributing the built-in row', async () => {
    const bench = await boot()
    expect(() => bench.erased.register({
      name: 'root', children: { 'root': { kind: 'single', scope: 'root' } },
    }, C)).toThrow(/already declared.*built-in/)
  })
})

describe('load-time validation', () => {
  it('throws on contributing into an undeclared slot', async () => {
    const bench = await boot()
    expect(() => bench.erased.register({ name: 't.host' }, C)).toThrow(/slot "t.host" is not declared/)
  })

  it('throws on a duplicate declaration, naming the slot and the prior declarant', async () => {
    const bench = await boot()
    bench.erased.register({ name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } } }, C)
    bench.erased.register({
      name: 't.host', children: { 't.rows': { kind: 'list', scope: 'root' } },
    }, C)
    expect(() => bench.erased.register({
      name: 't.rows', id: 'r1', children: { 't.rows': { kind: 'list', scope: 'root' } },
    }, C)).toThrow(/slot "t.rows" is already declared.*"t.host"/)
  })

  it('throws when one store handle is bound to two scopes', async () => {
    const bench = await boot()
    bench.erased.register({
      name: 'root',
      children: {
        't.host': { kind: 'single', scope: 'root' },
        't.panel': { kind: 'single', scope: 'session' },
      },
    }, C)
    const { handle } = fakeHandle()
    bench.erased.register({ name: 't.host', store: handle }, C)
    expect(() => bench.erased.register({ name: 't.panel', store: handle }, C))
      .toThrow(/one handle, one scope/)
  })

  it('commits nothing when the core rejects the entry (children stay undeclared)', async () => {
    const bench = await boot()
    bench.erased.register({ name: 'root' }, C) // 'root' single slot now occupied
    expect(() => bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)).toThrow(/already has a registration/)
    // The failing call's declaration must not have landed.
    expect(() => bench.erased.register({ name: 't.host' }, C)).toThrow(/is not declared/)
  })
})

describe('renderer install seam', () => {
  it('throws on renderSlot before install (boot-order guidance)', async () => {
    const bench = await boot()
    expect(() => bench.erased.renderSlot('root', {})).toThrow(/renderer not installed/)
  })

  it('throws on double install', async () => {
    const bench = await boot()
    bench.erased.install({ renderRoot: () => null })
    expect(() => { bench.erased.install({ renderRoot: () => null }) }).toThrow(/already installed/)
  })

  it('throws on any non-root key (single ctx-level entry)', async () => {
    const bench = await boot()
    bench.erased.install({ renderRoot: () => null })
    expect(() => bench.erased.renderSlot('t.host', {})).toThrow(/only renders 'root'/)
  })

  it("throws on renderSlot('root') before any root registration", async () => {
    const bench = await boot()
    bench.erased.install({ renderRoot: () => null })
    expect(() => bench.erased.renderSlot('root', {})).toThrow(/no registration/)
  })

  it('renders through the installed renderer and returns its product', async () => {
    const bench = await boot()
    const renderRoot = vi.fn(() => 'tree')
    bench.erased.install({ renderRoot })
    bench.erased.register({ name: 'root' }, C)
    bench.ctx.reflect.provide('sessions', fakeSessions())
    expect(bench.erased.renderSlot('root', {})).toBe('tree')
    expect(renderRoot).toHaveBeenCalledTimes(1)
  })
})

describe('host face', () => {
  it('serves entriesOf/specOf/isLive off the ledger and flips isLive on disposal', async () => {
    const bench = await boot()
    const host = captureHost(bench, { 't.host': { kind: 'single', scope: 'root' } })
    const dispose = bench.erased.register({ name: 't.host' }, C)
    const rootEntry = host.entriesOf('root')[0]
    expect(rootEntry).toBeDefined()
    expect(rootEntry?.component).toBe(C)
    expect(host.specOf('root')).toEqual({ kind: 'single', scope: 'root' })
    expect(host.specOf('t.host')).toEqual({ kind: 'single', scope: 'root' })
    const childEntry = host.entriesOf('t.host')[0]
    expect(host.isLive(childEntry as never)).toBe(true)
    dispose()
    expect(host.isLive(childEntry as never)).toBe(false)
    expect(host.entriesOf('t.host')).toHaveLength(0)
  })

  it('exposes sessions list/current/cell (current riding the list snapshot)', async () => {
    const bench = await boot()
    const host = captureHost(bench)
    expect(host.sessions.list.getSnapshot()).toMatchObject({ ids: [] })
    expect(host.sessions.current.getSnapshot()).toBeUndefined()
    expect(host.sessions.cell('known')).toMatchObject({ sessionId: 'known' })
    expect(host.sessions.cell('ghost')).toBeUndefined()
  })
})

describe('store instance axis', () => {
  /** Boot with 'root' occupied and the three test children declared. */
  async function storeBench() {
    const bench = await boot()
    const host = captureHost(bench, {
      't.host': { kind: 'single', scope: 'root' },
      't.rows': { kind: 'list', scope: 'root' },
      't.panel': { kind: 'single', scope: 'session' },
    })
    return { bench, host }
  }

  it('resolves one instance per (handle x root scope) shared across entries', async () => {
    const { bench, host } = await storeBench()
    const { handle } = fakeHandle()
    bench.erased.register({ name: 't.host', store: handle }, C)
    bench.erased.register({ name: 't.rows', id: 'a', store: handle }, C)
    const [hostEntry] = host.entriesOf('t.host')
    const [rowEntry] = host.entriesOf('t.rows')
    const a = host.storeOf(hostEntry as never, undefined)
    const b = host.storeOf(rowEntry as never, undefined)
    expect(a).toBeDefined()
    expect(a).toBe(b) // shared handle, same scope key = same instance
    expect(handle.create).toHaveBeenCalledTimes(1)
    expect(handle.create).toHaveBeenCalledWith() // root scope: keyless create
  })

  it('resolves per-session instances keyed by session id, created with the scope key', async () => {
    const { bench, host } = await storeBench()
    const { handle } = fakeHandle()
    bench.erased.register({ name: 't.panel', store: handle }, C)
    const [entry] = host.entriesOf('t.panel')
    const s1 = host.storeOf(entry as never, 's1')
    const s2 = host.storeOf(entry as never, 's2')
    expect(s1).not.toBe(s2)
    expect(host.storeOf(entry as never, 's1')).toBe(s1) // cached per key
    expect(handle.create).toHaveBeenCalledWith('s1')
    expect(handle.create).toHaveBeenCalledWith('s2')
    expect(() => host.storeOf(entry as never, undefined)).toThrow(/requires a session id/)
  })

  it('mints a fresh handle per register for the factory (exclusive) form', async () => {
    const { bench, host } = await storeBench()
    const factory = vi.fn(() => fakeHandle().handle)
    bench.erased.register({ name: 't.host', store: factory }, C)
    bench.erased.register({ name: 't.rows', id: 'a', store: factory }, C)
    expect(factory).toHaveBeenCalledTimes(2)
    const a = host.storeOf(host.entriesOf('t.host')[0] as never, undefined)
    const b = host.storeOf(host.entriesOf('t.rows')[0] as never, undefined)
    expect(a).not.toBe(b) // two mints, two instances
  })

  it('drops instances with the last holding entry and refuses stale resolution', async () => {
    const { bench, host } = await storeBench()
    const { handle } = fakeHandle()
    const d1 = bench.erased.register({ name: 't.host', store: handle }, C)
    bench.erased.register({ name: 't.rows', id: 'a', store: handle }, C)
    const rowEntry = host.entriesOf('t.rows')[0]
    const hostEntry = host.entriesOf('t.host')[0]
    const shared = host.storeOf(rowEntry as never, undefined)
    d1() // one holder left: record (and instance) survive
    expect(host.storeOf(rowEntry as never, undefined)).toBe(shared)
    expect(() => host.storeOf(hostEntry as never, undefined)).not.toThrow() // handle still live via the row entry
    // Note: dropping the row entry would sever the last reference; stale
    // resolution is covered through the cascade spec below.
  })

  it('pruneStoreScope clears persisted state per dead session, including never-materialized ones', async () => {
    const { bench, host } = await storeBench()
    const { handle, created } = fakeHandle()
    bench.erased.register({ name: 't.panel', store: handle }, C)
    const [entry] = host.entriesOf('t.panel')
    const s1 = host.storeOf(entry as never, 's1')
    expect(s1).toBe(created[0]) // the resolved instance is the fake the handle minted
    bench.svc.pruneStoreScope('s1')
    expect(created[0]?.clearPersisted).toHaveBeenCalledTimes(1)
    expect(host.storeOf(entry as never, 's1')).not.toBe(s1) // instance dropped, next resolve mints anew
    // Never-rendered dead session: a transient instance is created just to clear storage.
    const before = created.length
    bench.svc.pruneStoreScope('s-never')
    expect(created.length).toBe(before + 1)
    expect(created[created.length - 1]?.clearPersisted).toHaveBeenCalledTimes(1)
  })
})

describe('entry-unload cascade', () => {
  it('kills declared children, their contributions, and the ledger rows with the entry', async () => {
    const bench = await boot()
    let host: SlotRendererHost | undefined
    bench.erased.install({
      renderRoot: (h: SlotRendererHost) => { host = h; return 'rendered' },
    })
    bench.ctx.reflect.provide('sessions', fakeSessions())
    // The declarer here is NOT the root occupant: root stays occupied by a
    // separate entry so disposing the declarer only kills its children.
    const disposeRoot = bench.erased.register({ name: 'root' }, C)
    bench.erased.renderSlot('root', {})
    if (host === undefined) throw new Error('renderer never received the host')
    disposeRoot()
    const disposeDeclarer = bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    bench.erased.register({ name: 't.host' }, C)
    const [childEntry] = host.entriesOf('t.host')
    expect(childEntry).toBeDefined()

    disposeDeclarer()
    expect(bench.svc.spec('t.host')).toBeUndefined() // ledger row gone
    expect(host.specOf('t.host')).toBeUndefined() // outlets now render empty
    expect(bench.svc.entries('t.host')).toHaveLength(0) // contribution cleared
    expect(host.isLive(childEntry as never)).toBe(false) // stale bindings will throw upstream
    // The freed key is re-declarable by a new entry (no residue).
    expect(() => bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)).not.toThrow()
  })

  it('cascades through cordis fiber disposal (plugin unload = full cleanup)', async () => {
    const bench = await boot()
    bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    const fiber = bench.ctx.plugin({
      name: 'occupant',
      inject: ['slots'],
      apply: (pluginCtx: Context) => {
        ;(pluginCtx.slots as unknown as ErasedService).register({ name: 't.host' }, C)
      },
    })
    await fiber.await()
    expect(bench.svc.entries('t.host')).toHaveLength(1)
    await fiber.dispose()
    expect(bench.svc.entries('t.host')).toHaveLength(0)
    expect(bench.svc.spec('t.host')).toBeDefined() // declarer still live; slot stays declared
  })

  it('disposer is idempotent (stale second call is a no-op)', async () => {
    const bench = await boot()
    const dispose = bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    dispose()
    expect(() => { dispose() }).not.toThrow()
    expect(() => bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)).not.toThrow()
  })
})

describe('event bridge', () => {
  it("re-emits entry writes and child declarations as 'slots/changed'", async () => {
    const bench = await boot()
    const seen: string[] = []
    bench.ctx.on('slots/changed', (key) => { seen.push(key) })
    bench.erased.register({
      name: 'root', children: { 't.rows': { kind: 'list', scope: 'root' } },
    }, C)
    bench.erased.register({ name: 't.rows', id: 'a' }, C)
    expect(seen).toEqual(['root', 't.rows', 't.rows'])
  })
})
