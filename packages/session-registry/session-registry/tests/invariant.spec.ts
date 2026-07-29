/**
 * Tests for the registry's invariant companion: each acceptance path is proven
 * to REJECT an invalid case, since a check that cannot fail is not a check.
 * The backend is a minimal in-memory stub — the companion owns contract-level
 * relations over `list()` results, whatever medium serves them.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import InvariantService from '@deepseek-ai/dsh-invariants'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BootId, SessionRegistry, type SessionRegistration, type SessionRegistryRecord } from '@deepseek-ai/dsh-session-registry'
import * as invariant from '@deepseek-ai/dsh-session-registry/src/invariant.ts'

/** Minimal in-memory backend whose listings the test scripts directly. */
class StubRegistry extends SessionRegistry {
  records: SessionRegistryRecord[] = []

  constructor(ctx: Context) {
    super(ctx, BootId('stub-boot'))
  }

  register(registration: SessionRegistration): Promise<() => Promise<void>> {
    this.records.push({
      sessionId: registration.sessionId,
      pid: process.pid,
      cwd: registration.cwd,
      startedAt: Date.now(),
      bootId: this.bootId,
    })
    return Promise.resolve(() => Promise.resolve())
  }

  retitle(): Promise<void> {
    return Promise.resolve()
  }

  list(): Promise<SessionRegistryRecord[]> {
    return Promise.resolve([...this.records])
  }
}

/** One record with the given identity fields, live by construction. */
function record(sessionId: string, boot: string, pid = process.pid): SessionRegistryRecord {
  return { sessionId: SessionId(sessionId), pid, cwd: '/w', startedAt: 1, bootId: BootId(boot) }
}

/** Mount the stub backend, optionally seeding records before the companion wraps `list`. */
async function mount(records?: SessionRegistryRecord[]): Promise<{ ctx: Context; stub: StubRegistry }> {
  const ctx = new Context()
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(StubRegistry)
  const stub = ctx.sessionRegistry as StubRegistry
  if (records !== undefined) stub.records = records
  await ctx.plugin(invariant)
  return { ctx, stub }
}

describe('listing invariants', () => {
  it('accepts a well-formed listing', async () => {
    const { ctx } = await mount()
    await ctx.sessionRegistry.register({ sessionId: SessionId('ok'), cwd: '/w' })
    await expect(ctx.sessionRegistry.list()).resolves.toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('rejects a listing where one session id appears twice', async () => {
    // Two live records for one session: only a broken mutation path (or an
    // out-of-band writer) can produce this, and it would make
    // `dsh list-sessions` show one session twice.
    const { ctx } = await mount([record('dup', 'boot-a'), record('dup', 'boot-b')])
    await expect(ctx.sessionRegistry.list()).rejects.toThrow(/appears in more than one live registry record/)
    await ctx.fiber.dispose()
  })

  it('rejects a listing whose record carries an unusable pid', async () => {
    // A record no reader could attribute to a process: `dsh list-sessions`
    // renders the pid and derives liveness from it.
    const { ctx } = await mount([record('ghost', 'boot-x', 0)])
    await expect(ctx.sessionRegistry.list()).rejects.toThrow(/carries unusable pid/)
    await ctx.fiber.dispose()
  })

  it('stops checking, and keeps working, when the companion unloads', async () => {
    // A duplicate-id listing the mounted companion rejects, so the post-disposal
    // read proves the wrapper is gone rather than merely bypassed.
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(StubRegistry)
    ;(ctx.sessionRegistry as StubRegistry).records = [record('dup', 'boot-a'), record('dup', 'boot-b')]
    const companion = await ctx.plugin(invariant)
    await expect(ctx.sessionRegistry.list()).rejects.toThrow(/appears in more than one/)

    await companion.dispose()
    await expect(ctx.sessionRegistry.list()).resolves.toHaveLength(2)
    await ctx.fiber.dispose()
  })
})
