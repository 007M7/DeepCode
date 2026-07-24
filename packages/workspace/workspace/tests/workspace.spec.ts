import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from 'cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry, { WorkspaceId } from '../src/index.ts'
import type { WorkspaceRecord } from '../src/index.ts'

const header = (id: string, cwd?: string): SessionHeader =>
  ({ version: 0, id: SessionId(id), createdAt: 0, ...(cwd === undefined ? {} : { cwd }) })

/**
 * Boot storage hub + memory backend + domain form + the workspace registry.
 * `sessions: 'absent'` boots without a sessionPersistence service; otherwise
 * a stub serving exactly the given headers from `list()` is provided, and
 * `setSessions` swaps what it serves next.
 */
async function harness(options?: {
  pool?: MemoryMediaPool
  sessions?: SessionHeader[] | 'absent'
  backend?: StorageBackend
}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options?.backend ?? new MemoryStorageBackend(options?.pool))
  ctx.storage.mount('domain', new DomainFacility(ctx, { backend: 'memory', routes: {} }))
  let listed = options?.sessions === 'absent' ? undefined : options?.sessions ?? []
  if (listed !== undefined) {
    ctx.provide('sessionPersistence', { list: async () => listed ?? [] })
  }
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  await ctx.plugin(WorkspaceRegistry)
  return {
    ctx,
    registry: ctx.workspace,
    changes,
    setSessions: (headers: SessionHeader[]) => { listed = headers },
  }
}

/** A memory backend whose next `putRecord` throws once when armed, for write-failure paths. */
function failingBackend(): { backend: StorageBackend; arm: () => void } {
  const inner = new MemoryStorageBackend()
  let failNext = false
  return {
    arm: () => { failNext = true },
    backend: {
      kv: {
        open: async (descriptor) => {
          const unit = await inner.kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: async (table, key, value) => {
              if (failNext) {
                failNext = false
                throw new Error('medium write failed (injected)')
              }
              return unit.putRecord(table, key, value)
            },
            deleteRecord: (table, key) => unit.deleteRecord(table, key),
            setGlobal: value => unit.setGlobal(value),
            close: () => unit.close(),
          }
        },
      },
      close: () => inner.close(),
    },
  }
}

/** A pool pre-stamped with one stored workspace record, simulating a prior run. */
function pooledRecord(id: string, record: WorkspaceRecord): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('workspace', 1)
  pool.media.set('workspace', {
    tables: new Map([['workspaces', new Map<string, unknown>([[id, record]])]]),
    global: null,
  })
  return pool
}

const record = (path: string, sessionIds: string[]): WorkspaceRecord => ({
  path,
  title: basename(path),
  sessionIds: sessionIds.map(SessionId),
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
})

/** Stored record as the memory medium currently holds it. */
function storedRecord(pool: MemoryMediaPool, id: string): WorkspaceRecord {
  return pool.media.get('workspace')!.tables.get('workspaces')!.get(id) as WorkspaceRecord
}

let base: string
const tempDirs: string[] = []

/** A fresh real directory under a canonicalized temp base. */
async function makeDir(name: string): Promise<string> {
  base ??= await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-')))
  if (tempDirs.length === 0) tempDirs.push(base)
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  base = undefined as never
})

