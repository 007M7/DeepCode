import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SessionId, isJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, PersistenceCoordinator, assertSerializable, seedCoversPrefix,
  type PersistenceBackend, type StoredPrefix,
} from '../src/index.ts'
import { runPersistenceContract, meta, oneTurnLog } from './contract.ts'
import { runCoordinatorContract, type CoordinatorFixture } from './coordinator-contract.ts'

/** The durable store shape: materialized sessions only (no lazy entries). */
type MemoryStore = Map<string, { meta: SessionHeader; events: SessionEvent[] }>

/** Optional plugin config: an EXTERNAL store shared across backend instances. */
interface MemoryConfig { store?: MemoryStore }

/**
 * A trivial in-memory {@link SessionPersistence} that composes a
 * {@link PersistenceCoordinator} over a dependency-free `Map`-backed
 * {@link PersistenceBackend}. It is BOTH the coordinator's reference vehicle
 * (the simplest possible storage — a `Map<id, {meta, events}>` with no torn
 * tails, so `tornMarker` is always undefined) and the cover for the abstract
 * base's constructor + service registration. The real durable backends are
 * `@deepseek-ai/dsh-session-persistence-jsonl` / `-sqlite`.
 *
 * The store can be supplied via config so two backend instances share one Map —
 * the in-RAM analogue of two backends over the same file/db, which the
 * coordinator orchestration suite's HMR/reload tests need (a fresh instance with
 * an empty in-memory states map adopting an already-materialized session).
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

  create(m: SessionHeader): Promise<void> {
    return this.coordinator.create(m)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.load(id)
  }

  has(id: SessionId): Promise<boolean> {
    return this.coordinator.has(id)
  }

  delete(id: SessionId): Promise<void> {
    return this.coordinator.delete(id)
  }

  /** White-box accessor: await a specific session's onCreated init. */
  get inits(): Map<Session, Promise<void>> {
    return this.coordinator.inits
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
      // First batch: `_isMaterialized` is false (the coordinator only omits
      // materialization on the first batch); writing the entry IS the materialization.
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

  async deleteStored(id: SessionId): Promise<void> {
    this.store.delete(id)
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

// Run the shared coordinator orchestration suite against the in-memory backend.
// A per-fixture Map is the shared "storage", so two mounted instances see the
// same materialized sessions (HMR/reload). `corruptTail` is OMITTED: a Map store
// writes atomically in RAM and has no torn tails, so the suite's torn-tail test
// self-skips (and asserts the omission). The real torn-tail repair branch is
// covered by the jsonl/sqlite fixtures, which CAN inject one.
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
})

describe('shared persistence helpers', () => {
  it('accepts a seed that reproduces the persisted prefix exactly', () => {
    const log = oneTurnLog()
    expect(seedCoversPrefix(log, log.slice(0, 3))).toBe(true)
    expect(seedCoversPrefix(log, [])).toBe(true)
  })

  it('rejects a prefix longer than the seed', () => {
    const log = oneTurnLog()
    expect(seedCoversPrefix(log.slice(0, 2), log)).toBe(false)
  })

  it('rejects a same-envelope event with mutated data', () => {
    const log = oneTurnLog()
    const tampered = structuredClone(log)
    const event = tampered[1]!
    tampered[1] = {
      ...event,
      data: { ...event.data, content: [{ type: 'text', text: 'tampered' }] },
    } as SessionEvent
    expect(seedCoversPrefix(tampered, log.slice(0, 2))).toBe(false)
  })

  it('accepts JSON-serializable event data', () => {
    expect(() => { assertSerializable(oneTurnLog()) }).not.toThrow()
  })

  it('rejects non-JSON-serializable event data with type and seq context', () => {
    const bad = [
      { type: 'user/message', seq: 0, time: 1, data: { content: 1n } },
    ] as unknown as SessionEvent[]
    expect(() => { assertSerializable(bad) }).toThrow(/"user\/message".*seq 0/)
  })
})
