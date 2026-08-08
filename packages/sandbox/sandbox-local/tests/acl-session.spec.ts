/**
 * The windows-acl per-session grant: the DURABLE record (session-log event
 * fold/provision) plus the SERVER-LIFETIME ACE materialization
 * ({@link AclWriteGrant}), exercised through the REAL
 * LocalSandboxProvider.confine() with a real session store. The Win32 surface
 * is mocked at the package boundary (`@deepseek-ai/dsh-sandbox-windows-acl`),
 * so these assertions run in every CI lane that runs sandbox-local's suites;
 * the real-FFI grant behavior is pinned in @deepseek-ai/dsh-sandbox-windows-
 * acl's own tests on win32 hosts.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { sessionTempDir } from '../src/acl-session.ts'

/** Cross-file state shared with the vi.mock factory (hoisting contract). */
const mockState = vi.hoisted(() => ({
  grants: [] as Array<{ writeSid: string; added: string[]; disposed: boolean }>,
  addFailure: undefined as Error | undefined,
  disposeFailure: undefined as Error | undefined,
}))

vi.mock('@deepseek-ai/dsh-sandbox-windows-acl', () => {
  class MockAclWriteGrant {
    readonly writeSid: string
    readonly added: string[] = []
    disposed = false
    constructor(writeSid: string) {
      this.writeSid = writeSid
      mockState.grants.push(this)
    }
    static create(writeSid: string): MockAclWriteGrant {
      return new MockAclWriteGrant(writeSid)
    }
    add(path: string): void {
      if (mockState.addFailure !== undefined) throw mockState.addFailure
      this.added.push(path)
    }
    dispose(): void {
      if (mockState.disposeFailure !== undefined) throw mockState.disposeFailure
      this.disposed = true
    }
  }
  return { AclWriteGrant: MockAclWriteGrant, randomWriteSid: () => 'S-1-4-42-42' }
})

/** One provisioned record event, shaped like the live log's envelope. */
function recordEvent(record: { writeSid: string; workspace: string; tempDir: string }): SessionEvent {
  return { type: 'sandbox/acl-session', seq: 0, time: 0, data: record }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { platform: 'win32', windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'] }
  return { ctx, sandbox, fiber }
}

/** A workspace root the policy, the record, and the session cwd all share. */
function workspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-acl-session-ws-'))
}

