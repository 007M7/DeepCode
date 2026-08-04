import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId, isJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, SessionPersistenceRevision, PersistenceCoordinator,
  type PersistenceBackend, type SessionPersistenceSnapshot, type StoredPrefix,
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

/** An unsupported named-mode fixture emulating an untyped producer. */
function legacyModeSet(seq = 0): SessionEvent {
  return {
    type: 'mode/set',
    seq,
    time: 1,
    data: { mode: 'plan' },
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
  live: Map<unknown, { pending: unknown[]; flush: Promise<void> | undefined }>
  chains: Map<unknown, unknown>
  retirements: Map<unknown, Promise<void>>
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
    // sessions through loadStored(), so store must exist first.
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

  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  // --- PersistenceBackend hooks (the Map storage primitives) ---

  // A Map-backed store has no torn tails, so `tornMarker` is never set.
  async loadStored(id: SessionId): Promise<StoredPrefix<never> | undefined> {
    const entry = this.store.get(id)
    if (!entry) return undefined
    return { meta: structuredClone(entry.meta), events: structuredClone(entry.events) }
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

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    return [...this.store.values()].map(e => structuredClone(e.meta))
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    return [...this.store.values()].map(entry => ({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(`events:${entry.events.length}`),
    }))
  }
}

/** Controllable storage primitive for serialization and retirement failure tests. */
class ControlledBackend implements PersistenceBackend<never> {
  readonly name = 'session-persistence-controlled'
  readonly store: MemoryStore = new Map()
  readonly lifecycle: string[] = []
  appendAttempts = 0
  loadAttempts = 0
  repairAttempts = 0
  beforeAppend?: (attempt: number) => Promise<void>
  beforeLoadStored?: (attempt: number, signal?: AbortSignal) => Promise<void>
  /** When set, the declared seek hook delegates here so readFrom exercises it; unset throws (tests set it first). */
  seekHook?: (id: SessionId, fromSeq: number, signal?: AbortSignal) => Promise<StoredPrefix<never> | undefined>

  loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    if (this.seekHook === undefined) throw new Error('seekHook not configured for this test')
    return this.seekHook(id, fromSeq, signal)
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    await this.beforeLoadStored?.(++this.loadAttempts, signal)
    const entry = this.store.get(id)
    if (entry === undefined) return undefined
    return { meta: structuredClone(entry.meta), events: structuredClone(entry.events) }
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

  async commitRepair(_m: SessionHeader, _tornMarker: undefined, _closers: readonly SessionEvent[]): Promise<void> {
    this.repairAttempts += 1
  }

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

describe('PersistenceCoordinator eager writes', () => {
  it('starts a follow-up batch for events admitted during an in-flight write', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async (attempt) => {
      if (attempt === 1) await appendGate.promise
    }
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const session = ctx.sessions.create(SessionId('eager-follow-up'))
      await ctx.sessions.flush(session)
      session.append('turn/start', { turn: 1 })
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })

      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      appendGate.resolve(true)

      await vi.waitFor(() => {
        expect(backend.appendAttempts).toBe(2)
        expect(backend.store.get(session.id)?.events.map(event => event.seq)).toEqual([0, 1])
      })
    } finally {
      appendGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('retries a failed overlapping eager write at the explicit flush barrier', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async (attempt) => {
      if (attempt === 1) {
        await appendGate.promise
        throw new Error('transient eager failure')
      }
    }
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const session = ctx.sessions.create(SessionId('eager-flush-retry'))
      await ctx.sessions.flush(session)
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })

      const barriers = [ctx.sessions.flush(session), ctx.sessions.flush(session)]
      appendGate.resolve(true)

      await expect(Promise.all(barriers)).resolves.toEqual([true, true])
      expect(backend.appendAttempts).toBe(2)
      expect(backend.store.get(session.id)?.events.map(event => event.seq)).toEqual([0, 1])
    } finally {
      appendGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('PersistenceCoordinator stored identity', () => {
  it('rejects a mismatched backend header before repair or state publication', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const requested = SessionId('requested')
    backend.store.set(requested, {
      meta: meta('different'),
      events: [{
        type: 'turn/start',
        seq: 0,
        time: 1,
        data: { turn: 1 },
      }],
    })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    try {
      await expect(coordinator.load(requested)).rejects.toThrow(/stored session identity mismatch/)
      expect(backend.repairAttempts).toBe(0)
      expect((coordinator as unknown as CoordinatorInternals).states.size).toBe(0)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reserves a cold id across asynchronous storage repair', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('cold-load-reservation')
    const header = meta(id)
    const start: SessionEvent = {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    }
    backend.store.set(id, { meta: header, events: [start] })
    const loadGate = Promise.withResolvers<boolean>()
    backend.beforeLoadStored = async () => { await loadGate.promise }
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const loading = coordinator.load(id)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(1) })

      await expect(ctx.plugin(Object.assign((inner: Context) => {
        inner.sessions.create(id, { seed: [start], meta: header })
      }, { inject: ['sessions'] }))).rejects.toThrow(/persisted history is loading/)
      expect(ctx.sessions.get(id)).toBeUndefined()

      loadGate.resolve(true)
      const loaded = await loading
      expect(loaded.events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])

      const resumed = ctx.sessions.create(id, { seed: loaded.events, meta: loaded.meta })
      await expect(ctx.sessions.flush(resumed)).resolves.toBe(true)
    } finally {
      loadGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('PersistenceCoordinator observation cancellation', () => {
  it('promptly rejects a queued inspect without invoking it and keeps the same-id chain healthy', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('queued-inspect-cancellation')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    const loadGate = Promise.withResolvers<boolean>()
    backend.beforeLoadStored = async (attempt) => {
      if (attempt === 1) await loadGate.promise
    }
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const prior = coordinator.inspect(id)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(1) })
      const controller = new AbortController()
      const reason = new Error('queued inspect cancelled')
      const queued = coordinator.inspect(id, controller.signal)
      let observedReason: unknown
      const observedAbort = queued.catch((error: unknown) => {
        observedReason = error
      })

      controller.abort(reason)

      await vi.waitFor(() => { expect(observedReason).toBe(reason) })
      expect(backend.loadAttempts).toBe(1)
      const subsequent = coordinator.inspect(id)
      expect(backend.loadAttempts).toBe(1)

      loadGate.resolve(true)
      await expect(prior).resolves.toMatchObject({ meta: { id } })
      await observedAbort
      await expect(subsequent).resolves.toMatchObject({ meta: { id } })
      expect(backend.loadAttempts).toBe(2)
      await vi.waitFor(() => {
        expect((coordinator as unknown as CoordinatorInternals).chains.size).toBe(0)
      })
    } finally {
      loadGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('waits for active cooperative inspection cleanup before rejecting cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('active-inspect-cancellation')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    const cleanupGate = Promise.withResolvers<boolean>()
    let cleanupComplete = false
    backend.beforeLoadStored = async (_attempt, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => {
          void cleanupGate.promise.then(() => {
            cleanupComplete = true
            resolve()
          })
        }, { once: true })
      })
      throw new Error('backend cancellation after cleanup')
    }
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const controller = new AbortController()
      const reason = new Error('active inspect cancelled')
      const pending = coordinator.inspect(id, controller.signal)
      let observedReason: unknown
      const observed = pending.catch((error: unknown) => {
        observedReason = error
      })
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(1) })

      controller.abort(reason)
      await Promise.resolve()

      expect(observedReason).toBeUndefined()
      expect(cleanupComplete).toBe(false)
      cleanupGate.resolve(true)
      await observed
      expect(cleanupComplete).toBe(true)
      expect(observedReason).toBe(reason)
      const backendFailure = new Error('later inspection failure')
      backend.beforeLoadStored = () => Promise.reject(backendFailure)
      await expect(coordinator.inspect(id)).rejects.toBe(backendFailure)
    } finally {
      cleanupGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('readFrom via the seek hook: serves the suffix, maps undefined to not-found, and relays hook failures by abort state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('seek-read-from')
    const log = oneTurnLog()
    backend.store.set(id, { meta: meta(id), events: log })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      // Happy path through the hook: only the suffix comes back, detached.
      backend.seekHook = async (hookId, fromSeq) => {
        const entry = backend.store.get(hookId)
        if (entry === undefined) return undefined
        return { meta: structuredClone(entry.meta), events: entry.events.filter(e => e.seq >= fromSeq) }
      }
      const suffix = await coordinator.readFrom(id, 3)
      expect(suffix.events).toEqual(log.slice(3))
      // The hook's undefined is the seam's not-found.
      await expect(coordinator.readFrom(SessionId('missing-seek'), 0)).rejects.toThrow('not found')

      // A hook failure with no cancellation in play propagates as-is.
      const hookFailure = new Error('seek backend exploded')
      backend.seekHook = () => Promise.reject(hookFailure)
      await expect(coordinator.readFrom(id, 0)).rejects.toBe(hookFailure)

      // A hook failure after cancellation surfaces the caller's abort reason,
      // not the backend's internal teardown error. The abort fires only once
      // the hook is provably entered, so the failure exercises the catch (not
      // the pre-invocation throwIfAborted).
      const controller = new AbortController()
      const reason = new Error('read-from cancelled mid-hook')
      let hookEntered = false
      backend.seekHook = async (_hookId, _fromSeq, signal) => {
        hookEntered = true
        await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
        throw new Error('backend teardown after abort')
      }
      const pending = coordinator.readFrom(id, 0, controller.signal)
      const observed = pending.catch((error: unknown) => error)
      await vi.waitFor(() => { expect(hookEntered).toBe(true) })
      controller.abort(reason)
      expect(await observed).toBe(reason)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects a cancelled inspect while an in-flight retirement drain is still pending', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async () => { await appendGate.promise }

    try {
      const id = SessionId('retiring-inspect')
      let session!: Session
      const sessionFiber = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      // Dispose the session so retirement starts; its append is gated, so the
      // retirement promise stays pending in the coordinator.
      await sessionFiber.dispose()
      await vi.waitFor(() => { expect(internals.retirements.has(id)).toBe(true) })

      const controller = new AbortController()
      const reason = new Error('inspect cancelled during retirement')
      const pending = coordinator.inspect(id, controller.signal)
      let observedReason: unknown
      const observed = pending.catch((error: unknown) => { observedReason = error })

      // Cancel before the gated retirement can settle: the inspect must reject
      // promptly instead of waiting for the drain, and must never reach the
      // backend read.
      controller.abort(reason)
      await vi.waitFor(() => { expect(observedReason).toBe(reason) })
      expect(backend.loadAttempts).toBe(0)

      appendGate.resolve(true)
      await observed
    } finally {
      appendGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('PersistenceCoordinator retirement', () => {
  it('a retiring unmaterialized owner without buffered events releases its id', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const loadGate = Promise.withResolvers<boolean>()
    backend.beforeLoadStored = async (attempt) => {
      if (attempt === 1) await loadGate.promise
    }

    try {
      const id = SessionId('retiring-lazy-owner')
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(1) })
      await firstFiber.dispose()

      let reuse!: Session
      await ctx.plugin(Object.assign((inner: Context) => {
        reuse = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      const reuseFlush = ctx.sessions.flush(reuse)

      loadGate.resolve(true)
      await expect(reuseFlush).resolves.toBe(true)
    } finally {
      loadGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('a superseded retirement leaves the successor lifecycle\'s pending drain in place', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    const readGate = Promise.withResolvers<boolean>()

    try {
      const id = SessionId('superseded-retirement')
      // First lifecycle: unmaterialized (zero events), so a same-id successor
      // may legally reclaim the abandoned id later.
      let first!: Session
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        first = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await ctx.sessions.flush(first)

      // Occupy the per-id serialize chain with a gated read: everything the
      // two retirements queue stays pending behind it. (Attempt counting
      // starts here — an absent beforeLoadStored short-circuits the optional
      // call without evaluating its ++ argument.)
      backend.beforeLoadStored = async (attempt) => {
        if (attempt === 1) await readGate.promise
      }
      const parked = coordinator.inspect(id).catch((error: unknown) => error)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(1) })

      // First retirement queues behind the gate and stays pending.
      await firstFiber.dispose()
      await vi.waitFor(() => { expect(internals.retirements.has(id)).toBe(true) })
      const firstRetirement = internals.retirements.get(id)

      // Successor lifecycle retires while the first drain is still in flight:
      // retire() replaces the map entry synchronously.
      const secondFiber = await ctx.plugin(Object.assign((inner: Context) => {
        inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await secondFiber.dispose()
      await vi.waitFor(() => {
        expect(internals.retirements.get(id)).not.toBe(firstRetirement)
      })

      // Release the chain: the first drain settles and its forget() must not
      // delete the successor's entry (exact-entry guard); the successor's own
      // forget() then clears the map.
      readGate.resolve(true)
      expect(await parked).toBeInstanceOf(Error) // the parked inspect (not found) is observed
      await firstRetirement
      await vi.waitFor(() => { expect(internals.retirements.has(id)).toBe(false) })
    } finally {
      readGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('a replacement queued before retirement cleanup still collides with the live owner', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const appendGate = Promise.withResolvers<boolean>()

    try {
      const id = SessionId('retiring-live-owner')
      let first!: Session
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        first = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await ctx.sessions.flush(first)
      backend.beforeAppend = async () => { await appendGate.promise }
      first.append('turn/start', { turn: 1 })
      first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })
      await firstFiber.dispose()

      let reuse!: Session
      await ctx.plugin(Object.assign((inner: Context) => {
        reuse = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      const reuseFlush = ctx.sessions.flush(reuse)

      appendGate.resolve(true)
      await expect(reuseFlush).rejects.toThrow(/bound to a different live session/)
      expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1])
    } finally {
      appendGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('a racing cold load survives retirement cleanup and rejects same-id reuse', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const appendGate = Promise.withResolvers<boolean>()
    const loadGate = Promise.withResolvers<boolean>()

    try {
      const id = SessionId('retiring-buffered-owner')
      let first!: Session
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        first = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await ctx.sessions.flush(first)
      backend.beforeAppend = async () => { await appendGate.promise }
      first.append('turn/start', { turn: 1 })
      first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })
      await firstFiber.dispose()
      const baselineLoads = backend.loadAttempts
      backend.beforeLoadStored = async () => { await loadGate.promise }
      const coldLoad = coordinator.load(id)

      appendGate.resolve(true)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(baselineLoads + 1) })

      await expect(ctx.plugin(Object.assign((inner: Context) => {
        inner.sessions.create(id)
      }, { inject: ['sessions'] }))).rejects.toThrow(/persisted history is loading/)

      loadGate.resolve(true)
      await expect(coldLoad).resolves.toMatchObject({
        events: [{ seq: 0 }, { seq: 1 }],
      })

      let reuse!: Session
      await ctx.plugin(Object.assign((inner: Context) => {
        reuse = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await expect(ctx.sessions.flush(reuse)).rejects.toThrow(/id collision/)
      await vi.waitFor(() => {
        expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1])
      })
    } finally {
      appendGate.resolve(true)
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
        data: { turn: 1 },
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
    let retryEnabled = false
    backend.beforeAppend = async () => {
      if (!retryEnabled) {
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
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await sessionFiber.dispose()

      await vi.waitFor(() => {
        expect(backend.appendAttempts).toBeGreaterThanOrEqual(1)
        expect([...internals.live.values()][0]?.pending).toEqual(expect.arrayContaining([
          expect.objectContaining({ seq: 0 }),
          expect.objectContaining({ seq: 1 }),
        ]))
      })

      retryEnabled = true
      await backendFiber.dispose()
      expect(backend.store.get(SessionId('retry-retirement'))?.events.map(event => event.seq)).toEqual([0, 1])
      expect(backend.lifecycle.at(-2)).toBe('append-committed')
      expect(backend.lifecycle.at(-1)).toBe('close')
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
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await sessionFiber.dispose()
      await vi.waitFor(() => {
        expect(backend.appendAttempts).toBe(1)
        expect(internals.live.size).toBe(1)
        expect([...internals.live.values()][0]?.flush).toBeInstanceOf(Promise)
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

  it('backend teardown waits for a detached public append before close', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async () => {
      backend.lifecycle.push('append-started')
      await appendGate.promise
      backend.lifecycle.push('append-committed')
    }

    try {
      const id = SessionId('inflight-public-append')
      await coordinator.create(meta(id))
      const append = coordinator.append(id, [{
        type: 'turn/start',
        seq: 0,
        time: 1,
        data: { turn: 1 },
      }])
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })

      let disposed = false
      const teardown = fiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)

      appendGate.resolve(true)
      await Promise.all([append, teardown])
      expect(backend.lifecycle).toEqual(['append-started', 'append-committed', 'close'])
    } finally {
      appendGate.resolve(true)
      await fiber.dispose()
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

  it('rejects a stored legacy named-mode event during load', async () => {
    const id = SessionId('legacy-mode-load')
    const m = meta(id, '/legacy')
    const store: MemoryStore = new Map([[id, { meta: m, events: [legacyModeSet()] }]])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence, { store })

    await expect(ctx.sessionPersistence.load(id))
      .rejects.toThrow('unsupported legacy mode/set event at seq 0')
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
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await ctx.sessions.flush(session)
        await sessionFiber.dispose()
      }

      await vi.waitFor(() => {
        expect(ctx.sessions.list()).toHaveLength(0)
        expect({
          states: coordinator.states.size,
          live: coordinator.live.size,
          chains: coordinator.chains.size,
        }).toEqual({ states: 0, live: 0, chains: 0 })
      })
    } finally {
      await fiber.dispose()
    }
  })
})
