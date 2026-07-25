import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from 'cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { WorkspaceEntity } from '../src/entity.ts'
import WorkspaceRegistry, { WorkspaceId, WorkspaceNameConflictError } from '../src/index.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from '../src/index.ts'

const DOMAIN_VERSION = 2

const header = (id: string, cwd?: string, createdAt = 0): SessionHeader => ({
  version: 0,
  id: SessionId(id),
  createdAt,
  ...(cwd === undefined ? {} : { cwd }),
})

interface HarnessOptions {
  pool?: MemoryMediaPool
  sessions?: SessionHeader[]
  liveSessions?: SessionHeader[]
  sessionStore?: boolean
  backend?: StorageBackend
}

/** Boot the real storage/domain/registry composition over controllable header-only peers. */
async function harness(options: HarnessOptions = {}) {
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  let listed = options.sessions ?? []
  const list = vi.fn(async () => listed)
  const load = vi.fn(() => { throw new Error('event bodies must not be loaded') })
  const inspect = vi.fn(() => { throw new Error('event bodies must not be inspected') })
  ctx.provide('sessionPersistence', { list, load, inspect } as never)

  if (options.sessionStore === true) {
    await ctx.plugin(SessionStore)
  } else if (options.liveSessions !== undefined) {
    const live = new Map(options.liveSessions.map(meta => [meta.id, { header: meta }]))
    ctx.provide('sessions', {
      get: (id: SessionId) => live.get(id),
      list: () => [...live.values()],
    } as never)
  }

  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  const fiber = await ctx.plugin(WorkspaceRegistry)
  const initChanges = [...changes]
  changes.length = 0
  return {
    ctx,
    fiber,
    pool,
    registry: ctx.workspace,
    changes,
    initChanges,
    list,
    load,
    inspect,
    setSessions: (headers: SessionHeader[]) => { listed = headers },
  }
}

/** Boot only the storage side, for dependency-pending and startup-failure cases. */
async function storageContext(pool: MemoryMediaPool, backend: StorageBackend = new MemoryStorageBackend(pool)) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  return ctx
}

/** Backend wrapper that injects one selected bootstrap write failure. */
function selectiveFailureBackend(
  pool: MemoryMediaPool,
  failure: { putAt?: number; deleteAt?: number; globalAt?: number },
): StorageBackend {
  const inner = new MemoryStorageBackend(pool)
  let puts = 0
  let deletes = 0
  let globals = 0
  return {
    kv: {
      open: async (descriptor) => {
        const unit = await inner.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            puts += 1
            if (puts === failure.putAt) throw new Error('selected bootstrap put failure')
            await unit.putRecord(table, key, value)
          },
          deleteRecord: async (table, key) => {
            deletes += 1
            if (deletes === failure.deleteAt) throw new Error('selected rollback delete failure')
            await unit.deleteRecord(table, key)
          },
          setGlobal: async (value) => {
            globals += 1
            if (globals === failure.globalAt) throw new Error('selected bootstrap marker failure')
            await unit.setGlobal(value)
          },
          close: () => unit.close(),
        }
      },
    },
    close: () => inner.close(),
  }
}

function record(path: string, sessionIds: string[], createdAt = '2026-07-24T00:00:00.000Z'): WorkspaceRecord {
  return {
    path,
    title: basename(path),
    sessionIds: sessionIds.map(SessionId),
    createdAt,
    updatedAt: createdAt,
  }
}

function storedPool(
  entries: Array<[string, WorkspaceRecord]>,
  state: WorkspaceDomainState,
): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('workspace', DOMAIN_VERSION)
  pool.media.set('workspace', {
    tables: new Map([['workspaces', new Map<string, unknown>(entries)]]),
    global: state,
  })
  return pool
}

function storedRecord(pool: MemoryMediaPool, id: string): WorkspaceRecord {
  return pool.media.get('workspace')!.tables.get('workspaces')!.get(id) as WorkspaceRecord
}

function storedState(pool: MemoryMediaPool): WorkspaceDomainState {
  return pool.media.get('workspace')!.global as WorkspaceDomainState
}

let base: string
const tempDirs: string[] = []

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

