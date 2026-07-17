import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId, isJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, PersistenceCoordinator,
  type PersistenceBackend, type StoredPrefix,
} from '../src/index.ts'
import { runPersistenceContract, meta, oneTurnLog } from './contract.ts'
import { runCoordinatorContract, type CoordinatorFixture } from './coordinator-contract.ts'

/** The durable store shape: materialized sessions only (no lazy entries). */
type MemoryStore = Map<string, { meta: SessionHeader; events: SessionEvent[] }>

/** An obsolete event fixture that emulates an untyped pre-change producer. */
function legacyHeaderDelta(seq = 0): SessionEvent {
  return {
    type: 'request/header-delta',
    seq,
    time: 1,
    data: { config: { model: 'legacy' } },
  } as unknown as SessionEvent
}

/** An obsolete full-header reason fixture from the removed delta codec. */
function legacyFallbackHeader(seq = 0): SessionEvent {
  return {
    type: 'request/header',
    seq,
    time: 1,
    data: { header: { config: { model: 'legacy' } }, reason: 'fallback' },
  } as unknown as SessionEvent
}

/** Optional plugin config: an EXTERNAL store shared across backend instances. */
interface MemoryConfig { store?: MemoryStore }

/** Test-only view of the coordinator containers whose retirement is the contract under test. */
interface CoordinatorInternals {
  states: Map<unknown, unknown>
  buffers: Map<unknown, unknown>
  chains: Map<unknown, unknown>
  inits: Map<unknown, unknown>
  retirements: Set<Promise<void>>
}

/**
 * Reference {@link PersistenceCoordinator} vehicle and abstract-service coverage, backed by a
 * dependency-free map with atomic writes and no torn-tail marker. Supplying the map lets multiple
 * instances share materialized sessions, the in-memory analogue of reload over one file/database;
 * durable behavior is covered by the JSONL and SQLite backends.
 */
class MemoryPersistence extends SessionPersistence implements PersistenceBackend<never> {
  static inject = ['sessions']

  override readonly name = 'session-persistence-memory'

  /** The whole durable store: materialized sessions only (no lazy entries). */
  private store: MemoryStore
  private coordinator: PersistenceCoordinator<never>

  constructor(ctx: Context, config?: MemoryConfig) {
    super(ctx)
    // Assign the store BEFORE constructing the coordinator: the coordinator's
    // constructor installs the write path and synchronously seeds existing live
    // sessions (onCreated → loadLive → this.store), so store must exist first.
    this.store = config?.store ?? new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
    this.coordinator = new PersistenceCoordinator<never>(this.ctx, this)
  }

  // --- service surface (delegated to the coordinator) ---

  locate(_meta: SessionHeader): undefined {
    return undefined
  }

  create(m: SessionHeader): Promise<void> {
    return this.coordinator.create(m)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.load(id)
  }

  // --- PersistenceBackend hooks (the Map storage primitives) ---

  // A Map-backed store has no torn tails, so `tornMarker` is never set. Ids are
  // globally unique, so loadStored and loadLive are identical (cwd is ignored).
  async loadStored(id: SessionId): Promise<StoredPrefix<never> | undefined> {
    const entry = this.store.get(id)
    if (!entry) return undefined
    return { meta: structuredClone(entry.meta), events: structuredClone(entry.events) }
  }

  loadLive(id: SessionId, _cwd: string | undefined): Promise<StoredPrefix<never> | undefined> {
    return this.loadStored(id)
  }

  async appendBatch(m: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean): Promise<void> {
    // Defense-in-depth: the coordinator already validates serializability, but a
    // durable store must reject non-JSON data at its own boundary too.
    for (const e of events) {
      if (!isJsonValue(e.data)) throw new Error(`event "${e.type}" carries non-JSON-serializable data`)
    }
    const existing = this.store.get(m.id)
    if (!existing) {
      // The coordinator sends the first batch for materialization; later batches append.
      this.store.set(m.id, { meta: structuredClone(m), events: structuredClone(events) as SessionEvent[] })
    } else {
      existing.events.push(...structuredClone(events) as SessionEvent[])
    }
  }

