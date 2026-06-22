/**
 * Integration tests: the real local backend (`dsh-fs-local`) plus the model
 * tools (`dsh-tool-fs`), exercised through `ctx.tools.execute()` so nothing
 * bypasses the tool registry. These verify the WORLD — files are read back from
 * disk and asserted byte-for-byte — not the tool's self-report.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
// A stable session object stands in for an agent session (the file-state owner).
const session = {}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  fiber = await ctx.plugin(ToolFs)
})
afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

let callCounter = 0
function call(name: string, args: unknown) {
  return ctx.tools.execute({
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session } as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('write → disk', () => {
  it('creates a file with exactly the requested bytes', async () => {
    const result = await call('write', { file_path: 'new.txt', content: 'line one\nline two\n' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('line one\nline two\n')
  })

  it('rejects overwriting an existing file without reading it first', async () => {
    await writeFile(join(dir, 'a.txt'), 'original')
    const result = await call('write', { file_path: 'a.txt', content: 'clobber' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_NOT_OBSERVED' })
    // The world is unchanged.
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original')
  })

  it('allows overwriting after a read', async () => {
    await writeFile(join(dir, 'a.txt'), 'original')
    expect((await call('read', { file_path: 'a.txt' })).isError).toBe(false)
    const result = await call('write', { file_path: 'a.txt', content: 'replaced' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('replaced')
  })
})

describe('read', () => {
  it('returns line-numbered content', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta')
    const result = await call('read', { file_path: 'a.txt' })
    expect(text(result)).toContain('1: alpha')
    expect(text(result)).toContain('2: beta')
    expect(text(result)).toContain('(End of file - total 2 lines)')
  })

  it('reports a binary file as an error', async () => {
    await writeFile(join(dir, 'bin'), Buffer.from([0x00, 0x01, 0x02]))
    const result = await call('read', { file_path: 'bin' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_NOT_TEXT' })
  })
})

describe('edit → disk', () => {
  it('applies a unique literal replacement after a read', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    await call('read', { file_path: 'a.txt' })
    const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello there')
  })

  it('rejects an edit before any read, leaving the file untouched', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello world')
  })

  it('rejects an edit after only a partial read, leaving the file untouched', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello\nworld')
    await call('read', { file_path: 'a.txt', offset: 1, limit: 1 })
    const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_PARTIAL_OBSERVATION' })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello\nworld')
  })

  it('rejects an ambiguous match without replace_all', async () => {
    await writeFile(join(dir, 'a.txt'), 'a a a')
    await call('read', { file_path: 'a.txt' })
    const result = await call('edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a a a')
  })

  it('replaces all matches with replace_all', async () => {
    await writeFile(join(dir, 'a.txt'), 'a a a')
    await call('read', { file_path: 'a.txt' })
    const result = await call('edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: true })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('b b b')
  })

  it('supports a full write→edit cycle without an intervening read', async () => {
    await call('write', { file_path: 'a.txt', content: 'one two' })
    const result = await call('edit', { file_path: 'a.txt', old_string: 'two', new_string: 'three' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one three')
  })
})
