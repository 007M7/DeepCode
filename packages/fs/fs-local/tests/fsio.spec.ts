/**
 * Cordis-free tests for the raw local-filesystem I/O: path resolution, probe,
 * whole-file/streamed text reads, binary/UTF-8 rejection, atomic-write temp
 * safety, literal edit matching, and line-ending handling. Line WINDOWING is
 * policy and lives in `dsh-file-context`, so it is not tested here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import {
  applyLiteralEdit,
  probe,
  readForEdit,
  readWholeText,
  resolveLocalTarget,
  restoreLineEndings,
  streamWholeText,
  writeFileAtomic,
} from '@deepseek-ai/dsh-fs-local'
import type { LocalTarget } from '@deepseek-ai/dsh-fs-local'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fsio-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const localTarget = (path: string): LocalTarget => ({ displayPath: path, targetKey: FsTargetKey(path) })

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of chunks) out += chunk
  return out
}

describe('resolveLocalTarget', () => {
  it('resolves a relative path from cwd and realpaths it', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hi')
    const target = await resolveLocalTarget(dir, 'a.txt')
    expect(target.displayPath).toBe(file)
    expect(target.targetKey).toBe(await realpath(file))
  })

  it('uses the realpathed parent + basename when the file does not exist (stable across create)', async () => {
    const target = await resolveLocalTarget(dir, 'missing.txt')
    expect(target.targetKey).toBe(join(await realpath(dir), 'missing.txt'))
  })

  it('two paths to the same file via a symlink share one targetKey', async () => {
    const real = join(dir, 'real.txt')
    await writeFile(real, 'hi')
    const link = join(dir, 'link.txt')
    await symlink(real, link)
    const viaReal = await resolveLocalTarget(dir, 'real.txt')
    const viaLink = await resolveLocalTarget(dir, 'link.txt')
    expect(viaLink.targetKey).toBe(viaReal.targetKey)
    expect(viaLink.displayPath).toBe(link)
  })

  it('falls back to the absolute path when even the parent dir is absent', async () => {
    const target = await resolveLocalTarget(dir, 'no-such-dir/child.txt')
    expect(target.targetKey).toBe(join(dir, 'no-such-dir', 'child.txt'))
  })

  it('rejects a blank path', async () => {
    await expect(resolveLocalTarget(dir, '   ')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('probe', () => {
  it('returns null for a missing path and metadata for a file', async () => {
    expect(await probe(join(dir, 'nope'))).toBeNull()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hi')
    const info = await probe(file)
    expect(info?.type).toBe('file')
    expect(info?.size).toBe(2)
    expect(typeof info?.version).toBe('string')
  })

  it('reports a directory and a non-regular type', async () => {
    const sub = join(dir, 'sub')
    await mkdir(sub)
    expect((await probe(sub))?.type).toBe('directory')
  })

  it('reports a socket/special file as type "other"', async () => {
    const sockPath = join(dir, 'sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(sockPath, () => { resolve() })
    })
    try {
      expect((await probe(sockPath))?.type).toBe('other')
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
})

describe('readWholeText', () => {
  it('reads a small file', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\nthree')
    expect(await readWholeText(localTarget(file))).toBe('one\ntwo\nthree')
  })

  it('rejects a missing file and a directory', async () => {
    await expect(readWholeText(localTarget(join(dir, 'nope')))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(readWholeText(localTarget(dir))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('rejects binary and invalid UTF-8', async () => {
    await writeFile(join(dir, 'bin'), Buffer.from([0x68, 0x00, 0x69]))
    await expect(readWholeText(localTarget(join(dir, 'bin')))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await writeFile(join(dir, 'bad'), Buffer.from([0x68, 0xff, 0x69]))
    await expect(readWholeText(localTarget(join(dir, 'bad')))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('honors a pre-aborted signal', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one')
    await expect(readWholeText(localTarget(file), AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('passes a live (non-aborted) signal through', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    expect(await readWholeText(localTarget(file), new AbortController().signal)).toBe('one\ntwo')
  })

  it('translates a mid-read AbortError into FS_ABORTED', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    const ac = new AbortController()
    // Abort after the synchronous entry check but before readFile runs (the
    // stat await yields control back here), so readFile rejects AbortError.
    const pending = readWholeText(localTarget(file), ac.signal)
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})

describe('streamWholeText', () => {
  it('streams the whole file as decoded text', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\nthree')
    expect(await collect(streamWholeText(localTarget(file)))).toBe('one\ntwo\nthree')
  })

  it('streams a large multi-chunk file correctly', async () => {
    const file = join(dir, 'big.txt')
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}: ${'x'.repeat(3000)}`).join('\n')
    await writeFile(file, content)
    expect(await collect(streamWholeText(localTarget(file)))).toBe(content)
  })

  it('rejects a missing file, directory, binary, and invalid UTF-8', async () => {
    await expect(collect(streamWholeText(localTarget(join(dir, 'nope'))))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(collect(streamWholeText(localTarget(dir)))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await writeFile(join(dir, 'bin'), Buffer.from([0x68, 0x00, 0x69]))
    await expect(collect(streamWholeText(localTarget(join(dir, 'bin'))))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await writeFile(join(dir, 'bad'), Buffer.from([0x68, 0xff, 0x69]))
    await expect(collect(streamWholeText(localTarget(join(dir, 'bad'))))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('honors a pre-aborted signal', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one')
    await expect(collect(streamWholeText(localTarget(file), AbortSignal.abort()))).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('passes a live (non-aborted) signal through the stream', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    expect(await collect(streamWholeText(localTarget(file), new AbortController().signal))).toBe('one\ntwo')
  })
})

describe('writeFileAtomic — temp-file safety', () => {
  it('writes through a private staging dir and owner-only temp file', async () => {
    const file = join(dir, 'a.txt')
    let inspected = false
    await writeFileAtomic(file, 'hello', 0o640, undefined, {
      inspectTemp: async ({ stagingDir, tempPath }) => {
        inspected = true
        expect((await stat(stagingDir)).mode & 0o777).toBe(0o700)
        expect((await stat(tempPath)).mode & 0o777).toBe(0o600)
      },
    })
    expect(inspected).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('hello')
    expect((await stat(file)).mode & 0o777).toBe(0o640)
    expect((await readdir(dir)).filter(n => n.includes('.tmp'))).toEqual([])
  })

  it('creates new files owner-only by default', async () => {
    const file = join(dir, 'a.txt')
    await writeFileAtomic(file, 'hello', undefined, undefined)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('opens staging paths exclusively — a pre-existing path is never clobbered', async () => {
    const file = join(dir, 'a.txt')
    const tempDirName = '.fixed-temp.tmpdir'
    await mkdir(join(dir, tempDirName))
    await writeFile(join(dir, tempDirName, 'PRECIOUS'), 'keep')
    await expect(
      writeFileAtomic(file, 'hello', undefined, undefined, { tempDirName: () => tempDirName }),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(dir, tempDirName, 'PRECIOUS'), 'utf8')).toBe('keep')
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates parent directories as needed', async () => {
    const file = join(dir, 'nested', 'deep', 'a.txt')
    await writeFileAtomic(file, 'hi', undefined, undefined)
    expect(await readFile(file, 'utf8')).toBe('hi')
  })

  it('passes a live (non-aborted) signal through the write', async () => {
    const file = join(dir, 'a.txt')
    await writeFileAtomic(file, 'hi', undefined, new AbortController().signal)
    expect(await readFile(file, 'utf8')).toBe('hi')
  })

  it('aborts before writing when the signal is already aborted', async () => {
    const file = join(dir, 'a.txt')
    await expect(writeFileAtomic(file, 'hi', undefined, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans up the temp file when the final rename fails', async () => {
    const sub = join(dir, 'occupied')
    await mkdir(sub)
    await expect(writeFileAtomic(sub, 'hi', undefined, undefined)).rejects.toBeInstanceOf(Error)
    expect((await readdir(dir)).filter(n => n.includes('.tmp'))).toEqual([])
  })
})

describe('applyLiteralEdit', () => {
  it('replaces a unique match', () => {
    expect(applyLiteralEdit('a b c', 'b', 'X', false, 'f')).toEqual({ content: 'a X c', replacements: 1 })
  })

  it('rejects zero matches', () => {
    expect(() => applyLiteralEdit('a b c', 'z', 'X', false, 'f')).toThrow(expect.objectContaining({ code: 'FS_EDIT_NOT_FOUND' }))
  })

  it('rejects an empty oldString without scanning forever', () => {
    expect(() => applyLiteralEdit('a b c', '', 'X', false, 'f')).toThrow(expect.objectContaining({ code: 'FS_EDIT_NOT_FOUND' }))
  })

  it('rejects multiple matches without replaceAll', () => {
    expect(() => applyLiteralEdit('a a a', 'a', 'X', false, 'f')).toThrow(expect.objectContaining({ code: 'FS_AMBIGUOUS_EDIT' }))
  })

  it('replaces all matches with replaceAll', () => {
    expect(applyLiteralEdit('a a a', 'a', 'X', true, 'f')).toEqual({ content: 'X X X', replacements: 3 })
  })

  it('matches across normalized line endings', () => {
    expect(applyLiteralEdit('one\ntwo', 'one\ntwo', 'x', false, 'f').replacements).toBe(1)
  })
})

describe('readForEdit + restoreLineEndings', () => {
  it('round-trips CRLF: matches on LF, writes back CRLF', async () => {
    const file = join(dir, 'crlf.txt')
    await writeFile(file, 'one\r\ntwo\r\n')
    const original = await readForEdit(file, file)
    expect(original.lineEndings).toBe('CRLF')
    const edited = applyLiteralEdit(original.content, 'two', 'TWO', false, file)
    expect(restoreLineEndings(edited.content, original.lineEndings)).toBe('one\r\nTWO\r\n')
  })

  it('rejects a binary file and invalid UTF-8', async () => {
    await writeFile(join(dir, 'bin'), Buffer.from([0x00, 0x01]))
    await expect(readForEdit(join(dir, 'bin'), join(dir, 'bin'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await writeFile(join(dir, 'bad'), Buffer.from([0x68, 0xff, 0x69]))
    await expect(readForEdit(join(dir, 'bad'), join(dir, 'bad'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('passes a live (non-aborted) signal through the read', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    const original = await readForEdit(file, file, new AbortController().signal)
    expect(original.content).toBe('one\ntwo')
  })

  it('translates a mid-read AbortError into FS_ABORTED', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    const ac = new AbortController()
    // Abort after the synchronous entry check, while readFile is pending.
    const pending = readForEdit(file, file, ac.signal)
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})
