/**
 * Integration tests: the real local backend (`dsh-fs-local`) plus the model
 * tools (`dsh-tool-fs`) as the executor, exercised through `ctx.tools.execute()`
 * so nothing bypasses the tool registry. Two deployments:
 *
 *  - DEFAULT — with the real `dsh-file-context` policy gate plugin: read-before-
 *    write/edit, version-guarded mutation, FS_NOT_OBSERVED for unread edits.
 *  - BARE — WITHOUT the policy plugin: every `fs/*` waterfall falls through to
 *    its undefined default, so write/edit are unconditional. This proves the
 *    tool carries no dependency on the policy plugin.
 *
 * These verify the WORLD — files are read back from disk and asserted
 * byte-for-byte — not the tool's self-report.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FileContext from '@deepseek-ai/dsh-file-context'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
// A stable session object stands in for an agent session (the file-state owner).
const session = {}

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

afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

// --------------------------------------------------------------------------
// DEFAULT deployment: the policy gate plugin is loaded.
// --------------------------------------------------------------------------
describe('default deployment (with dsh-file-context)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FileContext)
    fiber = await ctx.plugin(ToolFs)
  })

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
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original')
    })

    it('allows overwriting after a read', async () => {
      await writeFile(join(dir, 'a.txt'), 'original')
      expect((await call('read', { file_path: 'a.txt' })).isError).toBe(false)
      const result = await call('write', { file_path: 'a.txt', content: 'replaced' })
      expect(result.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('replaced')
    })

    it('rejects a full overwrite when the file changed since the read (stale)', async () => {
      await writeFile(join(dir, 'a.txt'), 'original')
      await call('read', { file_path: 'a.txt' })
      await writeFile(join(dir, 'a.txt'), 'changed-externally') // out-of-band change
      const result = await call('write', { file_path: 'a.txt', content: 'replaced' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ code: 'FS_STALE_VERSION' })
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

    it('paginates a multi-line file with offset/limit', async () => {
      await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour')
      const result = await call('read', { file_path: 'a.txt', offset: 2, limit: 2 })
      expect(text(result)).toContain('2: two')
      expect(text(result)).toContain('3: three')
      expect(text(result)).toContain('(Showing lines 2-3 of 4. Use offset=4 to continue.)')
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

    it('lets a WINDOWED read authorize an edit when the file is unchanged (freshness, not full-view)', async () => {
      // A file with more lines than the read window; read only the first line.
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
      await writeFile(join(dir, 'a.txt'), lines.join('\n'))
      const read = await call('read', { file_path: 'a.txt', offset: 1, limit: 1 })
      expect(read.isError).toBe(false)
      expect(text(read)).toContain('(Showing lines 1-1 of 20')

      // Editing a line OUTSIDE the window is authorized because the file is unchanged.
      const result = await call('edit', { file_path: 'a.txt', old_string: 'line 12', new_string: 'LINE 12' })
      expect(result.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe(lines.map(l => l === 'line 12' ? 'LINE 12' : l).join('\n'))
    })

    it('rejects an edit when the file changed since the windowed read (stale before matching)', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      await call('read', { file_path: 'a.txt', offset: 1, limit: 1 })
      await writeFile(join(dir, 'a.txt'), 'goodbye') // out-of-band change removes 'world'
      const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ code: 'FS_STALE_VERSION' })
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

  describe('the gate records only through the events (no method coupling)', () => {
    it('a direct ctx.fs.readText records no observed-state, so a later edit rejects', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      // Reach AROUND the tool — an explicit escape hatch for non-tool consumers.
      await ctx.fs.readText(await ctx.fs.resolve('a.txt'))
      // The model-facing edit still rejects: the read did not emit fs/observed.
      const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ code: 'FS_NOT_OBSERVED' })
    })
  })

  describe('stat budget', () => {
    it('read stats once; write and edit never stat in the tool (the gate stats zero too)', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      const statSpy = vi.spyOn(ctx.fs, 'stat')

      // read: exactly one stat (type + size routing + observed version).
      await call('read', { file_path: 'a.txt' })
      expect(statSpy).toHaveBeenCalledTimes(1)

      // edit (guarded, after the read): the gate supplies vObserved; the tool
      // does not stat to manufacture a basis. CAS happens in editText's lock.
      statSpy.mockClear()
      const edited = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(edited.isError).toBe(false)
      expect(statSpy).not.toHaveBeenCalled()

      // write (guarded replace, after the edit refreshed observed state): zero stat.
      statSpy.mockClear()
      const written = await call('write', { file_path: 'a.txt', content: 'fresh' })
      expect(written.isError).toBe(false)
      expect(statSpy).not.toHaveBeenCalled()
      statSpy.mockRestore()
    })
  })

  describe('contained fs/observed recording', () => {
    it('a synchronously throwing fs/observed listener does not fail the completed write', async () => {
      ctx.on('fs/observed', () => { throw new Error('listener boom') })
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const result = await call('write', { file_path: 'a.txt', content: 'hi' })
      // The write succeeded on disk; the listener throw was logged and swallowed.
      expect(result.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hi')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })
})

// --------------------------------------------------------------------------
// BARE deployment: the tool suite WITHOUT the policy gate.
// --------------------------------------------------------------------------
describe('bare provider (no dsh-file-context)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-bare-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    fiber = await ctx.plugin(ToolFs)
  })

  it('read works (it never needed policy)', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta')
    const result = await call('read', { file_path: 'a.txt' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('1: alpha')
  })

  it('write unconditionally creates a new file', async () => {
    const result = await call('write', { file_path: 'new.txt', content: 'fresh' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('fresh')
  })

  it('write unconditionally OVERWRITES an existing unread file', async () => {
    await writeFile(join(dir, 'a.txt'), 'original')
    const result = await call('write', { file_path: 'a.txt', content: 'clobbered' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('clobbered')
  })

  it('edit unconditionally edits an UNREAD existing file', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello there')
  })

  it('edit of a MISSING target reports FS_STALE_VERSION even on the unguarded path', async () => {
    const result = await call('edit', { file_path: 'missing.txt', old_string: 'a', new_string: 'b' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('edit still enforces literal-match codes (FS_EDIT_NOT_FOUND), unrelated to freshness', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const result = await call('edit', { file_path: 'a.txt', old_string: 'absent', new_string: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
  })

  it('neither write nor edit stats in the tool on the bare path', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const statSpy = vi.spyOn(ctx.fs, 'stat')
    expect((await call('write', { file_path: 'a.txt', content: 'x y' })).isError).toBe(false)
    expect((await call('edit', { file_path: 'a.txt', old_string: 'y', new_string: 'z' })).isError).toBe(false)
    expect(statSpy).not.toHaveBeenCalled()
    statSpy.mockRestore()
  })
})
