/**
 * Tests for the live-session publisher over the REAL session store, so
 * publication follows the store's actual lifecycle dispatch rather than a
 * hand-built event emitter: sessions created after mount are published,
 * disposal removes their records, a session without a workspace is skipped, and
 * logged title revisions are mirrored onto the record so a reader never parses a
 * backend's log format.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { type SessionRegistryRecord } from '@deepseek-ai/dsh-session-registry'
import SessionRegistryFile from '@deepseek-ai/dsh-session-registry-file'
import * as live from '@deepseek-ai/dsh-session-registry-live'
// Empty type import carries the `session/title` event into the session-event map.
import type {} from '@deepseek-ai/dsh-session-title'

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-registry-live-test-')) })
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Mount the real store plus the publisher. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionRegistryFile, { root, lockStaleMs: 10_000, lockRetries: 20 })
  await ctx.plugin(live)
  return ctx
}

/** Let the publisher's fire-and-forget registration reach durability. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 200) })

/** Read the registry through an independent service, as `dsh list-sessions` would. */
async function listExternally(): Promise<SessionRegistryRecord[]> {
  const reader = new Context()
  await reader.plugin(SessionRegistryFile, { root, lockStaleMs: 10_000, lockRetries: 20 })
  const records = await reader.sessionRegistry.list()
  await reader.fiber.dispose()
  return records
}

describe('publishing', () => {
  it('publishes sessions that already exist when the plugin mounts', async () => {
    // A composition may mount the publisher after sessions exist (a resumed
    // session, or plugin order), so mount-time adoption is its own path.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('preexisting'), { meta: { cwd: '/work/a' } })
    await ctx.plugin(SessionRegistryFile, { root, lockStaleMs: 10_000, lockRetries: 20 })
    await ctx.plugin(live)
    await settle()

    expect((await ctx.sessionRegistry.list()).map(record => record.sessionId)).toEqual(['preexisting'])
    await ctx.fiber.dispose()
  })

  it('publishes a session created after mount', async () => {
    const ctx = await mount()
    ctx.sessions.create(SessionId('later'), { meta: { cwd: '/work/b' } })
    await settle()

    const listed = await ctx.sessionRegistry.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ sessionId: 'later', cwd: '/work/b' })
    await ctx.fiber.dispose()
  })

  it('skips a session with no workspace, having nothing truthful to list', async () => {
    const ctx = await mount()
    ctx.sessions.create(SessionId('no-cwd'))
    await settle()
    expect(await ctx.sessionRegistry.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('has no title until one is logged', async () => {
    const ctx = await mount()
    ctx.sessions.create(SessionId('fresh'), { meta: { cwd: '/work/c' } })
    await settle()
    expect((await ctx.sessionRegistry.list())[0]?.title).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('mirrors the latest logged title onto the record', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('titled'), { meta: { cwd: '/work/d' } })
    await settle()

    session.append('session/title', { title: 'first guess', messageSeqs: [0], source: { kind: 'fallback' } })
    await settle()
    expect((await ctx.sessionRegistry.list())[0]?.title).toBe('first guess')

    // A revision replaces the previous value rather than accumulating.
    session.append('session/title', { title: 'better title', messageSeqs: [0], source: { kind: 'fallback' } })
    await settle()
    expect((await ctx.sessionRegistry.list())[0]?.title).toBe('better title')
    await ctx.fiber.dispose()
  })

  it('ignores session events other than a title revision', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('busy'), { meta: { cwd: '/work/z' } })
    await settle()
    const retitle = vi.spyOn(ctx.sessionRegistry, 'retitle')

    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    await settle()
    expect(retitle).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('retitles only the session that logged the event', async () => {
    const ctx = await mount()
    const first = ctx.sessions.create(SessionId('one'), { meta: { cwd: '/work/e' } })
    ctx.sessions.create(SessionId('two'), { meta: { cwd: '/work/f' } })
    await settle()

    first.append('session/title', { title: 'only mine', messageSeqs: [0], source: { kind: 'fallback' } })
    await settle()
    const byId = new Map((await ctx.sessionRegistry.list()).map(record => [record.sessionId, record.title]))
    expect(byId.get(SessionId('one'))).toBe('only mine')
    expect(byId.get(SessionId('two'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('publishes every concurrently created session', async () => {
    const ctx = await mount()
    for (let index = 0; index < 5; index += 1) {
      ctx.sessions.create(SessionId(`bulk-${String(index)}`), { meta: { cwd: `/work/bulk-${String(index)}` } })
    }
    await settle()
    expect((await ctx.sessionRegistry.list()).map(record => record.sessionId).sort())
      .toEqual(['bulk-0', 'bulk-1', 'bulk-2', 'bulk-3', 'bulk-4'])
    await ctx.fiber.dispose()
  })
})

describe('failure and race handling', () => {
  it('removes the record when a session is disposed mid-registration', async () => {
    // The tombstone path: the session ends before its registration resolves, so
    // the late disposer must be applied instead of stored for a dead session.
    const ctx = await mount()
    let owner: Context | undefined
    await ctx.plugin({
      inject: ['sessions'],
      apply: (child: Context) => {
        owner = child
        child.sessions.create(SessionId('raced'), { meta: { cwd: '/work/race' } })
      },
    })
    // No settle: dispose while `register` is still in flight.
    await owner?.fiber.dispose()
    await settle()
    expect(await ctx.sessionRegistry.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('warns and drops the record when publication fails', async () => {
    const ctx = await mount()
    ctx.sessionRegistry.register = () => Promise.reject(new Error('registry offline'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    ctx.sessions.create(SessionId('unpublishable'), { meta: { cwd: '/work/x' } })
    await settle()
    expect(warn.mock.calls.flat().join(' ')).toMatch(/failed to publish session/)
    await ctx.fiber.dispose()
  })

  it('warns when a title revision cannot be recorded', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('titled'), { meta: { cwd: '/work/y' } })
    await settle()

    ctx.sessionRegistry.retitle = () => Promise.reject(new Error('registry offline'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    session.append('session/title', { title: 'doomed', messageSeqs: [0], source: { kind: 'fallback' } })
    await settle()
    expect(warn.mock.calls.flat().join(' ')).toMatch(/failed to retitle/)
    await ctx.fiber.dispose()
  })
})

describe('disposal', () => {
  it('removes a record when its own session is disposed, keeping the others', async () => {
    const ctx = await mount()
    // A session belongs to the fiber that created it, so a child plugin fiber
    // gives one session an independent lifetime without disposing the services.
    let owner: Context | undefined
    await ctx.plugin({
      inject: ['sessions'],
      apply: (child: Context) => {
        owner = child
        child.sessions.create(SessionId('ephemeral'), { meta: { cwd: '/work/e' } })
      },
    })
    ctx.sessions.create(SessionId('durable'), { meta: { cwd: '/work/f' } })
    await settle()
    expect(await ctx.sessionRegistry.list()).toHaveLength(2)

    // Disposing only that fiber ends its session, which the publisher follows.
    await owner?.fiber.dispose()
    await settle()
    expect((await ctx.sessionRegistry.list()).map(record => record.sessionId)).toEqual(['durable'])
    await ctx.fiber.dispose()
  })

  it('leaves no record behind after the whole tree unloads', async () => {
    const ctx = await mount()
    ctx.sessions.create(SessionId('a'), { meta: { cwd: '/work/g' } })
    ctx.sessions.create(SessionId('b'), { meta: { cwd: '/work/h' } })
    await settle()
    expect(await ctx.sessionRegistry.list()).toHaveLength(2)

    await ctx.fiber.dispose()
    expect(await listExternally()).toEqual([])
  })
})
