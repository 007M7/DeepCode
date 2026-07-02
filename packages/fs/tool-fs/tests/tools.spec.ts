/**
 * Consumer-surface tests for the filesystem tools as the EXECUTOR. They run the
 * REAL `@deepseek-ai/dsh-fs-policy` gate plugin (the genuine policy
 * collaborator, per the prefer-the-real-implementation rule) over a fake
 * `ctx.fs` provider, so they verify schemas, argument validation, result
 * formatting, FsError→isError propagation, and that each tool dispatches the
 * `fs/*` waterfalls + records observed-state through the gate (read authorizes a
 * later edit) — not just that it moved bytes.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { formatReadOutput, STREAM_MIN_SIZE } from '@deepseek-ai/dsh-tool-fs'
import type { FileReadOutcome } from '@deepseek-ai/dsh-tool-fs'

/** An in-memory fake provider; a test can arm a rejection on any primitive. */
class FakeFs extends FileSystem {
  files = new Map<string, string>()
  rejectWith?: FsError
  writeIntents: (FsWriteIntent | undefined)[] = []
  editIntents: ({ version: FsVersion } | undefined)[] = []

  private throwIfArmed(): void {
    if (this.rejectWith) throw this.rejectWith
  }

  override async resolve(path: string): Promise<FsTarget> {
    return { inputPath: path, targetKey: FsTargetKey(`key:${path}`), displayPath: `/abs/${path}` }
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    this.throwIfArmed()
    const content = this.files.get(target.targetKey)
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async readText(target: FsTarget): Promise<string> {
    return this.files.get(target.targetKey) ?? ''
  }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = this.files.get(target.targetKey) ?? ''
    return (async function* () { yield content })()
  }
  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    this.throwIfArmed()
    this.writeIntents.push(expected)
    const existed = this.files.has(target.targetKey)
    this.files.set(target.targetKey, content)
    return { operation: existed ? 'update' : 'create', version: FsVersion('v2') }
  }
  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }): Promise<FsEditOutcome> {
    this.throwIfArmed()
    this.editIntents.push(expected)
    const content = this.files.get(target.targetKey) ?? ''
    this.files.set(target.targetKey, content.split(edit.oldString).join(edit.newString))
    return { replacements: 1, replaceAll: edit.replaceAll, version: FsVersion('v3') }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(FakeFs)
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  const fs = ctx.fs as FakeFs
  return { ctx, fs }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: object) {
  return ctx.tools.execute({
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent: agent as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('registration', () => {
  it('registers read, write, and edit', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(s => s.name).sort()).toEqual(['edit', 'read', 'write'])
  })

  it('registers prompt sections for each tool', async () => {
    const { ctx } = await setup()
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Use the read tool')
    expect(prompt).toContain('Use the write tool')
    expect(prompt).toContain('Use the edit tool')
  })

  it('stays pending until ctx.fs exists (inject)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(ToolFs) // no fs provider
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('unregisters everything on fiber disposal (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(FakeFs)
    await ctx.plugin(FsPolicy)
    const fiber = await ctx.plugin(ToolFs)
    // Each tool contributes BOTH a schema and a prompt section; disposal must
    // withdraw both, not just the schemas.
    expect(ctx.tools.schemas()).toHaveLength(3)
    const sectionNames = (a: { sections: { name: string }[] }) => a.sections.map(s => s.name).sort()
    expect(sectionNames(await ctx.systemPrompt.assemble())).toEqual(['tool:edit', 'tool:read', 'tool:write'])
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    expect((await ctx.systemPrompt.assemble()).sections).toHaveLength(0)
  })
})

describe('read tool', () => {
  it('formats line-numbered content with a footer', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:a.txt', 'hello\nworld')
    const result = await call(ctx, 'read', { file_path: 'a.txt' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`<path>/abs/a.txt</path>
<type>file</type>
<content>
1: hello
2: world

(End of file - total 2 lines)
</content>`)
  })

  it('rejects a non-positive offset via arg validation', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'read', { file_path: 'a.txt', offset: 0 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('offset must be a positive integer')
  })

  it('rejects a fractional or NaN offset, and a zero/negative limit', async () => {
    const { ctx } = await setup()
    for (const args of [
      { file_path: 'a.txt', offset: 1.5 },
      { file_path: 'a.txt', offset: Number.NaN },
      { file_path: 'a.txt', limit: 0 },
      { file_path: 'a.txt', limit: -3 },
    ]) {
      const result = await call(ctx, 'read', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(text(result)).toMatch(/must be a positive integer/)
    }
  })

  it('rejects a limit above the cap', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'read', { file_path: 'a.txt', limit: 99999 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('less than or equal to 2000')
  })

  it('rejects a blank file_path', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'read', { file_path: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('file_path must be a non-empty string')
  })

  it('records observed state so a follow-up edit by the same session is authorized', async () => {
    const { ctx, fs } = await setup()
    const session = { header: {} }
    fs.files.set('key:a.txt', 'hello')
    expect((await call(ctx, 'read', { file_path: 'a.txt' }, { session })).isError).toBe(false)
    const edited = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'hello', new_string: 'bye' }, { session })
    expect(edited.isError).toBe(false)
    expect(fs.editIntents).toEqual([{ version: 'v1' }])
  })

  it('propagates FS_NOT_FOUND for an absent file', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'read', { file_path: 'missing.txt' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('rejects a non-regular target', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:d', '')
    fs.stat = async () => ({ version: FsVersion('v1'), type: 'directory' })
    const result = await call(ctx, 'read', { file_path: 'd' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('streams a large file (size at/above the cap) instead of reading whole', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:big.txt', 'alpha\nbeta')
    const readSpy = vi.spyOn(fs, 'readText')
    const streamSpy = vi.spyOn(fs, 'streamText')
    fs.stat = async () => ({ version: FsVersion('v1'), type: 'file', size: STREAM_MIN_SIZE })
    const result = await call(ctx, 'read', { file_path: 'big.txt' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('1: alpha')
    expect(streamSpy).toHaveBeenCalled()
    expect(readSpy).not.toHaveBeenCalled()
  })

  it('streams when the backend reports no size (never buffers a size-less file)', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:a.txt', 'alpha')
    const streamSpy = vi.spyOn(fs, 'streamText')
    fs.stat = async () => ({ version: FsVersion('v1'), type: 'file' }) // no size
    const result = await call(ctx, 'read', { file_path: 'a.txt' })
    expect(result.isError).toBe(false)
    expect(streamSpy).toHaveBeenCalled()
  })

  it('surfaces a byte-capped read as a truncated footer', async () => {
    const { ctx, fs } = await setup()
    // Many long lines so the window hits the byte cap before EOF.
    fs.files.set('key:big.txt', Array.from({ length: 2000 }, () => 'y'.repeat(100)).join('\n'))
    const result = await call(ctx, 'read', { file_path: 'big.txt' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Output capped.')
  })

})

describe('formatReadOutput footer variants', () => {
  const base: FileReadOutcome = { offset: 1, limit: 2000, lines: [{ number: 1, text: 'x' }], totalLines: 1, version: FsVersion('v') }

  it('reports a byte-capped read', () => {
    const out = formatReadOutput('/f', { ...base, totalLines: 99, truncatedByBytes: true })
    expect(out).toContain('(Output capped. Showing lines 1-1. Use offset=2 to continue.)')
  })

  it('reports a more-remaining page', () => {
    const out = formatReadOutput('/f', { ...base, totalLines: 99 })
    expect(out).toContain('(Showing lines 1-1 of 99. Use offset=2 to continue.)')
  })

  it('reports end-of-file', () => {
    expect(formatReadOutput('/f', base)).toContain('(End of file - total 1 lines)')
  })

  it('renders an empty file as just the footer', () => {
    const out = formatReadOutput('/f', { ...base, lines: [], totalLines: 0 })
    expect(out).toContain('(End of file - total 0 lines)')
    expect(out).not.toContain(': ')
  })
})

describe('write tool', () => {
  it('formats a create result and uses createIfAbsent (unobserved, with the gate)', async () => {
    const { ctx, fs } = await setup()
    const result = await call(ctx, 'write', { file_path: 'a.txt', content: 'hi' }, { session: { header: {} } })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Created file')
    expect(fs.writeIntents).toEqual([{ kind: 'createIfAbsent' }])
  })

  it('rejects a blank file_path', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'write', { file_path: '   ', content: 'hi' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('file_path must be a non-empty string')
  })

  it('propagates a backend FsError as an isError result carrying its code', async () => {
    const { ctx, fs } = await setup()
    fs.rejectWith = new FsError('blocked', 'FS_STALE_VERSION')
    const result = await call(ctx, 'write', { file_path: 'a.txt', content: 'hi' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ name: 'FsError', code: 'FS_STALE_VERSION' })
  })
})

describe('edit tool', () => {
  it('formats a single-replacement success after a read', async () => {
    const { ctx, fs } = await setup()
    const session = { header: {} }
    fs.files.set('key:a.txt', 'a')
    await call(ctx, 'read', { file_path: 'a.txt' }, { session })
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, { session })
    expect(text(result)).toBe('The file /abs/a.txt has been updated successfully.')
  })

  it('formats the replace_all success message distinctly', async () => {
    const { ctx, fs } = await setup()
    const session = { header: {} }
    fs.files.set('key:a.txt', 'a a a')
    await call(ctx, 'read', { file_path: 'a.txt' }, { session })
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: true }, { session })
    expect(text(result)).toBe('The file /abs/a.txt has been updated. All occurrences were successfully replaced.')
  })

  it('rejects identical old/new strings', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'x', new_string: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must differ')
  })

  it('rejects an empty old_string', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: '', new_string: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('old_string must be a non-empty string')
  })

  it('rejects a blank file_path', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'edit', { file_path: '  ', old_string: 'a', new_string: 'b' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('file_path must be a non-empty string')
  })

  it('propagates FS_NOT_OBSERVED when the file was never read (the gate decides)', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:a.txt', 'hello')
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, { session: { header: {} } })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })
})