describe('WorkspaceRegistry lifecycle and bootstrap', () => {
  it('stays pending without sessionPersistence and never opens or marks the domain', async () => {
    const pool = new MemoryMediaPool()
    const ctx = await storageContext(pool)
    const fiber = await ctx.plugin(WorkspaceRegistry)
    expect(ctx.get('workspace')).toBeUndefined()
    expect(pool.media.has('workspace')).toBe(false)

    const list = vi.fn(async () => [] as SessionHeader[])
    ctx.provide('sessionPersistence', { list } as never)
    await fiber.await()
    expect(ctx.workspace.list()).toEqual([])
    expect(list).toHaveBeenCalledTimes(1)
    expect(storedState(pool)).toEqual({ initialized: true, workspaceIds: [] })
  })

  it('bootstraps once from list headers only, in workspace/session createdAt order', async () => {
    const older = await makeDir('older')
    const newer = await makeDir('newer')
    const alias = join(base, 'older-link')
    const plain = join(base, 'plain.txt')
    await symlink(older, alias)
    await writeFile(plain, 'not a directory')
    const missing = join(base, 'missing')
    const result = await harness({
      sessions: [
        header('older-first', older, 100),
        header('newer-only', newer, 500),
        header('older-latest', alias, 300),
        header('no-cwd', undefined, 900),
        header('missing-dir', missing, 800),
        header('plain-file', plain, 700),
      ],
    })

    expect(result.list).toHaveBeenCalledTimes(1)
    expect(result.load).not.toHaveBeenCalled()
    expect(result.inspect).not.toHaveBeenCalled()
    expect(result.registry.list().map(workspace => workspace.path)).toEqual([newer, older])
    expect(result.registry.list().map(workspace => workspace.sessionIds)).toEqual([
      ['newer-only'],
      ['older-latest', 'older-first'],
    ])
    expect(storedState(result.pool)).toEqual({
      initialized: true,
      workspaceIds: result.registry.list().map(workspace => workspace.id),
    })
  })

  it('breaks equal bootstrap timestamps by session id and canonical path', async () => {
    const first = await makeDir('tie-first')
    const second = await makeDir('tie-second')
    const result = await harness({
      sessions: [
        header('z-session', first, 100),
        header('a-session', first, 100),
        header('second-session', second, 100),
      ],
    })
    expect(new Set(result.registry.list().map(workspace => workspace.path))).toEqual(new Set([first, second]))
    expect(result.registry.list().find(workspace => workspace.path === first)!.sessionIds)
      .toEqual(['a-session', 'z-session'])
  })

  it('does not rerun bootstrap for a genuinely initialized empty registry', async () => {
    const late = await makeDir('late-cwd-only')
    const pool = new MemoryMediaPool()
    const first = await harness({ pool, sessions: [] })
    expect(first.list).toHaveBeenCalledTimes(1)
    await first.fiber.dispose()

    const second = await harness({ pool, sessions: [header('late', late, 100)] })
    expect(second.list).not.toHaveBeenCalled()
    expect(second.registry.list()).toEqual([])
    expect(storedState(pool)).toEqual({ initialized: true, workspaceIds: [] })
  })

  it('reuses partial records after a bootstrap record write fails', async () => {
    const firstDir = await makeDir('partial-first')
    const secondDir = await makeDir('partial-second')
    const sessions = [header('first', firstDir, 200), header('second', secondDir, 100)]
    const pool = new MemoryMediaPool()
    await expect(harness({
      pool,
      sessions,
      backend: selectiveFailureBackend(pool, { putAt: 2 }),
    })).rejects.toThrow(/selected bootstrap put failure/)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
    expect(pool.media.get('workspace')!.global).toBeNull()

    const retried = await harness({ pool, sessions })
    expect(retried.registry.list()).toHaveLength(2)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(2)
    expect(storedState(pool).initialized).toBe(true)
  })

  it('reuses durable order when the final initialized marker write fails', async () => {
    const dir = await makeDir('marker-retry')
    const sessions = [header('session', dir, 100)]
    const pool = new MemoryMediaPool()
    await expect(harness({
      pool,
      sessions,
      backend: selectiveFailureBackend(pool, { globalAt: 2 }),
    })).rejects.toThrow(/selected bootstrap marker failure/)
    expect(storedState(pool)).toMatchObject({ initialized: false })
    expect(storedState(pool).workspaceIds).toHaveLength(1)

    const retried = await harness({ pool, sessions })
    expect(retried.registry.list()).toHaveLength(1)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
    expect(storedState(pool).initialized).toBe(true)
  })

  it('merges partial records and leaves an already-accounted cwd drift ungrouped', async () => {
    const owned = await makeDir('partial-owned')
    const prior = await makeDir('partial-prior')
    const drifted = await makeDir('partial-drifted')
    const ownedId = WorkspaceId('00000000-0000-4000-8000-000000000010')
    const priorId = WorkspaceId('00000000-0000-4000-8000-000000000011')
    const pool = storedPool(
      [
        [ownedId, record(owned, ['old'], '2026-07-24T00:00:00.000Z')],
        [priorId, record(prior, ['drift'], '2026-07-23T00:00:00.000Z')],
      ],
      { initialized: false, workspaceIds: [] },
    )
    const result = await harness({
      pool,
      sessions: [header('new', owned, 200), header('old', owned, 100), header('drift', drifted, 300)],
    })
    expect(result.registry.list().map(workspace => workspace.id)).toContain(ownedId)
    expect(result.registry.get(ownedId)!.sessionIds).toEqual(['new', 'old'])
    expect(result.registry.list().some(workspace => workspace.path === drifted)).toBe(false)
  })

  it('orders headerless partial records by prior order, then stable id', async () => {
    const first = await makeDir('fallback-first')
    const second = await makeDir('fallback-second')
    const firstId = WorkspaceId('00000000-0000-4000-8000-000000000020')
    const secondId = WorkspaceId('00000000-0000-4000-8000-000000000021')
    const entries: Array<[string, WorkspaceRecord]> = [
      [secondId, record(second, [], '2026-07-24T00:00:00.000Z')],
      [firstId, record(first, [], '2026-07-24T00:00:00.000Z')],
    ]
    const prior = await harness({
      pool: storedPool(entries, { initialized: false, workspaceIds: [secondId, firstId] }),
    })
    expect(prior.registry.list().map(workspace => workspace.id)).toEqual([secondId, firstId])

    const byId = await harness({
      pool: storedPool(entries, { initialized: false, workspaceIds: [] }),
    })
    expect(byId.registry.list().map(workspace => workspace.id)).toEqual([firstId, secondId])
  })

  it('closes its domain on disposal and reloads the persisted stable order', async () => {
    const dir = await makeDir('replug')
    const result = await harness()
    const first = await result.registry.create(dir)
    await result.fiber.dispose()
    const nextFiber = await result.ctx.plugin(WorkspaceRegistry)
    expect(result.ctx.workspace.list().map(workspace => workspace.id)).toEqual([first.id])
    await nextFiber.dispose()
  })
})

