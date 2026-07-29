/**
 * Tests for the cross-process live-session registry: records survive a
 * round-trip, dead pids are pruned, a recycled pid cannot resurrect a foreign
 * record, the file format rejects foreign and torn media without hiding live
 * sessions, disposal deregisters, and concurrent registrations from independent
 * processes all survive (the failure the advisory lock exists to prevent).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BootId } from '@deepseek-ai/dsh-session-registry'
import SessionRegistryFile, {
  REGISTRY_FILE_NAME,
  SESSION_REGISTRY_FORMAT_VERSION,
  isPidAlive,
  parseRegistry,
  serializeRegistry,
} from '@deepseek-ai/dsh-session-registry-file'

const run = promisify(execFile)

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-session-registry-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Mount the service on a fresh Cordis fiber, returning it with its context. */
async function service(): Promise<{ ctx: Context; registry: SessionRegistryFile }> {
  const ctx = new Context()
  await ctx.plugin(SessionRegistryFile, { root })
  return { ctx, registry: ctx.sessionRegistry as SessionRegistryFile }
}

const file = (): string => join(root, REGISTRY_FILE_NAME)

describe('config resolution', () => {
  it('applies the shipped lock defaults when a caller omits them', async () => {
    // `ctx.plugin` runs the schema, which fills these in, so the constructor's
    // own resolution is reachable only by constructing the service directly —
    // the path a programmatic embedder takes.
    const ctx = new Context()
    const service = new SessionRegistryFile(ctx, { root })
    await service.register({ sessionId: SessionId('defaulted'), cwd: '/w' })
    expect((await service.list()).map(record => record.sessionId)).toEqual(['defaulted'])
    await ctx.fiber.dispose()
  })

  it('honors explicitly configured lock tunables', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionRegistryFile, { root, lockStaleMs: 5_000, lockRetries: 3 })
    await ctx.sessionRegistry.register({ sessionId: SessionId('tuned'), cwd: '/w' })
    expect((await ctx.sessionRegistry.list()).map(record => record.sessionId)).toEqual(['tuned'])
    await ctx.fiber.dispose()
  })
})

describe('register and list', () => {
  it('publishes a record readable by an independent service instance', async () => {
    const first = await service()
    await first.registry.register({ sessionId: SessionId('sess-1'), cwd: '/tmp/project' })

    // A second instance stands in for another process reading the same file.
    const reader = await service()
    const listed = await reader.registry.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      sessionId: 'sess-1',
      cwd: '/tmp/project',
      pid: process.pid,
    })
    await first.ctx.fiber.dispose()
    await reader.ctx.fiber.dispose()
  })

  it('replaces an earlier record for the same session id', async () => {
    const { ctx, registry } = await service()
    await registry.register({ sessionId: SessionId('sess-1'), cwd: '/a' })
    await registry.register({ sessionId: SessionId('sess-1'), cwd: '/b' })
    const listed = await registry.list()
    expect(listed).toHaveLength(1)
    // The later registration wins: `cwd` distinguishes the two calls.
    expect(listed[0]?.cwd).toBe('/b')
    await ctx.fiber.dispose()
  })

  it('creates the registry root private and the file owner-only', async () => {
    const { ctx, registry } = await service()
    await registry.register({ sessionId: SessionId('sess-1'), cwd: '/a' })
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    await ctx.fiber.dispose()
  })
})

