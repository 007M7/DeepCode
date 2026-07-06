/**
 * Cordis-free tests for the line-windowing module: offset/limit windows, byte
 * caps, per-line truncation, CRLF stripping, offset-past-EOF rejection, and the
 * capped line buffer for newline-free giant lines — all over an async-iterable
 * of decoded text chunks (so one code path serves whole-file and streamed reads).
 */

import { describe, expect, it } from 'vitest'
import { buildWindow, READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from '@deepseek-ai/dsh-tool-fs'
import type { ReadWindow } from '@deepseek-ai/dsh-tool-fs'

const DEFAULT_CAPS = { maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES }
const READ_ALL: ReadWindow = { offset: 1, limit: 2000, ...DEFAULT_CAPS }

/** Yield `text` as one chunk (whole-file read shape). */
async function* whole(text: string): AsyncIterable<string> {
  yield text
}

/** Yield `text` split into fixed-size chunks (streamed read shape). */
async function* chunked(text: string, size: number): AsyncIterable<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}

describe('buildWindow', () => {
  it('numbers lines and reports total for a whole-file read', async () => {
    const result = await buildWindow(whole('one\ntwo\nthree'), READ_ALL, 'f')
    expect(result.lines).toEqual([
      { number: 1, text: 'one' },
      { number: 2, text: 'two' },
      { number: 3, text: 'three' },
    ])
    expect(result.totalLines).toBe(3)
    expect(result.truncatedByBytes).toBe(false)
  })

  it('applies offset/limit', async () => {
    const result = await buildWindow(whole('one\ntwo\nthree\nfour'), { offset: 2, limit: 2, ...DEFAULT_CAPS }, 'f')
    expect(result.lines.map(l => l.number)).toEqual([2, 3])
    expect(result.totalLines).toBe(4)
  })

  it('strips CRLF', async () => {
    const result = await buildWindow(whole('one\r\ntwo\r\n'), READ_ALL, 'f')
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
  })

  it('truncates an over-long line', async () => {
    const result = await buildWindow(whole('x'.repeat(3000)), READ_ALL, 'f')
    expect(result.lines[0]?.text).toContain(`... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`)
  })

  it('caps output bytes and reports truncatedByBytes', async () => {
    const big = Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n')
    const result = await buildWindow(whole(big), READ_ALL, 'f')
    expect(result.truncatedByBytes).toBe(true)
  })

  it('reads an empty file at offset 1 as zero lines', async () => {
    const result = await buildWindow(whole(''), READ_ALL, 'f')
    expect(result.lines).toEqual([])
    expect(result.totalLines).toBe(0)
  })

  it('rejects an offset past EOF', async () => {
    await expect(buildWindow(whole('one\ntwo'), { offset: 9, limit: 1, ...DEFAULT_CAPS }, 'f')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('flushes a final line with no trailing newline', async () => {
    const result = await buildWindow(whole('one\ntwo'), READ_ALL, 'f')
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
  })

  it('handles a trailing newline (no dangling empty line)', async () => {
    const result = await buildWindow(whole('one\ntwo\n'), READ_ALL, 'f')
    expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
    expect(result.totalLines).toBe(2)
  })

  describe('caps are per-request (the plugin config reaches the window)', () => {
    it('truncates lines at a custom maxLineLength and names it in the suffix', async () => {
      const result = await buildWindow(whole('abcdefghij'), { offset: 1, limit: 10, maxLineLength: 5, maxBytes: READ_MAX_BYTES }, 'f')
      expect(result.lines[0]?.text).toBe('abcde... (line truncated to 5 chars)')
    })

    it('caps output at a custom maxBytes', async () => {
      const result = await buildWindow(whole('aaaa\nbbbb\ncccc'), { offset: 1, limit: 10, maxLineLength: 2000, maxBytes: 9 }, 'f')
      expect(result.lines.map(l => l.text)).toEqual(['aaaa', 'bbbb'])
      expect(result.truncatedByBytes).toBe(true)
    })
  })

  describe('chunked input (streamed read shape)', () => {
    it('windows identically when text arrives in small chunks', async () => {
      const result = await buildWindow(chunked('one\ntwo\nthree', 2), { offset: 2, limit: 1, ...DEFAULT_CAPS }, 'f')
      expect(result.lines).toEqual([{ number: 2, text: 'two' }])
      expect(result.totalLines).toBe(3)
    })

    it('caps a newline-free giant line split across chunks without unbounded buffering', async () => {
      const result = await buildWindow(chunked('z'.repeat(5000), 256), READ_ALL, 'f')
      expect(result.lines[0]?.text).toContain(`... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`)
    })

    it('caps output bytes mid-stream', async () => {
      const big = Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n')
      const result = await buildWindow(chunked(big, 512), READ_ALL, 'f')
      expect(result.truncatedByBytes).toBe(true)
    })

    it('flushes a final newline-terminated line across a chunk boundary', async () => {
      const result = await buildWindow(chunked('one\ntwo\n', 3), READ_ALL, 'f')
      expect(result.lines.map(l => l.text)).toEqual(['one', 'two'])
    })
  })
})
