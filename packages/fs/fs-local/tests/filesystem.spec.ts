/**
 * Tests for the local backend through the `ctx.fs` service: the full
 * read→write→edit lifecycle with the read-before-write policy, stale-version
 * guards, concurrency races, symlink identity, and HMR/disposal.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { LocalFileSystem, probe } from '@deepseek-ai/dsh-fs-local'
import type { FsExecContext } from '@deepseek-ai/dsh-fs'

let dir: string
let ctx: Context
let fs: LocalFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fs-'))
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  fs = ctx.fs as LocalFileSystem
})
afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

const READ_ALL = { offset: 1, limit: 2000 }
const exec = (): FsExecContext => ({ agent: { session: {} } })
function lockCount(localFs: LocalFileSystem): number {
  return (localFs as unknown as { locks: Map<string, Promise<unknown>> }).locks.size
}

describe('registration', () => {
  it('registers LocalFileSystem as ctx.fs with a default cwd', async () => {
    const bare = new Context()
    const bareFiber = await bare.plugin(LocalFileSystem)
    expect((bare.fs as LocalFileSystem).config.cwd).toBe(process.cwd())
    await bareFiber.dispose()
  })
})

describe('read → write → edit lifecycle', () => {
  it('creates a new file without a prior read', async () => {
    const target = await fs.resolve('new.txt')
    const outcome = await fs.write(target, 'fresh', exec())
    expect(outcome.operation).toBe('create')
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('fresh')
  })

  it('updates an existing file after reading it', async () => {
    await writeFile(join(dir, 'a.txt'), 'old')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    await fs.read(target, READ_ALL, owner)
    const outcome = await fs.write(target, 'new', owner)
    expect(outcome.operation).toBe('update')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new')
  })

  it('edits an existing file after reading it', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    await fs.read(target, READ_ALL, owner)
    const outcome = await fs.edit(target, { oldString: 'world', newString: 'there', replaceAll: false }, owner)
    expect(outcome.replacements).toBe(1)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello there')
  })

  it('rejects an empty edit oldString through ctx.fs without hanging or changing the file', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    await fs.read(target, READ_ALL, owner)

    await expect(fs.edit(target, { oldString: '', newString: 'boom', replaceAll: false }, owner))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello world')
  })

  it('propagates truncatedByBytes from a byte-capped read', async () => {
    await writeFile(join(dir, 'big.txt'), Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n'))
    const outcome = await fs.read(await fs.resolve('big.txt'), READ_ALL, exec())
    expect(outcome.truncatedByBytes).toBe(true)
    expect(outcome.view).toBe('partial')
  })

  it('records an over-long-line read as partial, so write/edit stay blocked', async () => {
    await writeFile(join(dir, 'long.txt'), 'x'.repeat(3000))
    const owner = exec()
    const target = await fs.resolve('long.txt')
    const outcome = await fs.read(target, READ_ALL, owner)

    expect(outcome.view).toBe('partial')
    await expect(fs.write(target, 'new', owner)).rejects.toMatchObject({ code: 'FS_PARTIAL_OBSERVATION' })
    await expect(
      fs.edit(target, { oldString: 'x', newString: 'y', replaceAll: false }, owner),
    ).rejects.toMatchObject({ code: 'FS_PARTIAL_OBSERVATION' })
  })

  it('allows a follow-up edit without re-reading (write/edit refresh state)', async () => {
    await writeFile(join(dir, 'a.txt'), 'a b')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    await fs.read(target, READ_ALL, owner)
    await fs.edit(target, { oldString: 'a', newString: 'X', replaceAll: false }, owner)
    await fs.edit(target, { oldString: 'b', newString: 'Y', replaceAll: false }, owner)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('X Y')
  })

  it('releases per-target mutation locks after success and failure', async () => {
    const target = await fs.resolve('a.txt')
    await fs.write(target, 'created', exec())
    expect(lockCount(fs)).toBe(0)

    await expect(fs.write(target, 'blind overwrite', exec())).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(lockCount(fs)).toBe(0)
  })
})

describe('read-before-write policy', () => {
  it('rejects a blind overwrite of an existing file (no prior read)', async () => {
    await writeFile(join(dir, 'a.txt'), 'old')
    const target = await fs.resolve('a.txt')
    await expect(fs.write(target, 'new', exec())).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('rejects a write after only a partial read', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    await fs.read(target, { offset: 1, limit: 1 }, owner)
    await expect(fs.write(target, 'new', owner)).rejects.toMatchObject({ code: 'FS_PARTIAL_OBSERVATION' })
  })

  it('rejects a write after a partial read when the file was deleted, without recreating it', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, 'one\ntwo')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    await fs.read(target, { offset: 1, limit: 1 }, owner)
    await unlink(path)

    await expect(fs.write(target, 'new', owner)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an edit with no prior read (FS_NOT_OBSERVED)', async () => {
    await writeFile(join(dir, 'a.txt'), 'old')
    const target = await fs.resolve('a.txt')
    await expect(fs.edit(target, { oldString: 'old', newString: 'new', replaceAll: false }, exec()))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('rejects invalid UTF-8 reads and edits without rewriting the file', async () => {
    const path = join(dir, 'invalid-utf8.txt')
    const bytes = Buffer.from([0x68, 0xff, 0x69])
    await writeFile(path, bytes)
    const owner = exec()
    const target = await fs.resolve('invalid-utf8.txt')

    await expect(fs.read(target, READ_ALL, owner)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    const existing = await probe(target.targetKey)
    if (!existing) throw new Error('expected invalid UTF-8 fixture to exist')
    await expect(
      fs.applyEdit(target, { oldString: 'h', newString: 'H', replaceAll: false }, { version: existing.version }),
    ).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    expect(await readFile(path)).toEqual(bytes)
  })
})

describe('stale-version guard + concurrency (defensive class B)', () => {
  it('rejects a write when the file changed since it was read', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    await fs.read(target, READ_ALL, owner)
    // An out-of-band change after the read.
    await writeFile(join(dir, 'a.txt'), 'changed-externally')
    await expect(fs.write(target, 'v2', owner)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('rejects an observed write when the file was deleted after the read', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    await fs.read(target, READ_ALL, owner)
    await unlink(join(dir, 'a.txt')) // file vanishes; observed write must fail (not silently create)
    await expect(fs.write(target, 'v2', owner)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('two concurrent edits: one wins, the other is rejected as stale', async () => {
    await writeFile(join(dir, 'a.txt'), 'base')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    await fs.read(target, READ_ALL, owner)
    // Both edits captured the same recorded version; only one rename can match it.
    const results = await Promise.allSettled([
      fs.edit(target, { oldString: 'base', newString: 'one', replaceAll: false }, owner),
      fs.edit(target, { oldString: 'base', newString: 'two', replaceAll: false }, owner),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(lockCount(fs)).toBe(0)
  })
})

describe('symlink targetKey identity (defensive class F)', () => {
  it('a read via the real path authorizes an edit via the symlink path', async () => {
    await writeFile(join(dir, 'real.txt'), 'hello')
    await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'))
    const owner = exec()
    await fs.read(await fs.resolve('real.txt'), READ_ALL, owner)
    // Edit through the link: same realpath → same targetKey → prior read counts.
    const linkTarget = await fs.resolve('link.txt')
    const outcome = await fs.edit(linkTarget, { oldString: 'hello', newString: 'bye', replaceAll: false }, owner)
    expect(outcome.replacements).toBe(1)
    expect(await readFile(join(dir, 'real.txt'), 'utf8')).toBe('bye') // link preserved, target written
  })

  it('write through a symlink preserves the link and writes the real target', async () => {
    await writeFile(join(dir, 'real.txt'), 'hello')
    await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'))
    const owner = exec()
    const linkTarget = await fs.resolve('link.txt')
    await fs.read(linkTarget, READ_ALL, owner)
    await fs.write(linkTarget, 'replaced', owner)
    expect(await readFile(join(dir, 'real.txt'), 'utf8')).toBe('replaced')
  })

  it('a stale change is detected across both paths', async () => {
    await writeFile(join(dir, 'real.txt'), 'hello')
    await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'))
    const owner = exec()
    await fs.read(await fs.resolve('real.txt'), READ_ALL, owner)
    await writeFile(join(dir, 'real.txt'), 'changed') // out-of-band via real path
    const linkTarget = await fs.resolve('link.txt')
    await expect(fs.edit(linkTarget, { oldString: 'hello', newString: 'bye', replaceAll: false }, owner))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })
})

describe('non-regular targets', () => {
  it('rejects writing onto a directory', async () => {
    const target = await fs.resolve('.') // the cwd dir
    await expect(fs.write(target, 'x', exec())).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('applyEdit rejects a target that vanished after the read', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    const owner = exec()
    const target = await fs.resolve('a.txt')
    const version = (await fs.read(target, READ_ALL, owner)).version
    await unlink(join(dir, 'a.txt'))
    await expect(fs.applyEdit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, { version }))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('applyEdit rejects a non-regular target', async () => {
    const target = await fs.resolve('.')
    await expect(fs.applyEdit(target, { oldString: 'a', newString: 'b', replaceAll: false }, { version: 'v' }))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
})

describe('HMR / disposal (defensive class D)', () => {
  it('disposing the fiber withdraws ctx.fs', async () => {
    const local = new Context()
    const fiber = await local.plugin(LocalFileSystem, { cwd: dir })
    expect(local.fs).toBeDefined()
    await fiber.dispose()
    expect(local.fs).toBeUndefined()
  })

  it('a fresh provider does not inherit recorded file state', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    const local = new Context()
    const owner = exec()
    const fiber = await local.plugin(LocalFileSystem, { cwd: dir })
    await (local.fs as LocalFileSystem).read(await local.fs.resolve('a.txt'), READ_ALL, owner)
    await fiber.dispose()

    await local.plugin(LocalFileSystem, { cwd: dir })
    const fs2 = local.fs as LocalFileSystem
    const target = await fs2.resolve('a.txt')
    // Same owner object, but state was released on disposal.
    await expect(fs2.edit(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, owner))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })
})
