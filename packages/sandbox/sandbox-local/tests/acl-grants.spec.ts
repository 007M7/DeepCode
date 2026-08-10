/**
 * windows-acl write grants: the SERVER-LIFETIME ACE materialization
 * (standing workspace grant per workspace, revocable private-temp grant per
 * session) plus the derived private-temp identity, through the REAL
 * LocalSandboxProvider.confine(). Win32 surface mocked at the package
 * boundary (the workspace-derived SID mocked to a constant); the real-FFI
 * grant behavior lives in sandbox-windows-acl's win32 tests.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LocalSandboxProvider, sessionTempDir } from '@deepseek-ai/dsh-sandbox-local'

/** Cross-file state shared with the vi.mock factory (hoisting contract). */
const mockState = vi.hoisted(() => ({
  grants: [] as Array<{ writeSid: string; added: Array<{ path: string; standing: boolean }>; disposed: boolean }>,
  addFailure: undefined as Error | undefined,
  /** Restricts {@link addFailure} to this path (undefined = every add throws). */
  addFailurePath: undefined as string | undefined,
  disposeFailure: undefined as Error | undefined,
}))

vi.mock('@deepseek-ai/dsh-sandbox-windows-acl', () => {
  class MockAclWriteGrant {
    readonly writeSid: string
    readonly added: Array<{ path: string; standing: boolean }> = []
    disposed = false
    constructor(writeSid: string) {
      this.writeSid = writeSid
      mockState.grants.push(this)
    }
    static create(writeSid: string): MockAclWriteGrant {
      return new MockAclWriteGrant(writeSid)
    }
    add(path: string, standing = false): void {
      if (mockState.addFailure !== undefined && (mockState.addFailurePath === undefined || mockState.addFailurePath === path)) {
        throw mockState.addFailure
      }
      this.added.push({ path, standing })
    }
    dispose(): void {
      if (mockState.disposeFailure !== undefined) throw mockState.disposeFailure
      this.disposed = true
    }
  }
  return { AclWriteGrant: MockAclWriteGrant, workspaceWriteSid: () => 'S-1-4-42-42' }
})

/** The workspace-derived write SID the mock pins for every workspace. */
const DERIVED_SID = 'S-1-4-42-42'

async function setup() {
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { platform: 'win32', windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'] }
  return { ctx, sandbox, fiber }
}

/** A workspace root the policy carries. */
function workspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-acl-grants-ws-'))
}

