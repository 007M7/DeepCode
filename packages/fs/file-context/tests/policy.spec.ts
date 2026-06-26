/**
 * Tests for the file-context policy layer: registration/disposal/HMR, owner
 * derivation, observed-state-as-read-record, read windowing over a fake
 * provider, freshness-based write/edit authorization (including the key
 * windowed-read-authorizes-edit behavior), the read→streamText size routing,
 * and multi-owner isolation. The provider is a fake `ctx.fs` recording the
 * expectations it was handed.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsTarget,
  FsWriteExpectation,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import FileContext, { STREAM_MIN_SIZE } from '@deepseek-ai/dsh-file-context'
import type { FileContextExec, FileReadRequest } from '@deepseek-ai/dsh-file-context'

/** A fake provider: in-memory files, recording every expectation/version it is handed. */
class FakeFs extends FileSystem {
  files = new Map<string, string>()
  versions = new Map<string, number>()
  /** Size to report from stat (lets a test push read onto the streaming path). */
  reportSize?: number
  /** When true, stat omits `size` entirely (a size-less backend). */
  omitSize = false
  /** Whether streamText was used for the last read (vs readText). */
  lastReadStreamed = false
  writeExpectations: FsWriteExpectation[] = []
  editExpectedVersions: string[] = []

  private ver(key: string): FsVersion {
    return FsVersion(`v${this.versions.get(key) ?? 0}`)
  }
  private bump(key: string): FsVersion {
    const next = (this.versions.get(key) ?? 0) + 1
    this.versions.set(key, next)
    return FsVersion(`v${next}`)
  }

  override async resolve(path: string): Promise<FsTarget> {
    return { inputPath: path, targetKey: FsTargetKey(path), displayPath: path }
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.files.get(target.targetKey)
    if (content === undefined) return undefined
    return { version: this.ver(target.targetKey), type: 'file', ...this.omitSize ? {} : { size: this.reportSize ?? content.length } }
  }
  override async readText(target: FsTarget): Promise<string> {
    this.lastReadStreamed = false
    return this.files.get(target.targetKey) ?? ''
  }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    this.lastReadStreamed = true
    const content = this.files.get(target.targetKey) ?? ''
    return (async function* () { yield content })()
  }
  override async writeText(target: FsTarget, content: string, expected: FsWriteExpectation): Promise<FsWriteOutcome> {
    this.writeExpectations.push(expected)
    const existed = this.files.has(target.targetKey)
    this.files.set(target.targetKey, content)
    return { operation: existed ? 'update' : 'create', version: this.bump(target.targetKey) }
  }
  override async editText(target: FsTarget, edit: FsEditRequest, expected: { version: FsVersion }): Promise<FsEditOutcome> {
    this.editExpectedVersions.push(expected.version)
    const content = this.files.get(target.targetKey) ?? ''
    this.files.set(target.targetKey, content.split(edit.oldString).join(edit.newString))
    return { replacements: 1, replaceAll: edit.replaceAll, version: this.bump(target.targetKey) }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(FakeFs)
  await ctx.plugin(FileContext)
  const fs = ctx.fs as FakeFs
  const fileContext = ctx.fileContext
  return { ctx, fs, fileContext }
}

const READ_ALL: FileReadRequest = { offset: 1, limit: 2000 }
const ownerExec = (session: object): FileContextExec => ({ agent: { session } })

describe('registration / disposal', () => {
  it('registers as ctx.fileContext and injects fs', async () => {
    const { fileContext } = await setup()
    expect(fileContext).toBeDefined()
  })

  it('stays pending until ctx.fs exists', async () => {
    const ctx = new Context()
    await ctx.plugin(FileContext) // no fs provider
    expect(ctx.fileContext).toBeUndefined()
  })

  it('withdraws ctx.fileContext when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFs)
    const fiber = await ctx.plugin(FileContext)
    expect(ctx.fileContext).toBeDefined()
    await fiber.dispose()
    expect(ctx.fileContext).toBeUndefined()
  })
})