describe('liveness pruning', () => {
  it('drops a record whose process is gone', async () => {
    const { ctx, registry } = await service()
    await registry.register({ sessionId: SessionId('live'), cwd: '/a' })

    // A real exited pid: spawn a process, wait for it, then claim its id. The
    // kernel has reaped it, so signal 0 reports ESRCH.
    const dead = await run(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
    const deadPid = Number(dead.stdout)
    expect(isPidAlive(deadPid)).toBe(false)
    const stored = parseRegistry(readFileSync(file(), 'utf8')).records
    writeFileSync(file(), serializeRegistry([
      ...stored,
      { sessionId: SessionId('ghost'), pid: deadPid, cwd: '/b', startedAt: 1, bootId: BootId('boot-x') },
    ]))

    const listed = await registry.list()
    expect(listed.map(record => record.sessionId)).toEqual(['live'])
    // The prune is durable, not just filtered in memory.
    expect(parseRegistry(readFileSync(file(), 'utf8')).records.map(r => r.sessionId)).toEqual(['live'])
    await ctx.fiber.dispose()
  })

  it('keeps a live record owned by another user (EPERM means alive)', () => {
    const eperm = (): never => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }
    expect(isPidAlive(1, eperm)).toBe(true)
  })

  it('propagates an unexpected errno instead of guessing liveness', () => {
    const einval = (): never => {
      const error = new Error('invalid') as NodeJS.ErrnoException
      error.code = 'EINVAL'
      throw error
    }
    expect(() => isPidAlive(1, einval)).toThrow('invalid')
  })
})

describe('pid recycling', () => {
  it('deregistration removes only this incarnation, not a namesake pid', async () => {
    const { ctx, registry } = await service()
    const disposer = await registry.register({ sessionId: SessionId('mine'), cwd: '/a' })

    // A foreign record reusing THIS live pid under a different session and boot
    // id: deregistering must not delete it.
    const stored = parseRegistry(readFileSync(file(), 'utf8')).records
    writeFileSync(file(), serializeRegistry([
      ...stored,
      { sessionId: SessionId('other'), pid: process.pid, cwd: '/b', startedAt: 2, bootId: BootId('boot-other') },
    ]))

    // Awaiting the disposer is the contract: the record is durably gone when it
    // settles, so the assertion needs no timing slack.
    await disposer()
    const listed = await registry.list()
    expect(listed.map(record => record.sessionId)).toEqual(['other'])
    await ctx.fiber.dispose()
  })
})

describe('file format', () => {
  it('round-trips records', () => {
    const records = [{
      sessionId: SessionId('s'), pid: 5 as const, cwd: '/c', startedAt: 7, bootId: BootId('b'),
    }]
    expect(parseRegistry(serializeRegistry(records))).toEqual({ records, intact: true })
  })

  it('stamps the format version', () => {
    const stamped = JSON.parse(serializeRegistry([])) as { version: number }
    expect(stamped.version).toBe(SESSION_REGISTRY_FORMAT_VERSION)
  })

  it.each([
    ['torn json', '{"version":0,"records":[{'],
    ['a foreign version', '{"version":99,"records":[]}'],
    ['a non-object root', '[]'],
    ['a null root', 'null'],
    ['a non-array records field', '{"version":0,"records":{}}'],
  ])('reads %s as an empty, non-intact registry', (_label, text) => {
    expect(parseRegistry(text)).toEqual({ records: [], intact: false })
  })

  it.each([
    ['a missing session id', { pid: 1, cwd: '/a', startedAt: 0, bootId: 'b' }],
    ['a non-integer pid', { sessionId: 's', pid: 1.5, cwd: '/a', startedAt: 0, bootId: 'b' }],
    ['a non-positive pid', { sessionId: 's', pid: 0, cwd: '/a', startedAt: 0, bootId: 'b' }],
    ['an empty cwd', { sessionId: 's', pid: 1, cwd: '', startedAt: 0, bootId: 'b' }],
    ['a negative startedAt', { sessionId: 's', pid: 1, cwd: '/a', startedAt: -1, bootId: 'b' }],
    ['a missing boot id', { sessionId: 's', pid: 1, cwd: '/a', startedAt: 0 }],
    ['a non-string title', { sessionId: 's', pid: 1, cwd: '/a', startedAt: 0, bootId: 'b', title: 7 }],
    ['a non-object row', 'nonsense'],
  ])('drops a row with %s but keeps its intact siblings', (_label, row) => {
    const good = { sessionId: 'keep', pid: 1, cwd: '/a', startedAt: 0, bootId: 'b' }
    const text = JSON.stringify({ version: SESSION_REGISTRY_FORMAT_VERSION, records: [row, good] })
    const parsed = parseRegistry(text)
    expect(parsed.records.map(record => record.sessionId)).toEqual(['keep'])
    expect(parsed.intact).toBe(false)
  })

  it('heals a damaged medium on the next locked write', async () => {
    writeFileSync(file(), 'not json at all')
    const { ctx, registry } = await service()
    await registry.list()
    expect(parseRegistry(readFileSync(file(), 'utf8')).intact).toBe(true)
    await ctx.fiber.dispose()
  })

  it('reads a missing file as no live sessions', async () => {
    const { ctx, registry } = await service()
    rmSync(file(), { force: true })
    expect(await registry.list()).toEqual([])
    await ctx.fiber.dispose()
  })

})