describe('windows-acl write grants (LocalSandboxProvider)', () => {
  const scratch: string[] = []

  beforeEach(() => {
    mockState.grants = []
    mockState.addFailure = undefined
    mockState.addFailurePath = undefined
    mockState.disposeFailure = undefined
  })

  const cleanup = () => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  }

  it('workspace-write: first confine materializes ONCE (standing workspace + revocable private temp), the derived temp dir rides the argv', async () => {
    try {
      const { sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const tempDir = sessionTempDir(SessionId('sess-1'), ws)
      scratch.push(tempDir)
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-1') }

      const confined = sandbox.confine(['pwsh', '/Command', 'x'], policy)
      expect(confined.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tempDir,
        '--mode', 'workspace-write',
        '--write-sid', DERIVED_SID,
        '--',
        'pwsh', '/Command', 'x',
      ])
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants[0]).toMatchObject({
        writeSid: DERIVED_SID,
        added: [{ path: ws, standing: true }], // standing: the reuse cache, never revoked
        disposed: false,
      })
      expect(mockState.grants[1]).toMatchObject({
        writeSid: DERIVED_SID,
        added: [{ path: tempDir, standing: false }],
        disposed: false,
      })
      expect(existsSync(tempDir)).toBe(true) // created exclusively

      // Reuse: the second confine is the map hits.
      sandbox.confine(['pwsh', '/Command', 'x'], policy)
      expect(mockState.grants).toHaveLength(2)

      await fiber.dispose()
      // dispose() runs on BOTH grants: the standing workspace ACE is left in
      // place (the mock marks it disposed only as instance teardown).
      expect(mockState.grants[0]!.disposed).toBe(true)
      expect(mockState.grants[1]!.disposed).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('mode switch: read-only materializes nothing, the upgrade materializes ONCE with the derived SID, the downgrade keeps the standing grant', async () => {
    try {
      const { sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const tempDir = sessionTempDir(SessionId('sess-switch'), ws)
      scratch.push(tempDir)
      const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws, sessionId: SessionId('sess-switch') }
      const workspaceWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-switch') }

      // read-only first: nothing materialized, ambient temp.
      const confinedRo = sandbox.confine(['true'], readOnly)
      expect(confinedRo.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tmpdir(), // NOT the private subdir: read-only grants nothing
        '--mode', 'read-only',
        '--write-sid', DERIVED_SID,
        '--',
        'true',
      ])
      expect(mockState.grants).toHaveLength(0)
      expect(existsSync(tempDir)).toBe(false)

      // Upgrade: first workspace-write materializes with the derived SID.
      const upgraded = sandbox.confine(['true'], workspaceWrite)
      expect(upgraded.argv).toEqual([
        'node', 'windows-acl-runner.js',
        '--workspace', ws,
        '--temp', tempDir,
        '--mode', 'workspace-write',
        '--write-sid', DERIVED_SID,
        '--',
        'true',
      ])
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants[0]).toMatchObject({ writeSid: DERIVED_SID, added: [{ path: ws, standing: true }], disposed: false })
      expect(mockState.grants[1]).toMatchObject({
        writeSid: DERIVED_SID,
        added: [{ path: tempDir, standing: false }],
        disposed: false,
      })
      expect(existsSync(tempDir)).toBe(true)

      // Reuse: map hits.
      sandbox.confine(['true'], workspaceWrite)
      expect(mockState.grants).toHaveLength(2)

      // Downgrade: standing grant KEPT (inert under read-only, free re-upgrade).
      sandbox.confine(['true'], readOnly)
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants[0]!.disposed).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('resume: a fresh provider derives the SAME temp dir for the same session and workspace and re-grants it', async () => {
    try {
      const ws = workspaceRoot()
      scratch.push(ws)
      const first = await setup()
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('resumed') }
      const firstConfined = first.sandbox.confine(['true'], policy)
      expect(mockState.grants).toHaveLength(2)

      // Clean restart: dispose revokes the temp ACE and removes the private
      // temp directory, so the fresh provider's exclusive creation succeeds.
      await first.fiber.dispose()
      mockState.grants = []
      const second = await setup()
      const secondConfined = second.sandbox.confine(['true'], policy)
      expect(secondConfined.argv).toEqual(firstConfined.argv)
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants[1]).toMatchObject({
        writeSid: DERIVED_SID,
        added: [{ path: sessionTempDir(SessionId('resumed'), ws), standing: false }],
      })
      await second.fiber.dispose()
    } finally {
      cleanup()
    }
  })

  it('fork: a different session id derives a DIFFERENT private temp identity over the same workspace', async () => {
    try {
      const { sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const parentPolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('parent') }
      const childPolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('child') }

      sandbox.confine(['true'], parentPolicy)
      const parentTemp = sessionTempDir(SessionId('parent'), ws)
      scratch.push(parentTemp)
      sandbox.confine(['true'], childPolicy)
      const childTemp = sessionTempDir(SessionId('child'), ws)
      scratch.push(childTemp)

      // Fresh temp identity, NOT the parent's (the workspace SID is shared by
      // derivation — the workspace is the same, so the standing grant is the
      // map hit and only the child's temp grant joins).
      expect(childTemp).not.toBe(parentTemp)
      expect(mockState.grants).toHaveLength(3)
      expect(mockState.grants[2]).toMatchObject({ added: [{ path: childTemp, standing: false }] })
    } finally {
      cleanup()
    }
  })

  it('creates the private temp dir EXCLUSIVELY: a pre-existing entry or a reparse point fails EEXIST, never receiving the temp grant', async () => {
    try {
      const { sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)

      // Pre-existing entry: exclusive mkdir throws EEXIST instead of adopting it.
      const preexisting = sessionTempDir(SessionId('preexisting'), ws)
      mkdirSync(preexisting)
      scratch.push(preexisting)
      const prePolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('preexisting') }
      expect(() => sandbox.confine(['true'], prePolicy)).toThrow(/EEXIST/)
      // The standing workspace grant is the intended end state and stays; the
      // failed temp grant self-disposes.
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants[0]!.disposed).toBe(false)
      expect(mockState.grants[1]!.disposed).toBe(true) // self-revoked

      // Reparse point: same EEXIST (exclusive mkdir never follows links).
      const target = mkdtempSync(join(tmpdir(), 'dsh-acl-junction-target-'))
      scratch.push(target)
      const linkPath = sessionTempDir(SessionId('reparse'), ws)
      symlinkSync(target, linkPath)
      scratch.push(linkPath)
      const linkPolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('reparse') }
      expect(() => sandbox.confine(['true'], linkPolicy)).toThrow(/EEXIST/)
      // Same workspace as the preexisting case: the standing workspace grant
      // is the map hit (not recreated) — only the failed temp grant joins.
      expect(mockState.grants).toHaveLength(3)
      expect(mockState.grants[2]!.disposed).toBe(true)

      // Temp-side cleanup failure: the standing workspace grant stays (map
      // hit), the exclusive mkdir fails, AND the temp grant's dispose also
      // fails — the temp cleanup AggregateError propagates.
      mockState.grants = []
      mockState.disposeFailure = new Error('temp cleanup exploded')
      const dupTemp = sessionTempDir(SessionId('temp-cleanup-fail'), ws)
      mkdirSync(dupTemp)
      scratch.push(dupTemp)
      const dupPolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('temp-cleanup-fail') }
      expect(() => sandbox.confine(['true'], dupPolicy)).toThrow(/temp grant materialization failed and its cleanup also failed/)
      expect(mockState.grants).toHaveLength(1) // only the failed temp grant (the workspace grant was the map hit)
    } finally {
      cleanup()
    }
  })

  it('a grant failure mid-materialization disposes the failed grant and rethrows (AggregateError when the cleanup also fails)', async () => {
    try {
      const { sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      scratch.push(sessionTempDir(SessionId('sess-add-fail'), ws))
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-add-fail') }

      // add() throws on the FIRST (workspace) grant: cleanup dispose() runs, original error propagates.
      mockState.addFailure = new Error('grant exploded')
      expect(() => sandbox.confine(['true'], policy)).toThrow('grant exploded')
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

  it('a temp add failure after the exclusive mkdir removed the half-created directory again', async () => {
    try {
      const { sandbox } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      const tempDir = sessionTempDir(SessionId('sess-temp-add-fail'), ws)
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-temp-add-fail') }

      // The workspace grant succeeds; only the TEMP grant's add throws (the
      // path-targeted failure keeps the workspace branch intact).
      mockState.addFailurePath = tempDir
      mockState.addFailure = new Error('temp add exploded')
      expect(() => sandbox.confine(['true'], policy)).toThrow('temp add exploded')
      expect(existsSync(tempDir)).toBe(false) // the half-created directory is removed again
      expect(mockState.grants).toHaveLength(2)
      expect(mockState.grants[0]!.disposed).toBe(false) // the standing workspace grant stays
      expect(mockState.grants[1]!.disposed).toBe(true) // the failed temp grant self-disposes
    } finally {
      cleanup()
    }
  })

  it('agentless calls stay self-managed: no --write-sid, the ambient temp root, no grants', async () => {
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

  it('a failing dispose at provider teardown is reported via ctx.logger.warn and never thrown into teardown', async () => {
    try {
      const { ctx, sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      scratch.push(sessionTempDir(SessionId('sess-dispose'), ws))
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-dispose') }
      sandbox.confine(['true'], policy)
      expect(mockState.grants).toHaveLength(2)

      mockState.disposeFailure = new Error('revoke exploded')
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      await fiber.dispose()
      // BOTH grants (standing workspace + revocable temp) fail their dispose.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup completed with 2 failure(s)'))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'revoke exploded' }))
    } finally {
      cleanup()
    }
  })

  it('a failing private-temp removal at provider teardown is reported via ctx.logger.warn and never thrown into teardown', async () => {
    try {
      const { ctx, sandbox, fiber } = await setup()
      const ws = workspaceRoot()
      scratch.push(ws)
      scratch.push(sessionTempDir(SessionId('sess-rm-fail'), ws))
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws, sessionId: SessionId('sess-rm-fail') }
      sandbox.confine(['true'], policy)
      expect(mockState.grants).toHaveLength(2)

      sandbox.internals.rmTempDir = () => { throw new Error('rm exploded') }
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      await fiber.dispose()
      // Both grants dispose cleanly; only the directory removal fails.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup completed with 1 failure(s)'))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'rm exploded' }))
    } finally {
      cleanup()
    }
  })

  it('sessionTempDir derives the same well-shaped name for the same session and workspace, distinct otherwise', () => {
    const base = sessionTempDir(SessionId('sess-a'), '/ws/a')
    expect(basename(base)).toMatch(/^dsh-[0-9a-f]{16}$/)
    expect(sessionTempDir(SessionId('sess-a'), '/ws/a')).toBe(base)
    expect(sessionTempDir(SessionId('sess-b'), '/ws/a')).not.toBe(base) // different session
    expect(sessionTempDir(SessionId('sess-a'), '/ws/b')).not.toBe(base) // different workspace
    // The separator prevents id/workspace collisions from merging inputs.
    expect(sessionTempDir(SessionId('ab'), '/ws/c')).not.toBe(sessionTempDir(SessionId('a'), '/ws/bc'))
  })
})