describe('owner derivation', () => {
  it('derives the owner from exec.agent.session', async () => {
    const { fileContext } = await setup()
    const session = {}
    expect(fileContext.owner(ownerExec(session))).toBe(session)
  })

  it('returns undefined with no exec, no agent, or no session', async () => {
    const { fileContext } = await setup()
    expect(fileContext.owner()).toBeUndefined()
    expect(fileContext.owner({})).toBeUndefined()
    expect(fileContext.owner({ agent: {} })).toBeUndefined()
  })
})

describe('read', () => {
  it('returns a windowed outcome and rejects an absent target', async () => {
    const { fs, fileContext } = await setup()
    fs.files.set('a.txt', 'one\ntwo')
    const outcome = await fileContext.read(await fs.resolve('a.txt'), READ_ALL)
    expect(outcome.lines).toEqual([{ number: 1, text: 'one' }, { number: 2, text: 'two' }])
    expect(outcome.version).toBe('v0')

    await expect(fileContext.read(await fs.resolve('missing.txt'), READ_ALL))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('rejects a non-regular target', async () => {
    const { fs, fileContext } = await setup()
    fs.files.set('d', '')
    const target = await fs.resolve('d')
    // Force stat to report a directory.
    fs.stat = async () => ({ version: FsVersion('v0'), type: 'directory' })
    await expect(fileContext.read(target, READ_ALL)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('reads small files whole and large files via streamText', async () => {
    const { fs, fileContext } = await setup()
    fs.files.set('a.txt', 'one\ntwo')

    await fileContext.read(await fs.resolve('a.txt'), READ_ALL)
    expect(fs.lastReadStreamed).toBe(false)

    fs.reportSize = STREAM_MIN_SIZE
    await fileContext.read(await fs.resolve('a.txt'), READ_ALL)
    expect(fs.lastReadStreamed).toBe(true)
  })

  it('streams when the backend reports no size (never buffers a size-less file)', async () => {
    const { fs, fileContext } = await setup()
    fs.files.set('a.txt', 'one\ntwo')
    fs.omitSize = true
    await fileContext.read(await fs.resolve('a.txt'), READ_ALL)
    expect(fs.lastReadStreamed).toBe(true)
  })

  it('records the version observed after the read, not the routing stat', async () => {
    const { fs, fileContext } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    fs.versions.set('a.txt', 1)
    const target = await fs.resolve('a.txt')
    // A writer bumps the version after the routing stat but before the post-read stat.
    const realReadText = fs.readText.bind(fs)
    fs.readText = async (t) => {
      const text = await realReadText(t)
      fs.versions.set('a.txt', 5) // file changed during the read
      return text
    }
    const outcome = await fileContext.read(target, READ_ALL, exec)
    expect(outcome.version).toBe('v5')
    // The recorded (post-read) version authorizes an edit without going stale.
    await fileContext.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, exec)
    expect(fs.editExpectedVersions).toEqual(['v5'])
  })

  it('falls back to the routing-stat version if the file vanishes after the read', async () => {
    const { fs, fileContext } = await setup()
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')
    const realReadText = fs.readText.bind(fs)
    fs.readText = async (t) => {
      const text = await realReadText(t)
      fs.files.delete('a.txt') // vanishes → post-read stat returns undefined
      return text
    }
    const outcome = await fileContext.read(target, READ_ALL)
    expect(outcome.version).toBe('v0') // the routing-stat version
  })

  it('surfaces truncatedByBytes when the window hits the byte cap', async () => {
    const { fs, fileContext } = await setup()
    fs.files.set('big.txt', Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n'))
    const outcome = await fileContext.read(await fs.resolve('big.txt'), READ_ALL)
    expect(outcome.truncatedByBytes).toBe(true)
  })
})

describe('observed-state is the read record', () => {
  it('a read authorizes a later in-place write at the observed version', async () => {
    const { fs, fileContext } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await fileContext.read(target, READ_ALL, exec)
    await fileContext.write(target, 'goodbye', exec)

    expect(fs.writeExpectations).toEqual([{ kind: 'replaceIfVersion', version: 'v0' }])
  })

  it('a windowed (partial) read still authorizes edit — freshness, not full/partial', async () => {
    const { fs, fileContext } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'one\ntwo\nthree\nfour')
    const target = await fs.resolve('a.txt')

    // Read only lines 2-3 — a partial window.
    const outcome = await fileContext.read(target, { offset: 2, limit: 2 }, exec)
    expect(outcome.lines.map(l => l.number)).toEqual([2, 3])

    // Edit is authorized anyway: the file is unchanged since the read.
    await fileContext.edit(target, { oldString: 'one', newString: 'X', replaceAll: false }, exec)
    expect(fs.editExpectedVersions).toEqual(['v0'])
  })

  it('skips recording when there is no owner, so write is createIfAbsent', async () => {
    const { fs, fileContext } = await setup()
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await fileContext.read(target, READ_ALL) // no exec
    // No recorded read → createIfAbsent → the provider rejects an existing target.
    fs.writeText = async () => { throw new FsError('exists', 'FS_NOT_OBSERVED') }
    await expect(fileContext.write(target, 'x')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })
})

describe('write policy', () => {
  it('a create (no prior read) uses createIfAbsent', async () => {
    const { fs, fileContext } = await setup()
    const exec = ownerExec({})
    const target = await fs.resolve('new.txt')
    const outcome = await fileContext.write(target, 'fresh', exec)
    expect(outcome.operation).toBe('create')
    expect(fs.writeExpectations).toEqual([{ kind: 'createIfAbsent' }])
  })

  it('refreshes state after a write, so a follow-up edit needs no re-read', async () => {
    const { fs, fileContext } = await setup()
    const exec = ownerExec({})
    const target = await fs.resolve('a.txt')
    await fileContext.write(target, 'one', exec) // create → state now at v1
    await fileContext.edit(target, { oldString: 'one', newString: 'two', replaceAll: false }, exec)
    expect(fs.editExpectedVersions).toEqual(['v1'])
  })
})

describe('edit policy', () => {
  it('rejects with FS_NOT_OBSERVED when the file was never read', async () => {
    const { fs, fileContext } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')
    await expect(fileContext.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, exec))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('rejects when there is no owner (cannot prove prior observation)', async () => {
    const { fs, fileContext } = await setup()
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')
    await expect(fileContext.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('passes the recorded version as the stale guard after a read', async () => {
    const { fs, fileContext } = await setup()
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    fs.versions.set('a.txt', 7)
    const target = await fs.resolve('a.txt')
    await fileContext.read(target, READ_ALL, exec)
    await fileContext.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, exec)
    expect(fs.editExpectedVersions).toEqual(['v7'])
  })
})

describe('multi-owner isolation', () => {
  it('owner A reading does not grant owner B edit authority', async () => {
    const { fs, fileContext } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await fileContext.read(target, READ_ALL, a)
    await expect(fileContext.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, b))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    await expect(fileContext.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, a))
      .resolves.toMatchObject({ replacements: 1 })
  })

  it('each owner records its own observed version independently', async () => {
    const { fs, fileContext } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    fs.files.set('a.txt', 'hello')
    const target = await fs.resolve('a.txt')

    await fileContext.read(target, READ_ALL, a) // A sees v0
    await fileContext.write(target, 'mid', b) // B has no read → createIfAbsent
    await fileContext.write(target, 'late', a) // A still holds its v0 observation

    expect(fs.writeExpectations).toEqual([
      { kind: 'createIfAbsent' },
      { kind: 'replaceIfVersion', version: 'v0' },
    ])
  })
})

describe('disposal releases recorded state', () => {
  it('a fresh service after disposal starts with no inherited state', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFs)
    const fs = ctx.fs as FakeFs
    const fiber = await ctx.plugin(FileContext)
    const exec = ownerExec({})
    fs.files.set('a.txt', 'hello')
    await ctx.fileContext.read(await fs.resolve('a.txt'), READ_ALL, exec)
    await fiber.dispose()

    await ctx.plugin(FileContext)
    const target = await fs.resolve('a.txt')
    // Same owner object, but state was released on disposal.
    await expect(ctx.fileContext.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, exec))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })
})
