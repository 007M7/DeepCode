import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { z } from 'zod'
import { apply as applyStorage } from '@deepseek-ai/dsh-storage'
import { DomainFacility, defineDomain, domainTable } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { DomainChanged } from '../src/events.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const itemSchema = z.object({ label: z.string(), count: z.number().int() })
type Item = z.infer<typeof itemSchema>

const settingsSchema = z.object({ theme: z.string() })

const spec = defineDomain({
  name: 'demo',
  version: 1,
  global: { schema: settingsSchema, initial: { theme: 'plain' } },
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const bareSpec = defineDomain({
  name: 'bare',
  version: 1,
  tables: { rows: domainTable<string, Item>(itemSchema) },
})

/** Boot a context with the storage hub, one memory backend, and a facility over it. */
async function harness(options?: { pool?: MemoryMediaPool; config?: Partial<Config> }) {
  const ctx = new Context()
  await ctx.plugin({ apply: applyStorage })
  const backend = new MemoryStorageBackend(options?.pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {}, ...options?.config })
  // Mounted, not just constructed: the package invariant resolves the form
  // through ctx.storage to cross-check every domain/changed emission.
  ctx.storage.mount('domain', facility)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  return { ctx, backend, facility, changes }
}

describe('defineDomain', () => {
  it('rejects invalid names and versions loudly', () => {
    expect(() => defineDomain({ name: 'Bad-Name', version: 1, tables: {} })).toThrow(/must match/)
    expect(() => defineDomain({ name: 'ok', version: 1.5, tables: {} })).toThrow(/non-negative integer/)
    expect(() => defineDomain({
      name: 'ok', version: 1, tables: { 'Bad Table': domainTable<string, Item>(itemSchema) },
    })).toThrow(/table name/)
  })
})

describe('DomainFacility.open', () => {
  it('opens, reads back stored records, and rejects a second open of the same name', async () => {
    const { facility } = await harness()
    const domain = await facility.open(spec)
    await domain.table('items').put('a', { label: 'first', count: 1 })
    await expect(facility.open(spec)).rejects.toMatchObject({ name: 'DomainError', code: 'already-open' })
    expect(domain.table('items').get('a')).toEqual({ label: 'first', count: 1 })
  })

  it('routes per domain name and fails loud on an unregistered route target', async () => {
    const { facility } = await harness({ config: { routes: { demo: 'nonexistent' } } })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'backend-not-found',
    })
    // The failed open releases the name for a later attempt.
    const { facility: healthy } = await harness()
    await expect(healthy.open(spec)).resolves.toBeDefined()
  })

  it('rejects a backend without the kv facet', async () => {
    const { ctx, facility } = await harness({ config: { backend: 'nokv' } })
    ctx.storage.backend.register('nokv', { close: async () => {} })
    await expect(facility.open(spec)).rejects.toMatchObject({ code: 'facet-unsupported' })
  })

  it('rejects stored records that fail their schema, naming table and key', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      await (await facility.open(spec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    pool.media.get('demo')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
  })

  it('rejects a stored global that fails its schema with the global marker', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 1)
    pool.media.set('demo', { tables: new Map(), global: { theme: 42 } })
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: '', key: '' },
    })
  })

  it('passes through a backend version mismatch', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 7)
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
  })
})

describe('KvTable writes', () => {
  it('serializes concurrent updates on one key without losing increments', async () => {
    const { facility } = await harness()
    const table = (await facility.open(spec)).table('items')
    await table.put('counter', { label: 'c', count: 0 })
    await Promise.all(Array.from({ length: 50 }, () =>
      table.update('counter', (current) => ({ ...current, count: current.count + 1 }))))
    expect(table.get('counter')).toEqual({ label: 'c', count: 50 })
  })

  it('update rejects a missing key; delete reports prior existence', async () => {
    const { facility } = await harness()
    const table = (await facility.open(spec)).table('items')
    await expect(table.update('ghost', (v) => v)).rejects.toMatchObject({ code: 'missing-key' })
    await table.put('a', { label: 'x', count: 1 })
    await expect(table.delete('a')).resolves.toBe(true)
    await expect(table.delete('a')).resolves.toBe(false)
  })

  it('emits domain/changed per durable write, in order, with tombstones and global marker', async () => {
    const { facility, changes } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.update('a', (current) => ({ ...current, count: 2 }))
    await table.delete('a')
    await table.delete('a') // no event: already absent
    await domain.global.set({ theme: 'dark' })
    expect(changes).toEqual([
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 1 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 2 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'deleted' },
      { domain: 'demo', table: '', key: '', operation: 'put', value: { theme: 'dark' } },
    ])
  })
})

describe('global singleton', () => {
  it('serves initial before first set without materializing, then persists the first set', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      const domain = await facility.open(spec)
      expect(domain.global.get()).toEqual({ theme: 'plain' })
      expect(pool.media.get('demo')!.global).toBeNull() // initial never touches the medium
      await domain.global.set({ theme: 'dark' })
      expect(pool.media.get('demo')!.global).toEqual({ theme: 'dark' })
    }
    const { facility } = await harness({ pool })
    expect((await facility.open(spec)).global.get()).toEqual({ theme: 'dark' })
  })

  it('throws on access when the spec declares no global', async () => {
    const { facility } = await harness()
    const domain = await facility.open(bareSpec)
    expect(() => (domain as { global: unknown }).global).toThrow(/declares no global/)
  })
})

describe('disposal', () => {
  it('drains queued writes, closes the unit, then rejects reads and writes', async () => {
    const pool = new MemoryMediaPool()
    const { ctx, facility } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    const pending = Promise.all([
      table.put('a', { label: 'x', count: 1 }),
      table.put('b', { label: 'y', count: 2 }),
    ])
    await ctx.fiber.dispose() // effect disposer: drain chain, close unit
    await pending // queued before dispose → still landed
    // Durability is the drain contract: both queued writes reached the medium.
    expect([...pool.media.get('demo')!.tables.get('items')!.keys()].sort()).toEqual(['a', 'b'])
    await expect(table.put('c', { label: 'z', count: 3 })).rejects.toMatchObject({ code: 'closed' })
    expect(() => table.get('a')).toThrow(/closed/)
  })
})