describe('tool-owned presentation (pure presentCall)', () => {
  // presentCall is a pure display function of args (no I/O); it drives the ACP
  // card's title/kind and the `locations` an editor follows along to.
  const presentCall = async (name: string, args: unknown) => {
    const { ctx } = await setup()
    return ctx.tools.get(name)?.presentCall?.(args)
  }

  it('read: generic card titled by file with the read window, read kind, location with the offset line', async () => {
    expect(await presentCall('read', { file_path: 'src/a.ts', offset: 12, limit: 40 })).toEqual({
      card: 'generic', title: 'Read src/a.ts (12 - 51)', kind: 'read',
      locations: [{ path: 'src/a.ts', line: 12 }],
    })
  })

  it('read: bare title and line-1 location when offset/limit are unset', async () => {
    expect(await presentCall('read', { file_path: 'a.txt' })).toEqual({
      card: 'generic', title: 'Read a.txt', kind: 'read', locations: [{ path: 'a.txt', line: 1 }],
    })
  })

  it('read: "from line N" window when only offset is set', async () => {
    expect(await presentCall('read', { file_path: 'a.txt', offset: 5 })).toEqual({
      card: 'generic', title: 'Read a.txt (from line 5)', kind: 'read', locations: [{ path: 'a.txt', line: 5 }],
    })
  })

  it('write: diff card (new-file style, oldText null), location', async () => {
    expect(await presentCall('write', { file_path: 'out.txt', content: 'hello' })).toEqual({
      card: 'diff', title: 'Write out.txt',
      diffs: [{ path: 'out.txt', oldText: null, newText: 'hello' }],
      locations: [{ path: 'out.txt' }],
    })
  })

  it('read: a limit with no offset windows from line 1', async () => {
    expect(await presentCall('read', { file_path: 'a.txt', limit: 10 })).toEqual({
      card: 'generic', title: 'Read a.txt (1 - 10)', kind: 'read', locations: [{ path: 'a.txt', line: 1 }],
    })
  })

  it('edit: an empty old_string maps to oldText null (a whole-file replace diff)', async () => {
    // presentCall runs on replay of raw logged args, which parseEditArgs does not
    // gate — an empty old_string must still produce a valid diff (oldText null).
    expect(await presentCall('edit', { file_path: 'a.txt', old_string: '', new_string: 'seed' })).toEqual({
      card: 'diff', title: 'Edit a.txt',
      diffs: [{ path: 'a.txt', oldText: null, newText: 'seed' }],
      locations: [{ path: 'a.txt' }],
    })
  })
})
