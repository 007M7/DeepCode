import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import { JsonStorageBackend } from '../src/index.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-json-'))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

runKvBackendContract('json', async () => {
  const root = await freshRoot()
  return {
    backend: new JsonStorageBackend(root),
    reopen: async () => new JsonStorageBackend(root),
  }
})

describe('json backend specifics', () => {
  const descriptor = { name: 'shape', version: 1, tables: ['t'], hasGlobal: true }

  it('publishes a human-readable pretty-printed file', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { hello: 'world' })
    const text = await readFile(join(root, 'shape.json'), 'utf8')
    expect(text).toBe(`${JSON.stringify(
      { unit: { name: 'shape', version: 1 }, global: null, tables: { t: { k: { hello: 'world' } } } },
      null,
      2,
    )}\n`)
    await backend.close()
  })

  it('defers materialization until the first write', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(readFile(join(root, 'shape.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await backend.close()
  })

  it('rejects a malformed medium', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), 'not json at all', 'utf8')
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects a foreign unit header', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'other', version: 1 }, global: null, tables: {} }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects double-open of one unit as a plain caller error', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(backend.kv.open(descriptor)).rejects.toThrowError(/already open/)
    await backend.close()
  })

  it('rolls back memory when a publish fails', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { v: 'committed' })
    // Make the next publish fail: replace the unit file's parent with an
    // unwritable directory path via chmod.
    const { chmod } = await import('node:fs/promises')
    await chmod(root, 0o500)
    await expect(unit.putRecord('t', 'k', { v: 'rejected' })).rejects.toThrow()
    await expect(unit.putRecord('t', 'k2', { v: 'also rejected' })).rejects.toThrow()
    await chmod(root, 0o700)
    const snapshot = await unit.loadAll()
    expect(snapshot.tables['t']).toEqual({ k: { v: 'committed' } })
    // The next successful publish must not carry rejected writes to disk.
    await unit.putRecord('t', 'k3', { v: 'later' })
    const text = await readFile(join(root, 'shape.json'), 'utf8')
    expect(text).not.toContain('rejected')
    await backend.close()
  })

  it('close drains in-flight writes and blocks in-flight opens', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const bigWrite = unit.putRecord('t', 'big', { blob: 'x'.repeat(4 * 1024 * 1024) })
    await unit.close()
    await expect(bigWrite).resolves.toBeUndefined()
    const onDisk = JSON.parse(await readFile(join(root, 'shape.json'), 'utf8'))
    expect(onDisk.tables.t.big).toBeDefined()

    const backend2 = new JsonStorageBackend(root)
    const opening = backend2.kv.open(descriptor)
    const closing = backend2.close()
    await expect(opening.then((u) => u.putRecord('t', 'x', {}))).rejects.toMatchObject({ code: 'closed' })
    await closing
  })
})
