import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import { Config, SqliteStorageBackend, STORAGE_SQLITE_SCHEMA_VERSION } from '../src/index.ts'

/** Mirror the loader: resolve schemastery defaults before construction. */
function backendAt(path: string): SqliteStorageBackend {
  return new SqliteStorageBackend(new Config({ path }))
}

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-'))
  dirs.push(dir)
  return join(dir, 'storage.db')
}

// The contract suite's reopen() needs a surviving medium, so the harness binds
// a real file; :memory: gets its own cases below.
runKvBackendContract('sqlite', async () => {
  const path = await freshDbPath()
  return {
    backend: backendAt(path),
    reopen: async () => backendAt(path),
  }
})

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'specimen',
  version: 1,
  tables: ['records'],
  hasGlobal: true,
}

describe('sqlite backend specifics', () => {
  it('opens an in-memory database', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    expect((await unit.loadAll()).tables['records']).toEqual({ k: { n: 1 } })
    await backend.close()
  })

  it('materializes STRICT record tables and stamps the schema version', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    try {
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(version).toBe(STORAGE_SQLITE_SCHEMA_VERSION)
      const table = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'u_specimen_records'",
      ).get() as { sql: string } | undefined
      expect(table?.sql).toContain('STRICT')
      const unitRow = db.prepare('SELECT version FROM units WHERE name = ?').get('specimen') as { version: number }
      expect(unitRow.version).toBe(DESCRIPTOR.version)
    } finally {
      db.close()
    }
  })

  it('rejects a mismatched database schema version', async () => {
    const path = await freshDbPath()
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 999')
    db.close()

    const backend = backendAt(path)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
    await backend.close()
  })

  it('rejects invalid unit and table names before touching the medium', async () => {
    const backend = backendAt(':memory:')
    await expect(backend.kv.open({ ...DESCRIPTOR, name: 'Bad-Name' })).rejects.toThrow(/violates/)
    await expect(backend.kv.open({ ...DESCRIPTOR, tables: ['ok', '1bad'] })).rejects.toThrow(/violates/)
    await backend.close()
  })

  it('rejects a second open of the same unit name', async () => {
    const backend = backendAt(':memory:')
    await backend.kv.open(DESCRIPTOR)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/already open/)
    await backend.close()
  })

  it('allows re-open after unit close, and rejects open on a closed backend', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.close()
    const again = await backend.kv.open(DESCRIPTOR)
    await again.putRecord('records', 'k', 1)
    await backend.close()
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'closed' })
  })

  it('round-trips prototype-polluting keys as own properties', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', '__proto__', { evil: true })
    await unit.putRecord('records', 'constructor', { n: 1 })
    const { tables } = await unit.loadAll()
    const records = tables['records']!
    expect(Object.hasOwn(records, '__proto__')).toBe(true)
    expect(records['__proto__']).toEqual({ evil: true })
    expect(records['constructor']).toEqual({ n: 1 })
    expect(Object.getPrototypeOf({})).not.toHaveProperty('evil')
    await backend.close()
  })

  it('leaves a failed materialization unstamped so a repaired medium reopens', async () => {
    const path = await freshDbPath()
    // Obstruct table creation: an index squatting on the unit_globals name
    // makes CREATE TABLE IF NOT EXISTS throw AFTER the units table exists.
    const setup = new DatabaseSync(path)
    setup.exec('CREATE TABLE squatter (x TEXT)')
    setup.exec('CREATE INDEX unit_globals ON squatter(x)')
    setup.close()

    const broken = backendAt(path)
    await expect(broken.kv.open(DESCRIPTOR)).rejects.toThrow(/already an index/)
    await broken.close()

    // Clear the obstruction; the medium must still be version 0, not a
    // half-materialized database stamped as current.
    const repair = new DatabaseSync(path)
    expect((repair.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)
    repair.exec('DROP INDEX unit_globals')
    repair.close()

    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    await backend.close()
  })

  it('rejects unparsable stored JSON with malformed-medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'good', { n: 1 })
    await unit.setGlobal({ g: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    db.prepare('UPDATE u_specimen_records SET value = ? WHERE key = ?').run('{not json', 'good')
    db.close()

    const reopened = backendAt(path)
    const damaged = await reopened.kv.open(DESCRIPTOR)
    await expect(damaged.loadAll()).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await reopened.close()
  })

  it('rejects an unparsable global slot with malformed-medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.setGlobal({ g: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    db.prepare('UPDATE unit_globals SET value = ? WHERE unit = ?').run('][', 'specimen')
    db.close()

    const reopened = backendAt(path)
    const damaged = await reopened.kv.open(DESCRIPTOR)
    await expect(damaged.loadAll()).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await reopened.close()
  })
})
