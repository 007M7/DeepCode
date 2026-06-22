/**
 * Cordis-free tests for the raw local-filesystem I/O: path resolution,
 * fast/streaming reads, pagination/caps, binary rejection, atomic-write temp
 * safety, literal edit matching, and line-ending handling.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyLiteralEdit,
  formatReadBody,
  probe,
  readForEdit,
  readTextPage,
  resolveLocalTarget,
  restoreLineEndings,
  writeFileAtomic,
} from '@deepseek-ai/dsh-fs-local'
import type { LocalTarget } from '@deepseek-ai/dsh-fs-local'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fsio-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const READ_ALL = { offset: 1, limit: 2000 }
const localTarget = (path: string): LocalTarget => ({ displayPath: path, targetKey: path })

describe('resolveLocalTarget', () => {
  it('resolves a relative path from cwd and realpaths it', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hi')
    const target = await resolveLocalTarget(dir, 'a.txt')
    expect(target.displayPath).toBe(file)
    expect(target.targetKey).toBe(await (await import('node:fs/promises')).realpath(file))
  })

  it('uses the realpathed parent + basename when the file does not exist (stable across create)', async () => {
    const { realpath } = await import('node:fs/promises')
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

describe('readTextPage', () => {
  it('reads a small file with line numbers and full view', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\nthree')
    const result = await readTextPage(localTarget(file), READ_ALL)
    expect(result.lines).toEqual([
      { number: 1, text: 'one' },
      { number: 2, text: 'two' },
      { number: 3, text: 'three' },
    ])
    expect(result.totalLines).toBe(3)
    expect(result.view).toBe('full')
  })

  it('paginates with offset/limit and reports a partial view', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\nthree\nfour')
    const result = await readTextPage(localTarget(file), { offset: 2, limit: 2 })
    expect(result.lines.map(l => l.number)).toEqual([2, 3])
    expect(result.view).toBe('partial')
    expect(formatReadBody(result, 2)).toContain('(Showing lines 2-3 of 4. Use offset=4 to continue.)')
  })

  it('a whole-file read from offset 1 is a full view; offset>1 is partial', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    expect((await readTextPage(localTarget(file), { offset: 1, limit: 10 })).view).toBe('full')
    expect((await readTextPage(localTarget(file), { offset: 2, limit: 10 })).view).toBe('partial')
  })

  it('truncates an over-long line', async () => {
    const file = join(dir, 'long.txt')
    await writeFile(file, 'x'.repeat(3000))
    const result = await readTextPage(localTarget(file), READ_ALL)
    expect(result.lines[0]?.text).toContain('... (line truncated to 2000 chars)')
    expect(result.view).toBe('partial')
  })

  it('caps output bytes and reports truncatedByBytes', async () => {
    const file = join(dir, 'big.txt')
    const lines = Array.from({ length: 2000 }, () => 'y'.repeat(100))
    await writeFile(file, lines.join('\n'))
    const result = await readTextPage(localTarget(file), READ_ALL)
    expect(result.truncatedByBytes).toBe(true)
    expect(formatReadBody(result, 1)).toContain('Output capped at 50 KB')
  })

  it('strips CRLF so a Windows file reads like LF', async () => {
    const file = join(dir, 'crlf.txt')
    await writeFile(file, 'one\r\ntwo\r\n')
    const result = await readTextPage(localTarget(file), READ_ALL)
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
  })

  it('reads an empty file at offset 1', async () => {
    const file = join(dir, 'empty.txt')
    await writeFile(file, '')
    const result = await readTextPage(localTarget(file), READ_ALL)
    expect(result.lines).toEqual([])
    expect(result.totalLines).toBe(0)
    expect(formatReadBody(result, 1)).toBe('(End of file - total 0 lines)')
  })

  it('rejects an offset past EOF', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    await expect(readTextPage(localTarget(file), { offset: 9, limit: 1 })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('rejects a binary file (fast path)', async () => {
    const file = join(dir, 'bin')
    await writeFile(file, Buffer.from([0x68, 0x00, 0x69]))
    await expect(readTextPage(localTarget(file), READ_ALL)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('rejects invalid UTF-8 bytes (fast path)', async () => {
    const file = join(dir, 'invalid-utf8.txt')
    await writeFile(file, Buffer.from([0x68, 0xff, 0x69]))
    await expect(readTextPage(localTarget(file), READ_ALL)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('rejects a missing file and a directory', async () => {
    await expect(readTextPage(localTarget(join(dir, 'nope')), READ_ALL)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(readTextPage(localTarget(dir), READ_ALL)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('honors a pre-aborted signal', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one')
    await expect(readTextPage(localTarget(file), READ_ALL, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('passes a live (non-aborted) signal through the fast path', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    const result = await readTextPage(localTarget(file), READ_ALL, new AbortController().signal)
    expect(result.totalLines).toBe(2)
  })

  describe('streaming path (forced via a tiny fastPathMaxSize)', () => {
    const stream = { fastPathMaxSize: 1 }

    it('reads and paginates large files the same way', async () => {
      const file = join(dir, 'a.txt')
      await writeFile(file, 'one\ntwo\nthree')
      const result = await readTextPage(localTarget(file), { offset: 2, limit: 1 }, undefined, stream)
      expect(result.lines).toEqual([{ number: 2, text: 'two' }])
      expect(result.totalLines).toBe(3)
    })

    it('rejects a binary file on the streaming path', async () => {
      const file = join(dir, 'bin')
      await writeFile(file, Buffer.from([0x68, 0x00, 0x69]))
      await expect(readTextPage(localTarget(file), READ_ALL, undefined, stream)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    })

    it('caps a newline-free giant line without unbounded buffering', async () => {
      const file = join(dir, 'one-line.txt')
      await writeFile(file, 'z'.repeat(5000))
      const result = await readTextPage(localTarget(file), READ_ALL, undefined, stream)
      expect(result.lines[0]?.text).toContain('... (line truncated to 2000 chars)')
      expect(result.view).toBe('partial')
    })

    it('rejects invalid UTF-8 bytes on the streaming path', async () => {
      const file = join(dir, 'invalid-utf8.txt')
      await writeFile(file, Buffer.from([0x68, 0xff, 0x69]))
      await expect(readTextPage(localTarget(file), READ_ALL, undefined, stream)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    })

    it('honors abort on the streaming path', async () => {
      const file = join(dir, 'a.txt')
      await writeFile(file, 'one\ntwo')
      await expect(readTextPage(localTarget(file), READ_ALL, AbortSignal.abort(), stream)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    })

    it('caps output bytes mid-stream', async () => {
      const file = join(dir, 'big.txt')
      await writeFile(file, Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n'))
      const result = await readTextPage(localTarget(file), READ_ALL, undefined, stream)
      expect(result.truncatedByBytes).toBe(true)
    })

    it('flushes a final line with no trailing newline', async () => {
      const file = join(dir, 'no-nl.txt')
      await writeFile(file, 'one\ntwo') // no trailing \n
      const result = await readTextPage(localTarget(file), READ_ALL, undefined, stream)
      expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
    })

    it('handles a trailing newline (no dangling buffer at EOF)', async () => {
      const file = join(dir, 'nl.txt')
      await writeFile(file, 'one\ntwo\n') // trailing \n → empty buffer at end
      const result = await readTextPage(localTarget(file), READ_ALL, undefined, stream)
      expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
      expect(result.totalLines).toBe(2)
    })

    it('passes a live (non-aborted) signal through to the stream', async () => {
      const file = join(dir, 'a.txt')
      await writeFile(file, 'one\ntwo')
      const result = await readTextPage(localTarget(file), READ_ALL, new AbortController().signal, stream)
      expect(result.totalLines).toBe(2)
    })

    it('scans across multiple stream chunks', async () => {
      // A file well past the default 64 KB stream highWaterMark yields multiple chunks,
      // exercising the non-first-chunk branch and the line-buffer cap across appends.
      const file = join(dir, 'multi.txt')
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}: ${'x'.repeat(3000)}`)
      await writeFile(file, lines.join('\n'))
      const result = await readTextPage(localTarget(file), { offset: 1, limit: 3 }, undefined, stream)
      expect(result.lines[0]?.text.startsWith('line 0:')).toBe(true)
      expect(result.lines[0]?.text).toContain('... (line truncated to 2000 chars)')
      expect(result.totalLines).toBeGreaterThanOrEqual(3)
    })
  })
})

describe('writeFileAtomic — temp-file safety (defensive class A)', () => {
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
    const info = await stat(file)
    expect(info.mode & 0o777).toBe(0o640)
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
    // The pre-existing staging dir is intact and the target was not created.
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
    await mkdir(sub) // rename(temp, sub) fails because sub is a non-empty/dir target
    await expect(writeFileAtomic(sub, 'hi', undefined, undefined)).rejects.toBeInstanceOf(Error)
    // No leftover staging dirs in the directory.
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

  it('rejects a binary file', async () => {
    const file = join(dir, 'bin')
    await writeFile(file, Buffer.from([0x00, 0x01]))
    await expect(readForEdit(file, file)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('rejects invalid UTF-8 bytes', async () => {
    const file = join(dir, 'invalid-utf8.txt')
    await writeFile(file, Buffer.from([0x68, 0xff, 0x69]))
    await expect(readForEdit(file, file)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('passes a live (non-aborted) signal through the read', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    const original = await readForEdit(file, file, new AbortController().signal)
    expect(original.content).toBe('one\ntwo')
  })
})

describe('probe', () => {
  it('returns null for a missing path and info for a file', async () => {
    expect(await probe(join(dir, 'nope'))).toBeNull()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hi')
    const info = await probe(file)
    expect(info?.isFile).toBe(true)
    expect(typeof info?.version).toBe('string')
  })

  it('marks a directory as not a regular file', async () => {
    const sub = join(dir, 'sub')
    await mkdir(sub)
    expect((await probe(sub))?.isFile).toBe(false)
  })
})
