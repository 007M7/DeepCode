import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { SessionId, isJsonValue, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionMeta, SessionSummary } from '@deepseek-ai/dsh-session'
import { SessionPersistence, assertSerializable, seedCoversPrefix } from '../src/index.ts'
import { runPersistenceContract, meta, oneTurnLog } from './contract.ts'

/**
 * A minimal in-memory {@link SessionPersistence} used to (a) cover the abstract
 * base's constructor + service registration and (b) validate the reusable
 * contract suite itself. The real durable backend is
 * `@deepseek-ai/dsh-session-persistence-jsonl`.
 */
class MemoryPersistence extends SessionPersistence {
  private store = new Map<string, { meta: SessionMeta; events: SessionEvent[] }>()
  private pending = new Map<string, SessionMeta>()

  async create(m: SessionMeta): Promise<void> {
    // Lazy: record the intended meta, but stay absent from has/list until the
    // first append materializes the session.
    this.pending.set(m.id, m)
  }

  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const existing = this.store.get(id)
    const nextSeq = existing ? existing.events.length : 0
    if (events.length > 0 && events[0]!.seq !== nextSeq) {
      throw new Error(`append seq mismatch for "${id}": expected ${nextSeq}, got ${events[0]!.seq}`)
    }
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!
      if (e.seq !== nextSeq + i) throw new Error(`non-contiguous seq in batch for "${id}" at index ${i}`)
      if (!isJsonValue(e.data)) {
        throw new Error(`event "${e.type}" carries non-JSON-serializable data`)
      }
    }
    if (!existing) {
      const m = this.pending.get(id)
      if (!m) throw new Error(`append before create for "${id}"`)
      this.store.set(id, { meta: m, events: structuredClone(events) as SessionEvent[] })
    } else {
      existing.events.push(...structuredClone(events) as SessionEvent[])
    }
  }

  async load(id: SessionId): Promise<{ meta: SessionMeta; events: SessionEvent[] }> {
    const entry = this.store.get(id)
    if (!entry) throw new Error(`session "${id}" not found`)
    // Honor the crash-recovery contract: if the stored log ends mid-turn, close
    // the orphaned turn durably with synthetic boundary events and continue from
    // the balanced length.
    const closers = interruptedTurnClosers(entry.events)
    if (closers.length > 0) entry.events.push(...structuredClone(closers))
    return { meta: structuredClone(entry.meta), events: structuredClone(entry.events) }
  }

  async list(): Promise<SessionMeta[]> {
    return [...this.store.values()].map(e => structuredClone(e.meta))
  }

  async has(id: SessionId): Promise<boolean> {
    return this.store.has(id)
  }

  async delete(id: SessionId): Promise<void> {
    this.store.delete(id)
    this.pending.delete(id)
  }

  async update(id: SessionId, summary: Partial<SessionSummary>): Promise<void> {
    const entry = this.store.get(id)
    if (entry) Object.assign(entry.meta, summary, { updatedAt: summary.updatedAt ?? Date.now() })
  }
}

// Run the shared contract against the in-memory backend.
runPersistenceContract('memory', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(MemoryPersistence)
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => { await fiber.dispose() },
  }
})

describe('SessionPersistence service registration', () => {
  it('registers as ctx.sessionPersistence and is removed on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(MemoryPersistence)
    expect(ctx.sessionPersistence).toBeInstanceOf(SessionPersistence)

    await fiber.dispose()
    expect(ctx.sessionPersistence).toBeUndefined()
  })

  it('round-trips through the registered service instance', async () => {
    const ctx = new Context()
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
