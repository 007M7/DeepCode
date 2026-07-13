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

/** An obsolete event fixture that emulates an untyped pre-change producer. */
function legacyHeaderDelta(seq = 0): SessionEvent {
  return {
    type: 'request/header-delta',
    seq,
    time: 1,
    data: { config: { model: 'legacy' } },
  } as unknown as SessionEvent
}

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

  it('rejects non-JSON session metadata before registering lazy state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const invalid = { ...meta('invalid-meta'), createdAt: 1n as unknown as number }

    await expect(ctx.sessionPersistence.create(invalid))
      .rejects.toThrow('session metadata must be losslessly JSON-serializable')
    await fiber.dispose()
  })

  it('rejects a legacy header delta buffered by a pre-change live producer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const session = ctx.sessions.create(SessionId('legacy-live'), { meta: { cwd: '/legacy' } })
    // Model the runtime shape available to JavaScript or a hot-loaded plugin
    // compiled against the obsolete event vocabulary.
    const appendLegacy = session.append.bind(session) as (type: string, data: unknown) => SessionEvent
    appendLegacy('request/header-delta', { config: { model: 'legacy' } })

    await expect(ctx.sessions.flush(session))
      .rejects.toThrow(/unsupported legacy request\/header-delta event at seq 0/)
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
})