describe('WorkspaceRegistry.create', () => {
  it('stores the canonical path, defaults the title to basename, and lists the entity', async () => {
    const dir = await makeDir('proj')
    const { registry } = await harness()
    const workspace = await registry.create(dir + '/')
    expect(workspace.path).toBe(dir)
    expect(workspace.title).toBe('proj')
    expect(workspace.sessionIds).toEqual([])
    expect(registry.list()).toEqual([workspace])
    expect(registry.get(workspace.id)).toBe(workspace)
    const titled = await registry.create(await makeDir('other'), 'Custom')
    expect(titled.title).toBe('Custom')
  })

  it('rejects a nonexistent directory with the original ENOENT', async () => {
    const dir = await makeDir('exists')
    const { registry } = await harness()
    await expect(registry.create(join(dir, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(registry.list()).toEqual([])
  })

  it('rejects a path resolving to a plain file', async () => {
    const dir = await makeDir('has-file')
    const file = join(dir, 'plain.txt')
    await writeFile(file, 'not a directory')
    const { registry } = await harness()
    await expect(registry.create(file)).rejects.toThrow(/not a directory/)
    expect(registry.list()).toEqual([])
  })

  it('rejects a duplicate path, including a symlink resolving to an existing workspace', async () => {
    const dir = await makeDir('real')
    const link = join(base, 'link')
    await symlink(dir, link)
    const { registry } = await harness()
    await registry.create(dir)
    await expect(registry.create(link)).rejects.toThrow(/already exists/)
    expect(registry.list()).toHaveLength(1)
  })

  it('resolves by path through the same canon', async () => {
    const dir = await makeDir('canon')
    const link = join(base, 'canon-link')
    await symlink(dir, link)
    const { registry } = await harness()
    const workspace = await registry.create(dir)
    expect(await registry.resolveByPath(link)).toBe(workspace)
    expect(await registry.resolveByPath(await makeDir('unowned'))).toBeUndefined()
  })

  it('rolls the entity cache back when the durable write fails, leaving the path free to retry', async () => {
    const dir = await makeDir('rollback')
    const { backend, arm } = failingBackend()
    const { registry } = await harness({ backend })
    arm()
    await expect(registry.create(dir)).rejects.toThrow(/injected/)
    expect(registry.list()).toEqual([])
    const retried = await registry.create(dir)
    expect(retried.path).toBe(dir)
  })

  it('rejects any table access before the registry has started', async () => {
    const dir = await makeDir('unstarted')
    const ctx = new Context()
    // Constructed directly, Service.init never ran: no domain, no table.
    const registry = new WorkspaceRegistry(ctx)
    await expect(registry.create(dir)).rejects.toThrow(/not started/)
  })

  it('closes its domain on fiber disposal so a re-plugged registry reopens it', async () => {
    const dir = await makeDir('replug')
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    ctx.storage.mount('domain', new DomainFacility(ctx, { backend: 'memory', routes: {} }))
    const fiber = ctx.plugin(WorkspaceRegistry)
    await fiber
    const first = await ctx.workspace.create(dir)
    await fiber.dispose()
    // The registry's effect closed the domain, freeing the name: a second
    // plugin of the same registry must reopen it (not already-open) and see
    // the durable record.
    await ctx.plugin(WorkspaceRegistry)
    const reloaded = await ctx.workspace.resolveByPath(dir)
    expect(reloaded?.id).toBe(first.id)
  })
})

describe('Workspace.attachSession', () => {
  it('attaches when the session cwd resolves to the workspace path, keeping attach order', async () => {
    const dir = await makeDir('attach')
    const link = join(base, 'attach-link')
    await symlink(dir, link)
    // s2's cwd is spelled through the symlink: same canon, must attach.
    const { registry } = await harness({
      sessions: [header('s1', dir), header('s2', link), header('s3', dir)],
    })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    await workspace.attachSession(SessionId('s3'))
    expect(workspace.sessionIds).toEqual(['s1', 's2', 's3'])
    await workspace.detachSession(SessionId('s2'))
    expect(workspace.sessionIds).toEqual(['s1', 's3'])
  })

  it('rejects a cwd resolving elsewhere, a missing cwd, and an unknown session', async () => {
    const dir = await makeDir('strict')
    const elsewhere = await makeDir('elsewhere')
    const { registry } = await harness({
      sessions: [header('other-dir', elsewhere), header('no-cwd', undefined)],
    })
    const workspace = await registry.create(dir)
    await expect(workspace.attachSession(SessionId('other-dir'))).rejects.toThrow(/resolves to/)
    await expect(workspace.attachSession(SessionId('no-cwd'))).rejects.toThrow(/no cwd/)
    await expect(workspace.attachSession(SessionId('unknown'))).rejects.toThrow(/no such session/)
    expect(workspace.sessionIds).toEqual([])
  })

  it('rejects a cwd that no longer resolves', async () => {
    const dir = await makeDir('target')
    const gone = await makeDir('gone')
    const { registry } = await harness({ sessions: [header('s1', gone)] })
    const workspace = await registry.create(dir)
    await rm(gone, { recursive: true })
    await expect(workspace.attachSession(SessionId('s1'))).rejects.toThrow(/does not resolve/)
  })

  it('rejects every attach while session persistence is absent', async () => {
    const dir = await makeDir('no-persistence')
    const { registry } = await harness({ sessions: 'absent' })
    const workspace = await registry.create(dir)
    await expect(workspace.attachSession(SessionId('s1'))).rejects.toThrow(/no session persistence/)
  })

  it('is idempotent on both attach and detach — a no-op never writes', async () => {
    const dir = await makeDir('idem')
    const { registry, changes, setSessions } = await harness({ sessions: [header('s1', dir)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    const written = changes.length
    // Re-attaching skips validation entirely: even with the session gone from
    // the listing, the id already being on the account resolves without IO.
    setSessions([])
    await workspace.attachSession(SessionId('s1'))
    await workspace.detachSession(SessionId('absent'))
    expect(changes.length).toBe(written)
  })

  it('decides membership at the write-chain slot: unawaited detach then attach re-attaches', async () => {
    const dir = await makeDir('race')
    const { registry } = await harness({ sessions: [header('s1', dir)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    // Both fire before either lands. Snapshot-based idempotence would see
    // 's1' still on the account and turn the attach into a no-op, losing it;
    // chain-slot decisions replay detach → attach in order. (The attach skips
    // re-validation off the same stale snapshot — the cwd fact is immutable —
    // and enqueues immediately, keeping the chain order deterministic here.)
    const detached = workspace.detachSession(SessionId('s1'))
    const attached = workspace.attachSession(SessionId('s1'))
    await Promise.all([detached, attached])
    expect(workspace.sessionIds).toEqual(['s1'])
  })
})

describe('consistency projections', () => {
  it('filters accounted ids with no stored session and prunes them on the next mutation', async () => {
    const dir = await makeDir('stale')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000001')
    const pool = pooledRecord(id, record(dir, ['live', 'ghost']))
    const { registry } = await harness({ pool, sessions: [header('live', dir)] })
    const workspace = registry.get(id)!
    // Rule 1: the projection hides the dead id; the durable account still holds it.
    expect(workspace.sessionIds).toEqual(['live'])
    expect(storedRecord(pool, id).sessionIds).toEqual(['live', 'ghost'])
    // Any mutation prunes it durably.
    await workspace.setTitle('renamed')
    expect(storedRecord(pool, id).sessionIds).toEqual(['live'])
    expect(workspace.title).toBe('renamed')
  })

  it('serves the account unfiltered while session persistence is absent', async () => {
    const dir = await makeDir('unverifiable')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000002')
    const pool = pooledRecord(id, record(dir, ['maybe']))
    const { registry } = await harness({ pool, sessions: 'absent' })
    const workspace = registry.get(id)!
    expect(workspace.sessionIds).toEqual(['maybe'])
    // Mutations must not prune either: unverifiable membership is kept as-is.
    await workspace.setTitle('still-unverified')
    expect(storedRecord(pool, id).sessionIds).toEqual(['maybe'])
  })

  it('prunes dead ids even when the triggering mutation is itself a no-op', async () => {
    const dir = await makeDir('prune-on-noop')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000007')
    const pool = pooledRecord(id, record(dir, ['ghost']))
    const { registry, changes } = await harness({ pool, sessions: [] })
    const workspace = registry.get(id)!
    // Detaching an id that was never on the account changes nothing by
    // itself, but the mutation slot still prunes the dead 'ghost' durably.
    await workspace.detachSession(SessionId('never-there'))
    expect(storedRecord(pool, id).sessionIds).toEqual([])
    expect(changes).toHaveLength(1)
  })

  it('rejects startup over a medium accounting one session twice', async () => {
    const dirA = await makeDir('double-a')
    const dirB = await makeDir('double-b')
    const pool = pooledRecord('00000000-0000-4000-8000-000000000003', record(dirA, ['dup']))
    pool.media.get('workspace')!.tables.get('workspaces')!
      .set('00000000-0000-4000-8000-000000000004', record(dirB, ['dup']))
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    ctx.storage.mount('domain', new DomainFacility(ctx, { backend: 'memory', routes: {} }))
    await expect(Promise.resolve(ctx.plugin(WorkspaceRegistry))).rejects.toThrow(/accounted/)
  })

  it('rejects startup over a medium where two records claim one path', async () => {
    const dirA = await makeDir('claimed')
    const pool = pooledRecord('00000000-0000-4000-8000-000000000005', record(dirA, []))
    pool.media.get('workspace')!.tables.get('workspaces')!
      .set('00000000-0000-4000-8000-000000000006', record(dirA, []))
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    ctx.storage.mount('domain', new DomainFacility(ctx, { backend: 'memory', routes: {} }))
    await expect(Promise.resolve(ctx.plugin(WorkspaceRegistry))).rejects.toThrow(/claimed/)
  })
})

describe('Workspace mutation failures', () => {
  it('propagates a medium write failure from a mutation and keeps the old snapshot', async () => {
    const dir = await makeDir('write-fail')
    const { backend, arm } = failingBackend()
    const { registry } = await harness({ backend })
    const workspace = await registry.create(dir)
    arm()
    await expect(workspace.setTitle('lost')).rejects.toThrow(/injected/)
    expect(workspace.title).toBe('write-fail')
    await workspace.setTitle('kept')
    expect(workspace.title).toBe('kept')
  })
})

describe('Workspace.status', () => {
  it('reports ok while the directory exists and missing-dir once it is gone, without mutating the record', async () => {
    const dir = await makeDir('vanishing')
    const { registry } = await harness()
    const workspace = await registry.create(dir)
    expect(await workspace.status()).toBe('ok')
    await rm(dir, { recursive: true })
    expect(await workspace.status()).toBe('missing-dir')
    expect(workspace.path).toBe(dir)
    expect(registry.get(workspace.id)).toBe(workspace)
    // The path re-materializing as a non-directory is still missing-dir.
    await writeFile(dir, 'now a file')
    expect(await workspace.status()).toBe('missing-dir')
  })
})
