/**
 * Tests for the filesystem service seam itself: registration/disposal, owner
 * derivation, and the read-before-write/edit policy the base class enforces
 * (which `FsExpectation` it hands the backend, multi-owner isolation, and
 * state refresh) — all exercised through a fake in-memory backend that records
 * the expectations it received.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsExpectation,
  FsReadOutcome,
  FsReadRequest,
  FsTarget,
  FsView,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

/** A fake backend: an in-memory file table, recording every expectation it is handed. */
class FakeFileSystem extends FileSystem {
  files = new Map<string, string>()
  versions = new Map<string, number>()
  /** View the next `readPage` should report (tests flip this for partial reads). */
  nextReadView: FsView = 'full'
  /** Expectations handed to `createOrReplace`, in call order. */
  writeExpectations: FsExpectation[] = []
  /** Versions handed to `applyEdit`, in call order. */
  editExpectedVersions: string[] = []

  private bump(key: string): string {
    const next = (this.versions.get(key) ?? 0) + 1
    this.versions.set(key, next)
    return `v${next}`
  }

  override async resolve(path: string): Promise<FsTarget> {
    return { inputPath: path, targetKey: path, displayPath: path }
  }

  override async readPage(target: FsTarget, request: FsReadRequest): Promise<FsReadOutcome> {
    const content = this.files.get(target.targetKey)
    if (content === undefined) throw new FsError(`not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    const allLines = content.split('\n')
    const lines = allLines
      .slice(request.offset - 1, request.offset - 1 + request.limit)
      .map((text, i) => ({ number: request.offset + i, text }))
    return {
      offset: request.offset,
      limit: request.limit,
      lines,
      totalLines: allLines.length,
      version: `v${this.versions.get(target.targetKey) ?? 0}`,
      view: this.nextReadView,
    }
  }

  override async createOrReplace(target: FsTarget, content: string, expected: FsExpectation): Promise<FsWriteOutcome> {
    this.writeExpectations.push(expected)
    const existed = this.files.has(target.targetKey)
    this.files.set(target.targetKey, content)
    return { operation: existed ? 'update' : 'create', version: this.bump(target.targetKey) }
  }

  override async applyEdit(target: FsTarget, edit: FsEditRequest, expected: { version: string }): Promise<FsEditOutcome> {
    this.editExpectedVersions.push(expected.version)
    const content = this.files.get(target.targetKey) ?? ''
    this.files.set(target.targetKey, content.split(edit.oldString).join(edit.newString))
    return { replacements: 1, replaceAll: edit.replaceAll, version: this.bump(target.targetKey) }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(FakeFileSystem)
  const fs = ctx.fs as FakeFileSystem
  return { ctx, fs }
}

const READ_ALL: FsReadRequest = { offset: 1, limit: 2000 }
const ownerExec = (session: object) => ({ agent: { session } })

describe('FileSystem service seam', () => {
  it('registers as ctx.fs and serves the API', async () => {
    const { fs } = await setup()
    fs.files.set('a.txt', 'hi')
    const outcome = await fs.read(await fs.resolve('a.txt'), READ_ALL)
    expect(outcome.lines).toEqual([{ number: 1, text: 'hi' }])
  })

  it('throws when a second implementation is loaded (duplicate service)', async () => {
    const { ctx } = await setup()
    await expect(ctx.plugin(FakeFileSystem)).rejects.toThrow()
  })

  it('removes the service when the providing fiber is disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(FakeFileSystem)
    expect(ctx.fs).toBeDefined()
    await fiber.dispose()
    expect(ctx.fs).toBeUndefined()
  })
})

describe('owner derivation', () => {
  it('derives the owner from exec.agent.session', async () => {
    const { fs } = await setup()
    const session = {}
    expect(fs.owner(ownerExec(session))).toBe(session)
  })

  it('returns undefined with no exec, no agent, or no session', async () => {
    const { fs } = await setup()
    expect(fs.owner()).toBeUndefined()
    expect(fs.owner({})).toBeUndefined()
    expect(fs.owner({ agent: {} })).toBeUndefined()
  })
})

describe('read records observed state', () => {
  it('a full read authorizes a later in-place write (observed expectation)', async () => {
    const { fs } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await fs.read(target, READ_ALL, exec)
    await fs.write(target, 'goodbye', exec)

    expect(fs.writeExpectations).toEqual([{ kind: 'observed', version: 'v0' }])
  })

  it('a partial read does NOT authorize a write (passes a partial expectation)', async () => {
    const { fs } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    fs.nextReadView = 'partial'
    const target = await fs.resolve('a.txt')

    await fs.read(target, { offset: 1, limit: 1 }, exec)
    await fs.write(target, 'goodbye', exec)

    expect(fs.writeExpectations).toEqual([{ kind: 'partial', version: 'v0' }])
  })

  it('skips recording when there is no owner', async () => {
    const { fs } = await setup()
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await fs.read(target, READ_ALL) // no exec
    await fs.write(target, 'goodbye') // no exec → cannot be observed

    expect(fs.writeExpectations).toEqual([{ kind: 'unobserved' }])
  })
})

describe('write policy', () => {
  it('a create (no prior state) is unobserved', async () => {
    const { fs } = await setup()
    const exec = ownerExec({})
    const target = await fs.resolve('new.txt')

    const outcome = await fs.write(target, 'fresh', exec)

    expect(outcome.operation).toBe('create')
    expect(fs.writeExpectations).toEqual([{ kind: 'unobserved' }])
  })

  it('refreshes state to full after a write, so a follow-up edit needs no re-read', async () => {
    const { fs } = await setup()
    const exec = ownerExec({})
    const target = await fs.resolve('a.txt')

    await fs.write(target, 'one', exec) // create → state now full at v1
    await fs.edit(target, { oldString: 'one', newString: 'two', replaceAll: false }, exec)

    expect(fs.editExpectedVersions).toEqual(['v1'])
  })
})

describe('edit policy', () => {
  it('rejects with FS_NOT_OBSERVED when the file was never read', async () => {
    const { fs } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await expect(
      fs.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, exec),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('rejects with FS_PARTIAL_OBSERVATION when only a partial view was recorded', async () => {
    const { fs } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    fs.nextReadView = 'partial'
    const target = await fs.resolve('a.txt')
    await fs.read(target, { offset: 1, limit: 1 }, exec)

    await expect(
      fs.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, exec),
    ).rejects.toMatchObject({ code: 'FS_PARTIAL_OBSERVATION' })
  })

  it('rejects an empty oldString before calling the backend primitive', async () => {
    const { fs } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')
    await fs.read(target, READ_ALL, exec)

    await expect(
      fs.edit(target, { oldString: '', newString: 'bye', replaceAll: false }, exec),
    ).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    expect(fs.editExpectedVersions).toEqual([])
  })

  it('rejects when there is no owner (cannot prove prior observation)', async () => {
    const { fs } = await setup()
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await expect(
      fs.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('proceeds after a full read, passing the recorded version as the stale guard', async () => {
    const { fs } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    fs.versions.set('a.txt', 7) // distinguishable version
    const target = await fs.resolve('a.txt')
    await fs.read(target, READ_ALL, exec)

    await fs.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, exec)

    expect(fs.editExpectedVersions).toEqual(['v7'])
  })
})

describe('multi-owner isolation', () => {
  it('owner A reading does not grant owner B edit authority', async () => {
    const { fs } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await fs.read(target, READ_ALL, a)

    // B never read it → B's edit must be rejected.
    await expect(
      fs.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, b),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    // A still may edit.
    await expect(
      fs.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, a),
    ).resolves.toMatchObject({ replacements: 1 })
  })

  it('each owner records its own observed version independently', async () => {
    const { fs } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await fs.read(target, READ_ALL, a) // A sees v0
    await fs.write(target, 'mid', b) // B writes unobserved → file now v1
    await fs.write(target, 'late', a) // A still holds its v0 observation

    expect(fs.writeExpectations).toEqual([
      { kind: 'unobserved' },
      { kind: 'observed', version: 'v0' },
    ])
  })
})

describe('disposal releases recorded state', () => {
  it('a fresh provider after disposal starts with no inherited state', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(FakeFileSystem)
    const fs1 = ctx.fs as FakeFileSystem
    const exec = ownerExec({})
    fs1.files.set('a.txt', 'hello')
    await fs1.read(await fs1.resolve('a.txt'), READ_ALL, exec)
    await fiber.dispose()

    await ctx.plugin(FakeFileSystem)
    const fs2 = ctx.fs as FakeFileSystem
    fs2.files.set('a.txt', 'hello')
    const target = await fs2.resolve('a.txt')
    // Reusing the same exec/owner object: state must NOT carry over.
    await expect(
      fs2.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, exec),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })
})

describe('FsError', () => {
  it('carries a stable code and HarnessError name', () => {
    const error = new FsError('nope', 'FS_NOT_FOUND')
    expect(error.code).toBe('FS_NOT_FOUND')
    expect(error.name).toBe('FsError')
    expect(error).toBeInstanceOf(Error)
  })
})
