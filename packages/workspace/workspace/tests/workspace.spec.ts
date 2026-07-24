import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from 'cordis'
import { apply as applyStorage } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/domain/tests/helpers/memory-backend.ts'
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
}) {
  const ctx = new Context()
  await ctx.plugin({ apply: applyStorage })
  ctx.storage.backend.register('memory', new MemoryStorageBackend(options?.pool))
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
    expect(registry.get(id)!.sessionIds).toEqual(['maybe'])
  })

  it('rejects startup over a medium accounting one session twice', async () => {
    const dir = await makeDir('double')
    const pool = pooledRecord('00000000-0000-4000-8000-000000000003', record(dir, ['dup']))
    pool.media.get('workspace')!.tables.get('workspaces')!
      .set('00000000-0000-4000-8000-000000000004', record(dir, ['dup']))
    const ctx = new Context()
    await ctx.plugin({ apply: applyStorage })
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    ctx.storage.mount('domain', new DomainFacility(ctx, { backend: 'memory', routes: {} }))
    await expect(Promise.resolve(ctx.plugin(WorkspaceRegistry))).rejects.toThrow(/accounted/)
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
  })
})