describe('failure reporting', () => {
  it('tolerates a registry file another process created first', async () => {
    // Two services racing `ensureFile`: the loser sees EEXIST, which is the
    // intended outcome rather than an error, and both still publish.
    const first = await service()
    const second = await service()
    await Promise.all([
      first.registry.register({ sessionId: SessionId('a'), cwd: '/a' }),
      second.registry.register({ sessionId: SessionId('b'), cwd: '/b' }),
    ])
    expect((await first.registry.list()).map(record => record.sessionId).sort()).toEqual(['a', 'b'])
    await first.ctx.fiber.dispose()
    await second.ctx.fiber.dispose()
  })

  it('warns instead of throwing when deregistration fails during teardown', async () => {
    const { ctx, registry } = await service()
    await registry.register({ sessionId: SessionId('doomed'), cwd: '/w' })
    // Make the registry path unusable, so the disposer's own write fails while the
    // fiber is already unwinding. Teardown must still complete.
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, REGISTRY_FILE_NAME), { recursive: true })
    await expect(ctx.fiber.dispose()).resolves.not.toThrow()
  })

  it('propagates a read failure that is not a missing file', async () => {
    const { ctx, registry } = await service()
    await registry.register({ sessionId: SessionId('sess-1'), cwd: '/w' })
    // A directory where the file belongs makes the read fail with EISDIR, which
    // is corruption rather than "no live sessions" and must not read as empty.
    rmSync(file(), { force: true })
    mkdirSync(file(), { recursive: true })
    await expect(registry.list()).rejects.toThrow()
    rmSync(file(), { recursive: true, force: true })
    await ctx.fiber.dispose()
  })
})

