/**
 * Tests for the file-context policy PLUGIN: it registers no service, only the
 * three `fs/*` listeners. We dispatch those events directly (the unbound
 * waterfalls the tool would dispatch, and the `fs/observed` emit) and assert the
 * decisions: createIfAbsent vs replaceIfVersion, FS_NOT_OBSERVED for an unread
 * edit, observed-state-as-prior-observation (read/write/edit all record),
 * multi-owner isolation, single-slot first-wins, and disposal/HMR release.
 *
 * No `ctx.fs` provider is needed — the plugin does no filesystem I/O; it only
 * decides expectations and records versions on its own WeakMap.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsWriteExpectation } from '@deepseek-ai/dsh-fs'
import * as FileContext from '@deepseek-ai/dsh-file-context'
import type { FileContextExec } from '@deepseek-ai/dsh-file-context'

function target(path: string): FsTarget {
  return { inputPath: path, targetKey: FsTargetKey(path), displayPath: path }
}
const ownerExec = (session: object): FileContextExec => ({ agent: { session } })

/** Dispatch the write-expectation waterfall with the bare default thunk. */
function writeExpectation(ctx: Context, t: FsTarget, actor: object | undefined): Promise<FsWriteExpectation | undefined> {
  return ctx.waterfall('fs/write-expectation', t, actor, () => undefined)
}
/** Dispatch the edit-expectation waterfall with the bare default thunk. */
function editExpectation(ctx: Context, t: FsTarget, actor: object | undefined): Promise<{ version: FsVersion } | undefined> {
  return ctx.waterfall('fs/edit-expectation', t, actor, () => undefined)
}

async function setup() {
  const ctx = new Context()
  const fiber = await ctx.plugin(FileContext)
  return { ctx, fiber }
}

describe('registration / disposal', () => {
  it('registers no service surface (it is a plugin, not ctx.fileContext)', async () => {
    const { ctx } = await setup()
    expect((ctx as Context & { fileContext?: unknown }).fileContext).toBeUndefined()
  })

  it('mounts with no inject (reads no services)', async () => {
    // It mounts immediately even with nothing else in the context.
    const ctx = new Context()
    await ctx.plugin(FileContext)
    // The listener is live: an unobserved write decides createIfAbsent.
    expect(await writeExpectation(ctx, target('a.txt'), undefined)).toEqual({ kind: 'createIfAbsent' })
  })
})

describe('write-expectation decision', () => {
  it('an unobserved target decides createIfAbsent', async () => {
    const { ctx } = await setup()
    expect(await writeExpectation(ctx, target('a.txt'), ownerExec({}))).toEqual({ kind: 'createIfAbsent' })
  })

  it('a no-owner actor decides createIfAbsent', async () => {
    const { ctx } = await setup()
    expect(await writeExpectation(ctx, target('a.txt'), undefined)).toEqual({ kind: 'createIfAbsent' })
    expect(await writeExpectation(ctx, target('a.txt'), {})).toEqual({ kind: 'createIfAbsent' })
  })

  it('an observed target decides replaceIfVersion at the observed version', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v7'), exec)
    expect(await writeExpectation(ctx, target('a.txt'), exec)).toEqual({ kind: 'replaceIfVersion', version: 'v7' })
  })
})

describe('edit-expectation decision', () => {
  it('rejects an unread edit with FS_NOT_OBSERVED', async () => {
    const { ctx } = await setup()
    await expect(editExpectation(ctx, target('a.txt'), ownerExec({}))).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('rejects an edit with no owner (cannot prove prior observation)', async () => {
    const { ctx } = await setup()
    await expect(editExpectation(ctx, target('a.txt'), undefined)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('returns the observed version as the CAS basis after an observation', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v3'), exec)
    expect(await editExpectation(ctx, target('a.txt'), exec)).toEqual({ version: 'v3' })
  })
})

describe('observed-state is the prior-observation record', () => {
  it('a read observation authorizes an in-place write at that version', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v0'), exec) // a read
    expect(await writeExpectation(ctx, target('a.txt'), exec)).toEqual({ kind: 'replaceIfVersion', version: 'v0' })
  })

  it('a write/edit observation refreshes the basis, so the next edit needs no re-read', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    // A create records v1; the follow-up edit guards against v1 with no read.
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v1'), exec)
    expect(await editExpectation(ctx, target('a.txt'), exec)).toEqual({ version: 'v1' })
    // The edit records v2; a second edit guards against v2.
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v2'), exec)
    expect(await editExpectation(ctx, target('a.txt'), exec)).toEqual({ version: 'v2' })
  })

  it('a no-owner observation records nothing', async () => {
    const { ctx } = await setup()
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v0'), undefined)
    // Still unobserved for any owner.
    await expect(editExpectation(ctx, target('a.txt'), ownerExec({}))).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })
})

describe('multi-owner isolation', () => {
  it('owner A observing does not grant owner B edit authority', async () => {
    const { ctx } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v0'), a)
    await expect(editExpectation(ctx, target('a.txt'), b)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(await editExpectation(ctx, target('a.txt'), a)).toEqual({ version: 'v0' })
  })

  it('each owner records its own observed version independently', async () => {
    const { ctx } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v0'), a) // A observed v0
    // B never observed → createIfAbsent; A still holds v0 → replaceIfVersion.
    expect(await writeExpectation(ctx, target('a.txt'), b)).toEqual({ kind: 'createIfAbsent' })
    expect(await writeExpectation(ctx, target('a.txt'), a)).toEqual({ kind: 'replaceIfVersion', version: 'v0' })
  })
})

describe('single-slot, first-wins', () => {
  it('fully decides the slot without calling next() (the bare default is unreached)', async () => {
    const { ctx } = await setup()
    let defaultRan = false
    const expectation = await ctx.waterfall('fs/write-expectation', target('a.txt'), ownerExec({}), () => {
      defaultRan = true
      return undefined
    })
    expect(expectation).toEqual({ kind: 'createIfAbsent' })
    expect(defaultRan).toBe(false)
  })

  it('a SECOND decider registered AFTER file-context is not reached (first-wins short-circuit)', async () => {
    const { ctx } = await setup()
    let secondRan = false
    // Registered after file-context, so it dispatches second; file-context does
    // not call next(), so this never runs. (A decider registered BEFORE — or with
    // prepend — would instead win: first-wins is by convention, not enforced.)
    ctx.on('fs/edit-expectation', () => {
      secondRan = true
      return Promise.resolve(undefined)
    })
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v0'), exec)
    await editExpectation(ctx, target('a.txt'), exec)
    expect(secondRan).toBe(false)
  })
})

describe('disposal releases recorded state (HMR safety)', () => {
  it('a fresh plugin after disposal starts with no inherited state', async () => {
    const ctx = new Context()
    const exec = ownerExec({})
    const fiber = await ctx.plugin(FileContext)
    ctx.emit('fs/observed', target('a.txt'), FsVersion('v0'), exec)
    expect(await editExpectation(ctx, target('a.txt'), exec)).toEqual({ version: 'v0' })
    await fiber.dispose()

    await ctx.plugin(FileContext)
    // Same owner object, but state was released on disposal.
    await expect(editExpectation(ctx, target('a.txt'), exec)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('no listeners remain after disposal (the gate no longer decides)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(FileContext)
    await fiber.dispose()
    // With no listener, the waterfall falls through to the bare default.
    expect(await writeExpectation(ctx, target('a.txt'), ownerExec({}))).toBeUndefined()
  })
})