describe('WorkspaceRegistry create and lookup', () => {
  it('creates newest-first and idempotently reuses a canonical path without retitling', async () => {
    const firstDir = await makeDir('first')
    const secondDir = await makeDir('second')
    const alias = join(base, 'first-link')
    await symlink(firstDir, alias)
    const { registry, pool } = await harness()
    const first = await registry.create(firstDir, 'Original')
    const second = await registry.create(secondDir)
    const reused = await registry.create(alias, 'Ignored')
    expect(reused).toBe(first)
    expect(first.title).toBe('Original')
    expect(registry.list()).toEqual([second, first])
    expect(storedState(pool).workspaceIds).toEqual([second.id, first.id])
    expect(await registry.resolveByPath(alias)).toBe(first)
    expect(await registry.resolveByPath(await makeDir('unowned'))).toBeUndefined()
  })

  it('serializes concurrent same-path creates into one entity', async () => {
    const dir = await makeDir('concurrent')
    const { registry, pool } = await harness()
    const [left, right] = await Promise.all([
      registry.create(dir, 'Winner'),
      registry.create(dir, 'Loser'),
    ])
    expect(left).toBe(right)
    expect(registry.list()).toEqual([left])
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
  })

  it('rejects a duplicate display name on a different canonical path', async () => {
    const firstDir = await makeDir('named-first')
    const secondDir = await makeDir('named-second')
    const { registry } = await harness()
    await registry.create(firstDir, 'Shared')
    await expect(registry.create(secondDir, 'Shared')).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceNameConflictError>>({
        workspaceName: 'Shared',
      }),
    )
    expect(registry.list()).toHaveLength(1)
  })

  it('rejects nonexistent and non-directory paths without changing order', async () => {
    const parent = await makeDir('invalid')
    const file = join(parent, 'plain.txt')
    await writeFile(file, 'file')
    const { registry } = await harness()
    await expect(registry.create(join(parent, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(registry.create(file)).rejects.toThrow(/not a directory/)
    await expect(registry.resolveByPath(join(parent, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(registry.list()).toEqual([])
  })

  it('rolls back the provisional cache when the record write fails', async () => {
    const dir = await makeDir('write-failure')
    const result = await harness()
    result.pool.failNextWrites = 1
    await expect(result.registry.create(dir)).rejects.toThrow(/injected/)
    expect(result.registry.list()).toEqual([])
    expect(await result.registry.create(dir)).toBeDefined()
  })

  it('rolls back a record when registry-order persistence fails', async () => {
    const dir = await makeDir('order-write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 2 }),
    })
    await expect(result.registry.create(dir)).rejects.toThrow(/marker failure/)
    expect(result.registry.list()).toEqual([])
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(0)
  })

  it('reports both order and rollback failures while retaining the recoverable record', async () => {
    const dir = await makeDir('rollback-write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 2, deleteAt: 1 }),
    })
    await expect(result.registry.create(dir)).rejects.toBeInstanceOf(AggregateError)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
  })

  it('rejects table access before the registry has started', async () => {
    const dir = await makeDir('unstarted')
    const registry = new WorkspaceRegistry(new Context())
    await expect(registry.create(dir)).rejects.toThrow(/not started/)
    expect(() => registry.list()).toThrow(/not started/)
  })
})

describe('Workspace session ordering', () => {
  it('prepends new attaches, keeps repeat attach idempotent, and touches one id only', async () => {
    const dir = await makeDir('attach-order')
    const result = await harness()
    result.setSessions([
      header('s1', dir, 1),
      header('s2', dir, 2),
      header('ungrouped', dir, 3),
    ])
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    expect(workspace.sessionIds).toEqual(['s2', 's1'])
    await workspace.attachSession(SessionId('s1'))
    expect(workspace.sessionIds).toEqual(['s2', 's1'])

    const beforeTouch = result.changes.length
    await Promise.all([
      result.registry.touchSession(SessionId('s1')),
      result.registry.touchSession(SessionId('s1')),
    ])
    expect(workspace.sessionIds).toEqual(['s1', 's2'])
    expect(result.changes).toHaveLength(beforeTouch + 1)
    await result.registry.touchSession(SessionId('s1'))
    expect(result.changes).toHaveLength(beforeTouch + 1)
    await result.registry.touchSession(SessionId('ungrouped'))
    expect(result.changes).toHaveLength(beforeTouch + 1)
    expect(storedRecord(result.pool, workspace.id).sessionIds).toEqual(['s1', 's2'])
  })

  it('does not resurrect a session detached before its queued touch', async () => {
    const dir = await makeDir('detach-touch-race')
    const result = await harness({ sessions: [header('s1', dir), header('s2', dir)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    await Promise.all([
      workspace.detachSession(SessionId('s1')),
      result.registry.touchSession(SessionId('s1')),
    ])
    const written = result.changes.length
    await workspace.detachSession(SessionId('absent'))
    expect(result.changes).toHaveLength(written)
    expect(workspace.sessionIds).toEqual(['s2'])
  })

  it('does not reinsert a candidate absent at the durable touch slot', async () => {
    const dir = await makeDir('stale-touch')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000030')
    let durable = record(dir, ['s2', 's1'])
    const table = {
      update: async (
        _id: WorkspaceId,
        update: (current: WorkspaceRecord) => WorkspaceRecord,
      ): Promise<WorkspaceRecord> => {
        durable = { ...durable, sessionIds: [SessionId('s2')] }
        durable = update(durable)
        return durable
      },
    }
    const entity = new WorkspaceEntity({
      table: () => table as never,
      sessionPath: () => dir,
      readSessionHeader: async () => header('s1', dir),
      rememberSessionPath: () => {},
    }, id, record(dir, ['s2', 's1']))
    await entity.touchSession(SessionId('s1'))
    expect(durable.sessionIds).toEqual(['s2'])
  })

  it('validates a lazy live session without requiring it in persistence.list()', async () => {
    const dir = await makeDir('live')
    const result = await harness({ sessions: [], liveSessions: [header('live', dir, 1)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('live'))
    expect(workspace.sessionIds).toEqual(['live'])
    expect(result.list).toHaveBeenCalledTimes(1)
  })

  it('rejects mismatched, missing, unresolved, non-directory, and unknown cwd facts', async () => {
    const dir = await makeDir('strict')
    const elsewhere = await makeDir('elsewhere')
    const gone = await makeDir('gone')
    const file = join(base, 'cwd-file')
    await writeFile(file, 'file')
    const result = await harness()
    result.setSessions([
      header('mismatch', elsewhere),
      header('no-cwd'),
      header('gone', gone),
      header('file', file),
    ])
    await rm(gone, { recursive: true })
    const workspace = await result.registry.create(dir)
    await expect(workspace.attachSession(SessionId('mismatch'))).rejects.toThrow(/resolves to/)
    await expect(workspace.attachSession(SessionId('no-cwd'))).rejects.toThrow(/no cwd/)
    await expect(workspace.attachSession(SessionId('gone'))).rejects.toThrow(/does not resolve/)
    await expect(workspace.attachSession(SessionId('file'))).rejects.toThrow(/not a directory/)
    await expect(workspace.attachSession(SessionId('unknown'))).rejects.toThrow(/no such session/)
    expect(workspace.sessionIds).toEqual([])
  })

  it('decides detach/attach membership at domain write-chain slots', async () => {
    const dir = await makeDir('race')
    const result = await harness({ sessions: [header('s1', dir)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    const detached = workspace.detachSession(SessionId('s1'))
    const attached = workspace.attachSession(SessionId('s1'))
    await Promise.all([detached, attached])
    expect(workspace.sessionIds).toEqual(['s1'])
  })

  it('keeps workspace order stable while touch order survives reload', async () => {
    const older = await makeDir('stable-older')
    const newer = await makeDir('stable-newer')
    const sessions = [
      header('old-1', older, 100),
      header('old-2', older, 200),
      header('new-1', newer, 300),
    ]
    const pool = new MemoryMediaPool()
    const first = await harness({ pool, sessions })
    const originalWorkspaceIds = first.registry.list().map(workspace => workspace.id)
    const oldWorkspace = first.registry.list().find(workspace => workspace.path === older)!
    expect(oldWorkspace.sessionIds).toEqual(['old-2', 'old-1'])
    await first.registry.touchSession(SessionId('old-1'))
    expect(oldWorkspace.sessionIds).toEqual(['old-1', 'old-2'])
    expect(first.registry.list().map(workspace => workspace.id)).toEqual(originalWorkspaceIds)
    await first.fiber.dispose()

    const reloaded = await harness({ pool, sessions })
    expect(reloaded.registry.list().map(workspace => workspace.id)).toEqual(originalWorkspaceIds)
    expect(reloaded.registry.list().find(workspace => workspace.path === older)!.sessionIds)
      .toEqual(['old-1', 'old-2'])
  })

  it('persists activity order from session/event without any stream consumer', async () => {
    const dir = await makeDir('event-touch')
    const result = await harness({ sessionStore: true })
    const workspace = await result.registry.create(dir)
    const first = result.ctx.sessions.create(SessionId('event-first'), { meta: { cwd: dir } })
    result.ctx.sessions.create(SessionId('event-second'), { meta: { cwd: dir } })
    await workspace.attachSession(SessionId('event-first'))
    await workspace.attachSession(SessionId('event-second'))
    expect(workspace.sessionIds).toEqual(['event-second', 'event-first'])

    first.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    await vi.waitFor(() => { expect(workspace.sessionIds).toEqual(['event-first', 'event-second']) })
    expect(storedRecord(result.pool, workspace.id).sessionIds)
      .toEqual(['event-first', 'event-second'])
  })

  it('contains a background activity write failure at the service listener', async () => {
    const dir = await makeDir('event-touch-failure')
    const result = await harness({ sessionStore: true })
    const workspace = await result.registry.create(dir)
    const first = result.ctx.sessions.create(SessionId('failed-first'), { meta: { cwd: dir } })
    result.ctx.sessions.create(SessionId('failed-second'), { meta: { cwd: dir } })
    await workspace.attachSession(SessionId('failed-first'))
    await workspace.attachSession(SessionId('failed-second'))
    const warn = vi.spyOn(result.ctx.logger, 'warn')
    result.pool.failNextWrites = 1
    first.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('touch failed')) })
    expect(workspace.sessionIds).toEqual(['failed-second', 'failed-first'])
  })
})

describe('header-validated membership projection', () => {
  it('requires both candidate id and matching canonical cwd without re-reading on list()', async () => {
    const owned = await makeDir('owned')
    const elsewhere = await makeDir('projection-elsewhere')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000001')
    const pool = storedPool(
      [[id, record(owned, ['good', 'mismatch', 'missing'])]],
      { initialized: true, workspaceIds: [id] },
    )
    const result = await harness({
      pool,
      sessions: [
        header('good', owned),
        header('mismatch', elsewhere),
        header('cwd-only', owned),
      ],
    })
    const workspace = result.registry.list()[0]!
    expect(workspace.sessionIds).toEqual(['good'])
    expect(result.registry.list()[0]!.sessionIds).toEqual(['good'])
    expect(result.list).toHaveBeenCalledTimes(1)
    expect(storedRecord(pool, id).sessionIds).toEqual(['good', 'mismatch', 'missing'])

    await workspace.setTitle('pruned')
    expect(storedRecord(pool, id).sessionIds).toEqual(['good'])
    expect(workspace.sessionIds).not.toContain('cwd-only')
  })

  it('rejects duplicate candidate ownership, duplicate paths, and initialized order drift', async () => {
    const first = await makeDir('corrupt-first')
    const second = await makeDir('corrupt-second')
    const firstId = '00000000-0000-4000-8000-000000000002'
    const secondId = '00000000-0000-4000-8000-000000000003'
    const duplicateSession = storedPool(
      [[firstId, record(first, ['dup'])], [secondId, record(second, ['dup'])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId), WorkspaceId(secondId)] },
    )
    await expect(harness({ pool: duplicateSession })).rejects.toThrow(/accounted/)

    const duplicatePath = storedPool(
      [[firstId, record(first, [])], [secondId, record(first, [])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId), WorkspaceId(secondId)] },
    )
    await expect(harness({ pool: duplicatePath })).rejects.toThrow(/claimed/)

    const orphan = storedPool(
      [[firstId, record(first, [])], [secondId, record(second, [])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId)] },
    )
    await expect(harness({ pool: orphan })).rejects.toThrow(/absent from registry order/)

    const repeated = storedPool(
      [[firstId, record(first, [])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId), WorkspaceId(firstId)] },
    )
    await expect(harness({ pool: repeated })).rejects.toThrow(/repeats workspace/)

    const missing = storedPool(
      [],
      { initialized: true, workspaceIds: [WorkspaceId(firstId)] },
    )
    await expect(harness({ pool: missing })).rejects.toThrow(/references missing workspace/)
  })

  it('fails list if the durable order and entity cache are externally diverged', async () => {
    const dir = await makeDir('cache-diverged')
    const result = await harness()
    const workspace = await result.registry.create(dir)
    const internals = result.registry as unknown as { entities: Map<WorkspaceId, unknown> }
    internals.entities.delete(workspace.id)
    expect(() => result.registry.list()).toThrow(/references missing workspace/)
  })
})

describe('workspace mutation and status', () => {
  it('keeps createdAt stable, advances updatedAt, and preserves snapshot on write failure', async () => {
    const dir = await makeDir('timestamps')
    const result = await harness()
    const workspace = await result.registry.create(dir)
    const createdAt = workspace.createdAt
    expect(workspace.updatedAt).toBe(createdAt)
    await workspace.setTitle('kept')
    expect(workspace.createdAt).toBe(createdAt)
    expect(Date.parse(workspace.updatedAt)).toBeGreaterThanOrEqual(Date.parse(createdAt))
    result.pool.failNextWrites = 1
    await expect(workspace.setTitle('lost')).rejects.toThrow(/injected/)
    expect(workspace.title).toBe('kept')
  })

  it('reports directory disappearance without mutating the workspace', async () => {
    const dir = await makeDir('vanishing')
    const { registry } = await harness()
    const workspace = await registry.create(dir)
    expect(await workspace.status()).toBe('ok')
    await rm(dir, { recursive: true })
    expect(await workspace.status()).toBe('missing-dir')
    await writeFile(dir, 'now a file')
    expect(await workspace.status()).toBe('missing-dir')
    expect(registry.get(workspace.id)).toBe(workspace)
  })
})