  async commitRepair(m: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    // No torn tails in a Map store, so `_tornMarker` is always undefined; only the
    // synthetic closers are appended (the same DELETE+INSERT a DB backend does,
    // minus the truncate).
    const entry = this.store.get(m.id)
    /* v8 ignore next -- commitRepair only runs for a materialized (stored) session */
    if (!entry) return
    if (closers.length > 0) entry.events.push(...structuredClone(closers) as SessionEvent[])
  }

  async list(): Promise<SessionHeader[]> {
    return [...this.store.values()].map(e => structuredClone(e.meta))
  }
}

/** Controllable storage primitive for serialization and retirement failure tests. */
class ControlledBackend implements PersistenceBackend<never> {
  readonly name = 'session-persistence-controlled'
  readonly store: MemoryStore = new Map()
  readonly lifecycle: string[] = []
  appendAttempts = 0
  loadAttempts = 0
  beforeAppend?: (attempt: number) => Promise<void>
  beforeLoadStored?: (attempt: number) => Promise<void>

  async loadStored(id: SessionId): Promise<StoredPrefix<never> | undefined> {
    await this.beforeLoadStored?.(++this.loadAttempts)
    const entry = this.store.get(id)
    if (entry === undefined) return undefined
    return { meta: structuredClone(entry.meta), events: structuredClone(entry.events) }
  }

  loadLive(id: SessionId, _cwd: string | undefined): Promise<StoredPrefix<never> | undefined> {
    return this.loadStored(id)
  }

  async appendBatch(m: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean): Promise<void> {
    const attempt = ++this.appendAttempts
    await this.beforeAppend?.(attempt)
    const entry = this.store.get(m.id)
    if (entry === undefined) {
      this.store.set(m.id, { meta: structuredClone(m), events: structuredClone(events) as SessionEvent[] })
    } else {
      entry.events.push(...structuredClone(events) as SessionEvent[])
    }
  }

  async commitRepair(_m: SessionHeader, _tornMarker: undefined, _closers: readonly SessionEvent[]): Promise<void> {}

  async list(): Promise<SessionHeader[]> {
    return [...this.store.values()].map(entry => structuredClone(entry.meta))
  }

  async close(): Promise<void> {
    this.lifecycle.push('close')
  }
}

// Run the shared contract against the in-memory backend.
runPersistenceContract('memory', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(MemoryPersistence)
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => { await fiber.dispose() },
  }
})

// Each fixture shares one map across mounts. No `corruptTail` is supplied because map writes are
// atomic; the suite asserts that skip while JSONL and SQLite cover the repair branch.
runCoordinatorContract('memory', async (): Promise<CoordinatorFixture> => {
  const store: MemoryStore = new Map()
  return {
    mount: async ctx => ctx.plugin(MemoryPersistence, { store }),
    cleanup: async () => { store.clear() },
  }
})