describe('windows-acl per-session grant (LocalSandboxProvider)', () => {
  const scratch: string[] = []

  beforeEach(() => {
    mockState.grants = []
    mockState.addFailure = undefined
    mockState.disposeFailure = undefined
  })

  const cleanup = () => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  }

  it('workspace-write: first confine provisions the record, materializes the grant ONCE, and passes --write-sid + the private temp dir', async () => {
    try {
      const { ctx, sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const privateTemp = sessionTempDir('sess-1')
      scratch.push(privateTemp)
      const session = ctx.sessions.create(SessionId('sess-1'), { meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: 'sess-1' }

      const confined = sandbox.confine(['pwsh', '/Command', 'x'], policy)
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', privateTemp,
        '--mode', 'workspace-write',
        '--write-sid', 'S-1-4-42-42',
        '--',
        'pwsh', '/Command', 'x',
      ])
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]).toMatchObject({ writeSid: 'S-1-4-42-42', added: [ws, privateTemp], disposed: false })
      expect(existsSync(privateTemp)).toBe(true) // the private temp subdir was created
      expect(session.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(1)

      // Reuse: the SECOND confine is the map hit — no new grant, no new event.
      const second = sandbox.confine(['pwsh', '/Command', 'x'], policy)
      expect(second.argv).toEqual(confined.argv)
      expect(mockState.grants).toHaveLength(1)
      expect(session.events).toHaveLength(1)

      // Provider dispose revokes the standing grant.
      await fiber.dispose()
      expect(mockState.grants[0]!.disposed).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('read-only: the record still rides along (--write-sid, one event) but NOTHING is materialized and the ambient temp root is passed', async () => {
    try {
      const { ctx, sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const privateTemp = sessionTempDir('sess-ro')
      scratch.push(privateTemp)
      const session = ctx.sessions.create(SessionId('sess-ro'), { meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws, sessionId: 'sess-ro' }

      const confined = sandbox.confine(['true'], policy)
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tmpdir(), // NOT the private subdir: read-only grants nothing
        '--mode', 'read-only',
        '--write-sid', 'S-1-4-42-42',
        '--',
        'true',
      ])
      expect(mockState.grants).toHaveLength(0)
      expect(existsSync(privateTemp)).toBe(false) // no private temp dir under read-only
      expect(session.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('resume: a seeded record replays with the SAME SID and no second event is appended', async () => {
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const record = { writeSid: 'S-1-4-77-1', workspace: ws, tempDir: sessionTempDir('resumed') }
      scratch.push(record.tempDir)

      const first = await setup()
      const session = first.ctx.sessions.create(SessionId('resumed'), { seed: [recordEvent(record)], meta: { cwd: ws } })
      // The constructor appends the `session/end-seed` marker, so the log is
      // the seed plus that marker — exactly one acl record among them.
      expect(session.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(1)

      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: 'resumed' }
      const confined = first.sandbox.confine(['true'], policy)
      expect(confined.argv).toContain('S-1-4-77-1')
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]).toMatchObject({ writeSid: 'S-1-4-77-1', added: [ws, record.tempDir] })
      // Replay IS the state: the seeded record satisfies the fold, nothing appended.
      expect(session.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(1)
      expect(session.events).toHaveLength(2)
    } finally {
      cleanup()
    }
  })

  it('fails loud when the durable record\'s workspace does not match the resolved policy root', async () => {
    try {
      const { ctx, sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const mismatched = { writeSid: 'S-1-4-77-2', workspace: '/somewhere-else', tempDir: join(tmpdir(), 'dsh-x') }
      ctx.sessions.create(SessionId('stale'), { seed: [recordEvent(mismatched)], meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: 'stale' }
      expect(() => sandbox.confine(['true'], policy)).toThrow(/does not match the resolved policy root/)
      expect(mockState.grants).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  it('fails loud without the session store, and when the policy names a session the store does not hold', async () => {
    try {
      const bare = new Context()
      await bare.plugin(LocalSandboxProvider, {})
      const sandbox = bare.sandbox as LocalSandboxProvider
      sandbox.internals = { platform: 'win32', windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'] }
      const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws', sessionId: 'sess-none' }
      expect(() => sandbox.confine(['true'], policy)).toThrow(/requires the session store/)

      const { sandbox: withStore } = await setup()
      expect(() => withStore.confine(['true'], policy)).toThrow(/no such session/)
    } finally {
      cleanup()
    }
  })

  it('a grant failure mid-materialization revokes what was granted and rethrows (AggregateError when the cleanup also fails)', async () => {
    try {
      const { ctx, sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      ctx.sessions.create(SessionId('sess-add-fail'), { meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: 'sess-add-fail' }

      // add() throws on the FIRST path: the cleanup dispose() runs and the
      // original error propagates unchanged.
      mockState.addFailure = new Error('grant exploded')
      expect(() => sandbox.confine(['true'], policy)).toThrow('grant exploded')
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]!.disposed).toBe(true)

      // add() AND dispose() both throw: both surface as an AggregateError.
      mockState.grants = []
      mockState.addFailure = new Error('grant exploded again')
      mockState.disposeFailure = new Error('cleanup exploded')
      expect(() => sandbox.confine(['true'], policy)).toThrow(AggregateError)
    } finally {
      cleanup()
    }
  })

  it('agentless calls stay self-managed: no --write-sid, the ambient temp root, no session store involved', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/ws' }
      const confined = sandbox.confine(['pwsh', '/Command', 'x'], policy)
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', '/ws',
        '--temp', tmpdir(),
        '--mode', 'workspace-write',
        '--',
        'pwsh', '/Command', 'x',
      ])
      expect(mockState.grants).toHaveLength(0)
      // Disposing a provider with no grants is a no-op (the empty-map guard).
      await fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('a failing revoke at provider dispose is reported via ctx.logger.warn and never thrown into teardown', async () => {
    try {
      const { ctx, sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      ctx.sessions.create(SessionId('sess-dispose'), { meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: 'sess-dispose' }
      sandbox.confine(['true'], policy)
      expect(mockState.grants).toHaveLength(1)

      mockState.disposeFailure = new Error('revoke exploded')
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      await fiber.dispose()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup completed with 1 failure'))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'revoke exploded' }))
    } finally {
      cleanup()
    }
  })
})
