/**
 * Reusable contract test for any {@link SessionPersistence} backend. A backend
 * package imports {@link runPersistenceContract} and calls it with a factory
 * that yields a fresh, empty backend (and a teardown), so every backend is held
 * to the same append-only / contiguous-seq / lazy-materialization / crash
 * semantics. The JSONL backend's own spec adds file-specific tests on top.
 *
 * @module @deepseek-ai/dsh-session-persistence/tests/contract
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionMeta } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '../src/index.ts'

/** A backend under test plus its teardown. */
export interface ContractBackend {
  persistence: SessionPersistence
  dispose: () => Promise<void>
}

/** Build a minimal {@link SessionMeta} for a session id. */
export function meta(id: string, cwd?: string): SessionMeta {
  return {
    version: 1,
    id: SessionId(id),
    createdAt: 1000,
    updatedAt: 1000,
    ...cwd !== undefined ? { cwd } : {},
  }
}

/** A well-formed one-turn event log (contiguous seqs from 0). */
export function oneTurnLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * Run the backend-agnostic contract suite. `make()` MUST return a fresh, empty
 * backend each call.
 */
export function runPersistenceContract(name: string, make: () => Promise<ContractBackend>): void {
  describe(`SessionPersistence contract: ${name}`, () => {
    it('round-trips a session: create + append → load returns identical meta and byte-identical events', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s1', '/work')
        const log = oneTurnLog()
        await persistence.create(m)
        await persistence.append(m.id, log)

        const loaded = await persistence.load(m.id)
        expect(loaded.meta).toMatchObject({ version: 1, id: m.id, cwd: '/work' })
        expect(loaded.events).toEqual(log)
      } finally {
        await dispose()
      }
    })

    it('has()/list() exclude a created-but-never-appended (zero-event) session', async () => {
      const { persistence, dispose } = await make()
      try {
        await persistence.create(meta('empty'))
        expect(await persistence.has(SessionId('empty'))).toBe(false)
        expect((await persistence.list()).map(m => m.id)).not.toContain(SessionId('empty'))
      } finally {
        await dispose()
      }
    })

    it('has()/list() include a session once it has events', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s2')
        await persistence.create(m)
        await persistence.append(m.id, oneTurnLog())
        expect(await persistence.has(m.id)).toBe(true)
        expect((await persistence.list()).map(x => x.id)).toContain(m.id)
      } finally {
        await dispose()
      }
    })

    it('append rejects a batch whose first seq does not match the stored next-seq', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s3')
        await persistence.create(m)
        await persistence.append(m.id, oneTurnLog()) // seqs 0..5, next-seq = 6
        // A re-append of an already-stored seq must be rejected, not duplicated.
        const restated = oneTurnLog()
        await expect(persistence.append(m.id, restated)).rejects.toThrow()
      } finally {
        await dispose()
      }
    })

    it('append rejects a mid-batch seq gap', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s4')
        await persistence.create(m)
        const gapped: SessionEvent[] = [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
          { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }, // gap: missing seq 1
        ]
        await expect(persistence.append(m.id, gapped)).rejects.toThrow()
      } finally {
        await dispose()
      }
    })

    it('append rejects non-JSON-serializable event data, naming the event type', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s5')
        await persistence.create(m)
        // A plugin-added event carrying a BigInt (not JSON-serializable).
        const bad = [
          { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, extra: 1n } },
        ] as unknown as SessionEvent[]
        await expect(persistence.append(m.id, bad)).rejects.toThrow(/user\/message/)
      } finally {
        await dispose()
      }
    })

    it('delete removes a session', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s6')
        await persistence.create(m)
        await persistence.append(m.id, oneTurnLog())
        expect(await persistence.has(m.id)).toBe(true)
        await persistence.delete(m.id)
        expect(await persistence.has(m.id)).toBe(false)
      } finally {
        await dispose()
      }
    })

    it('update mutates summary fields without touching the event log', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s7')
        const log = oneTurnLog()
        await persistence.create(m)
        await persistence.append(m.id, log)
        await persistence.update(m.id, { title: 'My session', firstPrompt: 'hi' })

        const loaded = await persistence.load(m.id)
        expect(loaded.meta.title).toBe('My session')
        expect(loaded.meta.firstPrompt).toBe('hi')
        expect(loaded.events).toEqual(log) // log untouched
      } finally {
        await dispose()
      }
    })
  })
}