describe('retitle', () => {
  it('replaces the recorded title of a session this process owns', async () => {
    const { ctx, registry } = await service()
    await registry.register({ sessionId: SessionId('sess-1'), cwd: '/a' })
    expect((await registry.list())[0]?.title).toBeUndefined()

    await registry.retitle(SessionId('sess-1'), 'first')
    expect((await registry.list())[0]?.title).toBe('first')
    await registry.retitle(SessionId('sess-1'), 'second')
    expect((await registry.list())[0]?.title).toBe('second')
    await ctx.fiber.dispose()
  })

  it('accepts a registration that already carries a title', async () => {
    const { ctx, registry } = await service()
    await registry.register({ sessionId: SessionId('sess-1'), cwd: '/a', title: 'preset' })
    expect((await registry.list())[0]?.title).toBe('preset')
    await ctx.fiber.dispose()
  })

  it('leaves a same-id record owned by another incarnation untouched', async () => {
    const { ctx, registry } = await service()
    // Same live pid, different boot id: another incarnation's record must not be
    // retitled by this one.
    writeFileSync(file(), serializeRegistry([
      { sessionId: SessionId('foreign'), pid: process.pid, cwd: '/b', startedAt: 2, bootId: BootId('boot-other') },
    ]))
    await registry.retitle(SessionId('foreign'), 'not mine')
    expect((await registry.list())[0]?.title).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('ignores an unknown session id, since a title can resolve after removal', async () => {
    const { ctx, registry } = await service()
    await expect(registry.retitle(SessionId('never-registered'), 'ghost')).resolves.toBeUndefined()
    expect(await registry.list()).toEqual([])
    await ctx.fiber.dispose()
  })
})

describe('same-process concurrency', () => {
  it('keeps every record when one process registers several sessions at once', async () => {
    // The advisory lock is tracked per process, so same-process callers contend
    // for it through its bounded retry budget instead of queueing. Past a dozen
    // or so overlapping calls that budget runs out and a registration rejects —
    // and callers publish fire-and-forget, so the rejection is swallowed and the
    // session silently vanishes from the listing. The service therefore
    // serializes its own callers; the lock only excludes other processes.
    const { ctx, registry } = await service()
    // Register once first so the file and directory already exist: without that,
    // the concurrent calls serialize behind their own mkdir/create awaits and the
    // overlap under test never happens.
    await registry.register({ sessionId: SessionId('warm'), cwd: '/w' })
    const settled = await Promise.allSettled(Array.from({ length: 24 }, (_unused, index) =>
      registry.register({ sessionId: SessionId(`bulk-${String(index)}`), cwd: `/w/${String(index)}` })))

    // Every call must SUCCEED, not merely leave the file consistent. Callers
    // publish fire-and-forget, so a rejection is swallowed and the session
    // silently vanishes from the listing rather than failing loudly.
    expect(settled.filter(outcome => outcome.status === 'rejected')).toEqual([])
    const expected = [...Array.from({ length: 24 }, (_unused, index) => `bulk-${String(index)}`), 'warm'].sort()
    expect((await registry.list()).map(record => record.sessionId).sort()).toEqual(expected)
    await ctx.fiber.dispose()
  })

  it('keeps serving later callers after one cycle fails', async () => {
    const { ctx, registry } = await service()
    // A directory sitting where the registry file must be makes one cycle fail
    // without breaking the shared chain for the calls queued behind it.
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, REGISTRY_FILE_NAME), { recursive: true })
    await expect(registry.register({ sessionId: SessionId('doomed'), cwd: '/w' })).rejects.toThrow()

    rmSync(root, { recursive: true, force: true })
    await registry.register({ sessionId: SessionId('after'), cwd: '/w' })
    expect((await registry.list()).map(record => record.sessionId)).toEqual(['after'])
    await ctx.fiber.dispose()
  })
})

describe('cross-process concurrency', () => {
  it('keeps every record when independent processes register at once', async () => {
    // The regression that motivates the advisory lock: unlocked whole-file
    // republication loses records under concurrent writers. Real processes are
    // required — same-process promises would serialize on the event loop.
    const driver = fileURLToPath(new URL('./fixtures/register-once.ts', import.meta.url))
    const count = 8
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const tsx = join(repoRoot, 'node_modules/tsx/dist/loader.mjs')
    // Source plane: tsx resolves the workspace import through the root
    // tsconfig `paths` to `src`, so this runs without a build step.
    const env = { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json') }

    const children = Array.from({ length: count }, (_unused, index) =>
      spawn(process.execPath, ['--import', tsx, driver, root, `sess-${String(index)}`], {
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
      }))
    try {
      // Every child must have committed its record AND still be alive when the
      // file is read, so the assertion sees concurrent writes rather than prunes.
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => { resolve() })
        child.once('error', reject)
        child.once('exit', (code) => { reject(new Error(`driver exited early with ${String(code)}`)) })
      })))

      const stored = parseRegistry(readFileSync(file(), 'utf8'))
      expect(stored.intact).toBe(true)
      expect(stored.records.map(record => record.sessionId).sort()).toEqual(
        Array.from({ length: count }, (_unused, index) => `sess-${String(index)}`).sort(),
      )
    } finally {
      for (const child of children) child.stdin.end()
      await Promise.all(children.map(child => new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })))
    }
  }, 60_000)
})
