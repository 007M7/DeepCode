/**
 * windows-acl per-session grant: the DURABLE record (log-event fold/provision
 * with ownership binding + tamper validation) plus the SERVER-LIFETIME ACE
 * materialization, through the REAL LocalSandboxProvider.confine() with a
 * real session store. Win32 surface mocked at the package boundary; the
 * real-FFI grant behavior lives in sandbox-windows-acl's win32 tests.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
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
function recordEvent(record: { writeSid: string; sessionId: SessionIdType; workspace: string; tempDir: string }): SessionEvent {
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

/** A well-shaped private temp path under the host temp root (never created). */
function shapedTempPath(): string {
  return join(tmpdir(), `dsh-${'ab'.repeat(8)}`)
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

  it('workspace-write: first confine provisions the record and materializes the grant ONCE (--write-sid + the private temp dir)', async () => {
    try {
      const { ctx, sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const session = ctx.sessions.create(SessionId('sess-1'), { meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-1') }

      const confined = sandbox.confine(['pwsh', '/Command', 'x'], policy)
      expect(confined.argv).toContain('--write-sid')
      expect(confined.argv).toContain('S-1-4-42-42')
      expect(confined.argv).toContain('workspace-write')
      expect(mockState.grants).toHaveLength(1)
      const tempDir = (session.events.at(-1)!.data as { tempDir: string }).tempDir
      scratch.push(tempDir)
      expect(mockState.grants[0]).toMatchObject({ writeSid: 'S-1-4-42-42', added: [ws, tempDir], disposed: false })
      expect(existsSync(tempDir)).toBe(true) // created exclusively
      expect(session.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(1)

      // Reuse: the second confine is the map hit.
      sandbox.confine(['pwsh', '/Command', 'x'], policy)
      expect(mockState.grants).toHaveLength(1)
      expect(session.events).toHaveLength(1)

      await fiber.dispose()
      expect(mockState.grants[0]!.disposed).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('mode switch: read-only materializes nothing, the upgrade materializes ONCE with the same SID, the downgrade keeps the standing grant', async () => {
    try {
      const { ctx, sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const session = ctx.sessions.create(SessionId('sess-switch'), { meta: { cwd: ws } })
      const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws, sessionId: SessionId('sess-switch') }
      const workspaceWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-switch') }

      // read-only first: record rides along, nothing materialized, ambient temp.
      const confinedRo = sandbox.confine(['true'], readOnly)
      expect(confinedRo.argv).toContain('--write-sid')
      expect(confinedRo.argv).toContain(tmpdir())
      expect(mockState.grants).toHaveLength(0)
      const record = session.events.filter(event => event.type === 'sandbox/acl-session')[0]!.data as { tempDir: string }
      scratch.push(record.tempDir)
      expect(existsSync(record.tempDir)).toBe(false)

      // Upgrade: first workspace-write materializes with the same SID.
      const upgraded = sandbox.confine(['true'], workspaceWrite)
      expect(upgraded.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', record.tempDir,
        '--mode', 'workspace-write',
        '--write-sid', 'S-1-4-42-42',
        '--',
        'true',
      ])
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]).toMatchObject({ writeSid: 'S-1-4-42-42', added: [ws, record.tempDir], disposed: false })
      expect(existsSync(record.tempDir)).toBe(true)

      // Reuse: map hit.
      sandbox.confine(['true'], workspaceWrite)
      expect(mockState.grants).toHaveLength(1)

      // Downgrade: standing grant KEPT (inert under read-only, free re-upgrade).
      sandbox.confine(['true'], readOnly)
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]!.disposed).toBe(false)
      expect(session.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('read-only: the record rides along (--write-sid, one event) but NOTHING is materialized and the ambient temp root is passed', async () => {
    try {
      const { ctx, sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const session = ctx.sessions.create(SessionId('sess-ro'), { meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws, sessionId: SessionId('sess-ro') }

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
      expect(session.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('resume: a seeded record replays with the SAME SID and no second event is appended', async () => {
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const tempDir = shapedTempPath()
      const record = { writeSid: 'S-1-4-77-1', sessionId: SessionId('resumed'), workspace: ws, tempDir }
      scratch.push(tempDir)

      const first = await setup()
      const session = first.ctx.sessions.create(SessionId('resumed'), { seed: [recordEvent(record)], meta: { cwd: ws } })
      expect(session.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(1)

      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('resumed') }
      const confined = first.sandbox.confine(['true'], policy)
      expect(confined.argv).toContain('S-1-4-77-1')
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]).toMatchObject({ writeSid: 'S-1-4-77-1', added: [ws, tempDir] })
      // Replay IS the state: nothing appended.
      expect(session.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(1)
      expect(session.events).toHaveLength(2)
    } finally {
      cleanup()
    }
  })

  it('fork: a child seeded with the PARENT\'s events ignores the parent record and provisions a fresh identity (sessionId binding)', async () => {
    try {
      const { ctx, sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const parentTemp = shapedTempPath()
      const parentRecord = { writeSid: 'S-1-4-77-9', sessionId: SessionId('parent'), workspace: ws, tempDir: parentTemp }
      scratch.push(parentTemp)
      // SessionStore.fork copies the parent's events verbatim — the child must NOT inherit the record.
      const child = ctx.sessions.create(SessionId('child'), { seed: [recordEvent(parentRecord)], meta: { cwd: ws } })

      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('child') }
      sandbox.confine(['true'], policy)
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]).toMatchObject({ writeSid: 'S-1-4-42-42' }) // fresh, NOT the parent's
      expect(child.events.filter(event => event.type === 'sandbox/acl-session')).toHaveLength(2) // parent's copied + child's fresh
    } finally {
      cleanup()
    }
  })

  it('fails loud on a matching-but-tampered record: non-orphan SID, foreign temp path, and non-string fields never materialize', async () => {
    try {
      const { ctx, sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)

      // writeSid = Everyone: would widen the grant to every token.
      const everyone = { writeSid: 'S-1-1-0', sessionId: SessionId('tampered-sid'), workspace: ws, tempDir: shapedTempPath() }
      ctx.sessions.create(SessionId('tampered-sid'), { seed: [recordEvent(everyone)], meta: { cwd: ws } })
      const sidPolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('tampered-sid') }
      expect(() => sandbox.confine(['true'], sidPolicy)).toThrow(/malformed write SID/)

      // tempDir outside the host temp root.
      const foreignTemp = { writeSid: 'S-1-4-42-7', sessionId: SessionId('tampered-temp'), workspace: ws, tempDir: '/attacker/path' }
      ctx.sessions.create(SessionId('tampered-temp'), { seed: [recordEvent(foreignTemp)], meta: { cwd: ws } })
      const tempPolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('tampered-temp') }
      expect(() => sandbox.confine(['true'], tempPolicy)).toThrow(/outside the host temp root/)

      // Non-string durable fields (a corrupted/tampered JSONL payload): the
      // typeof guards fail loud before any string operation runs.
      const cases: Array<{ id: string; record: Record<string, unknown>; expect: RegExp }> = [
        { id: 'tampered-type-sid', record: { writeSid: 42, sessionId: SessionId('tampered-type-sid'), workspace: ws, tempDir: shapedTempPath() }, expect: /malformed write SID/ },
        { id: 'tampered-type-ws-null', record: { writeSid: 'S-1-4-42-6', sessionId: SessionId('tampered-type-ws-null'), workspace: null, tempDir: shapedTempPath() }, expect: /empty workspace/ },
        { id: 'tampered-type-ws-empty', record: { writeSid: 'S-1-4-42-6', sessionId: SessionId('tampered-type-ws-empty'), workspace: '', tempDir: shapedTempPath() }, expect: /empty workspace/ },
        { id: 'tampered-type-temp', record: { writeSid: 'S-1-4-42-6', sessionId: SessionId('tampered-type-temp'), workspace: ws, tempDir: 123 }, expect: /outside the host temp root/ },
      ]
      for (const c of cases) {
        ctx.sessions.create(SessionId(c.id), { seed: [recordEvent(c.record as never)], meta: { cwd: ws } })
        const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId(c.id) }
        expect(() => sandbox.confine(['true'], policy), c.id).toThrow(c.expect)
      }
      expect(mockState.grants).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  it('creates the private temp dir EXCLUSIVELY: a pre-existing entry or a reparse point fails EEXIST, never receiving grants', async () => {
    try {
      const { ctx, sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)

      // Pre-existing entry: exclusive mkdir throws EEXIST instead of adopting it.
      const preexisting = shapedTempPath()
      mkdirSync(preexisting)
      scratch.push(preexisting)
      const preRecord = { writeSid: 'S-1-4-42-8', sessionId: SessionId('preexisting'), workspace: ws, tempDir: preexisting }
      ctx.sessions.create(SessionId('preexisting'), { seed: [recordEvent(preRecord)], meta: { cwd: ws } })
      const prePolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('preexisting') }
      expect(() => sandbox.confine(['true'], prePolicy)).toThrow(/EEXIST/)
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]!.disposed).toBe(true) // self-revoked

      // Reparse point: same EEXIST (exclusive mkdir never follows links).
      const target = mkdtempSync(join(tmpdir(), 'dsh-acl-junction-target-'))
      scratch.push(target)
      const linkPath = shapedTempPath().replace(/abab$/, 'cdcd') // distinct well-shaped name
      symlinkSync(target, linkPath)
      scratch.push(linkPath)
      const linkRecord = { writeSid: 'S-1-4-42-9', sessionId: SessionId('reparse'), workspace: ws, tempDir: linkPath }
      ctx.sessions.create(SessionId('reparse'), { seed: [recordEvent(linkRecord)], meta: { cwd: ws } })
      const linkPolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('reparse') }
      expect(() => sandbox.confine(['true'], linkPolicy)).toThrow(/EEXIST/)
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants[1]!.disposed).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('fails loud when the durable record\'s workspace does not match the resolved policy root', async () => {
    try {
      const { ctx, sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const mismatched = { writeSid: 'S-1-4-77-2', sessionId: SessionId('stale'), workspace: '/somewhere-else', tempDir: shapedTempPath() }
      ctx.sessions.create(SessionId('stale'), { seed: [recordEvent(mismatched)], meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('stale') }
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
      const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws', sessionId: SessionId('sess-none') }
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
      const session = ctx.sessions.create(SessionId('sess-add-fail'), { meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-add-fail') }

      // add() throws on the FIRST path: cleanup dispose() runs, original error propagates.
      mockState.addFailure = new Error('grant exploded')
      expect(() => sandbox.confine(['true'], policy)).toThrow('grant exploded')
      scratch.push((session.events.at(-1)!.data as { tempDir: string }).tempDir)
      expect(mockState.grants).toHaveLength(1)
      expect(mockState.grants[0]!.disposed).toBe(true)

      // add() AND dispose() both throw: AggregateError.
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
      const session = ctx.sessions.create(SessionId('sess-dispose'), { meta: { cwd: ws } })
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-dispose') }
      sandbox.confine(['true'], policy)
      scratch.push((session.events.at(-1)!.data as { tempDir: string }).tempDir)
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

  it('sessionTempDir names are random and well-shaped (unpredictable, never derivable from the session id)', () => {
    const a = basename(sessionTempDir())
    const b = basename(sessionTempDir())
    expect(a).not.toBe(b)
    expect(a).toMatch(/^dsh-[0-9a-f]{16}$/)
    expect(b).toMatch(/^dsh-[0-9a-f]{16}$/)
  })
})
