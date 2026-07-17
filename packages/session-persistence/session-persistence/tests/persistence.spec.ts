import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId, isJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, PersistenceCoordinator,
  type PersistenceBackend, type StoredPrefix,
} from '../src/index.ts'
import { runPersistenceContract, meta, oneTurnLog } from './contract.ts'
import { runCoordinatorContract, type CoordinatorFixture } from './coordinator-contract.ts'

/** The durable store shape: materialized sessions only (no lazy entries). */
type MemoryStore = Map<string, { meta: SessionHeader; events: SessionEvent[] }>

/** Optional plugin config: an EXTERNAL store shared across backend instances. */
interface MemoryConfig { store?: MemoryStore }

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
})