describe('PersistenceCoordinator retirement', () => {
  it('a retiring unmaterialized owner without buffered events releases its id', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const loadGate = Promise.withResolvers<boolean>()

    try {
      const id = SessionId('retiring-lazy-owner')
      let first!: Session
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        first = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await ctx.sessions.flush(first)

      const baselineLoads = backend.loadAttempts
      backend.beforeLoadStored = async () => { await loadGate.promise }
      const blockingLoad = coordinator.load(id)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(baselineLoads + 1) })
      await firstFiber.dispose()

      let reuse!: Session
      await ctx.plugin(Object.assign((inner: Context) => {
        reuse = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(baselineLoads + 2) })

      loadGate.resolve(true)
      await expect(blockingLoad).rejects.toThrow(/not found/)
      await expect(ctx.sessions.flush(reuse)).resolves.toBeUndefined()
    } finally {
      loadGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('a retiring owner with buffered events still rejects same-id reuse', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const loadGate = Promise.withResolvers<boolean>()

    try {
      const id = SessionId('retiring-buffered-owner')
      let first!: Session
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        first = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await ctx.sessions.flush(first)
      first.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const baselineLoads = backend.loadAttempts
      backend.beforeLoadStored = async () => { await loadGate.promise }
      const blockingLoad = coordinator.load(id)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(baselineLoads + 1) })
      await firstFiber.dispose()

      let reuse!: Session
      await ctx.plugin(Object.assign((inner: Context) => {
        reuse = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await expect(ctx.sessions.flush(reuse)).rejects.toThrow(/bound to a different live session/)

      loadGate.resolve(true)
      await expect(blockingLoad).rejects.toThrow(/not found/)
      await vi.waitFor(() => {
        expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1])
      })
    } finally {
      loadGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('a settled chain tail cannot delete a newer operation for the same id', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    const first = Promise.withResolvers<boolean>()
    const second = Promise.withResolvers<boolean>()
    backend.beforeAppend = async (attempt) => {
      if (attempt === 1) await first.promise
      if (attempt === 2) await second.promise
    }

    try {
      const id = SessionId('chain-tail')
      await coordinator.create(meta(id))
      const firstAppend = coordinator.append(id, [{
        type: 'turn/start',
        seq: 0,
        time: 1,
        data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      }])
      const secondAppend = coordinator.append(id, [{
        type: 'turn/end',
        seq: 1,
        time: 2,
        data: { turn: 1, reason: { kind: 'completed' } },
      }])

      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })
      first.resolve(true)
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(2) })
      expect(internals.chains.size).toBe(1)
      second.resolve(true)
      await Promise.all([firstAppend, secondAppend])
      await vi.waitFor(() => { expect(internals.chains.size).toBe(0) })
      expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1])
    } finally {
      first.resolve(true)
      second.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('backend teardown retries a failed session retirement before close', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    backend.beforeAppend = async (attempt) => {
      if (attempt === 1) {
        backend.lifecycle.push('append-failed')
        throw new Error('transient append failure')
      }
      backend.lifecycle.push('append-committed')
    }

    try {
      let session!: Session
      const sessionFiber = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(SessionId('retry-retirement'))
      }, { inject: ['sessions'] }))
      session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await sessionFiber.dispose()

      await vi.waitFor(() => {
        expect(backend.appendAttempts).toBe(1)
        expect(internals.retirements.size).toBe(0)
      })
      expect([...internals.buffers.values()]).toEqual([expect.arrayContaining([
        expect.objectContaining({ seq: 0 }),
        expect.objectContaining({ seq: 1 }),
      ])])

      await backendFiber.dispose()
      expect(backend.store.get(SessionId('retry-retirement'))?.events.map(event => event.seq)).toEqual([0, 1])
      expect(backend.lifecycle).toEqual(['append-failed', 'append-committed', 'close'])
    } finally {
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('backend teardown waits for an in-flight session retirement before close', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async () => {
      backend.lifecycle.push('append-started')
      await appendGate.promise
      backend.lifecycle.push('append-committed')
    }

    try {
      let session!: Session
      const sessionFiber = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(SessionId('inflight-retirement'))
      }, { inject: ['sessions'] }))
      session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await sessionFiber.dispose()
      await vi.waitFor(() => {
        expect(backend.appendAttempts).toBe(1)
        expect(internals.retirements.size).toBe(1)
      })

      let disposed = false
      const teardown = backendFiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(backend.lifecycle).toEqual(['append-started'])

      appendGate.resolve(true)
      await teardown
      expect(backend.store.get(SessionId('inflight-retirement'))?.events.map(event => event.seq)).toEqual([0, 1])
      expect(backend.lifecycle).toEqual(['append-started', 'append-committed', 'close'])
    } finally {
      appendGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('SessionPersistence service registration', () => {
  it('registers as ctx.sessionPersistence and is removed on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    expect(ctx.sessionPersistence).toBeInstanceOf(SessionPersistence)

    await fiber.dispose()
    expect(ctx.sessionPersistence).toBeUndefined()
  })

  it('round-trips through the registered service instance', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const m = meta('reg')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toHaveLength(6)
    await fiber.dispose()
  })

  it('rejects non-JSON session metadata before registering lazy state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const invalid = { ...meta('invalid-meta'), createdAt: 1n as unknown as number }

    await expect(ctx.sessionPersistence.create(invalid))
      .rejects.toThrow('session metadata must be losslessly JSON-serializable')
    await fiber.dispose()
  })

  it('rejects a legacy header delta from a pre-change live producer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const session = ctx.sessions.create(SessionId('legacy-live'), { meta: { cwd: '/legacy' } })
    // Model the runtime shape available to JavaScript or a hot-loaded plugin
    // compiled against the obsolete event vocabulary.
    const appendLegacy = session.append.bind(session) as (type: string, data: unknown) => SessionEvent
    expect(() => appendLegacy('request/header-delta', { config: { model: 'legacy' } }))
      .toThrow(/unsupported legacy request\/header-delta format/)
    expect(session.events).toHaveLength(0)
    await fiber.dispose()
  })

  it('rejects a legacy fallback header buffered by a pre-change live producer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const session = ctx.sessions.create(SessionId('legacy-fallback-live'), { meta: { cwd: '/legacy' } })
    const appendLegacy = session.append.bind(session) as (type: string, data: unknown) => SessionEvent

    expect(() => appendLegacy('request/header', legacyFallbackHeader().data))
      .toThrow('unsupported legacy request/header reason "fallback"')
    expect(session.events).toHaveLength(0)
    await fiber.dispose()
  })

  it('rejects a legacy stored prefix during live HMR adoption', async () => {
    const id = SessionId('legacy-hmr')
    const m = meta(id, '/legacy')
    const legacy = legacyHeaderDelta()
    const store: MemoryStore = new Map([[id, { meta: m, events: [legacy] }]])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // A current live session cannot carry the obsolete event in its seed, but
    // HMR still has to identify the persisted prefix as unsupported rather than
    // treating it as an ordinary live-prefix collision.
    const session = ctx.sessions.create(id, { meta: { cwd: '/legacy' } })
    const fiber = await ctx.plugin(MemoryPersistence, { store })

    await expect(ctx.sessions.flush(session))
      .rejects.toThrow(/unsupported legacy request\/header-delta event at seq 0/)
    await Promise.allSettled([fiber.dispose()])
  })

  it('rejects a stored legacy fallback header during load', async () => {
    const id = SessionId('legacy-fallback-load')
    const m = meta(id, '/legacy')
    const store: MemoryStore = new Map([[id, { meta: m, events: [legacyFallbackHeader()] }]])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence, { store })

    await expect(ctx.sessionPersistence.load(id))
      .rejects.toThrow('unsupported legacy request/header reason "fallback" at seq 0')
    await fiber.dispose()
  })

  it('retires all coordinator bookkeeping for disposed sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const { coordinator } = ctx.sessionPersistence as unknown as { coordinator: CoordinatorInternals }

    try {
      for (let index = 0; index < 3; index += 1) {
        let session!: Session
        const sessionFiber = await ctx.plugin(Object.assign((inner: Context) => {
          session = inner.sessions.create(SessionId(`disposed-${index}`))
        }, { inject: ['sessions'] }))
        session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await ctx.sessions.flush(session)
        await sessionFiber.dispose()
      }

      await vi.waitFor(() => {
        expect(ctx.sessions.list()).toHaveLength(0)
        expect({
          states: coordinator.states.size,
          buffers: coordinator.buffers.size,
          chains: coordinator.chains.size,
          inits: coordinator.inits.size,
          retirements: coordinator.retirements.size,
        }).toEqual({ states: 0, buffers: 0, chains: 0, inits: 0, retirements: 0 })
      })
    } finally {
      await fiber.dispose()
    }
  })
})
