/**
 * Consumer-surface tests for the filesystem tools. They run the REAL
 * `ctx.fileContext` policy service over a fake `ctx.fs` provider (the genuine
 * collaborator, per the prefer-the-real-implementation rule), so they verify
 * schemas, argument validation, result formatting, FsError→isError propagation,
 * and that each tool records observed-state through `ctx.fileContext` (the
 * no-bypass contract) — not just that it moved bytes.
 */

import { describe, expect, it } from 'vitest'
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
  FsWriteExpectation,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import FileContext from '@deepseek-ai/dsh-file-context'
import type { FileReadOutcome } from '@deepseek-ai/dsh-file-context'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { formatReadOutput } from '@deepseek-ai/dsh-tool-fs'

/** An in-memory fake provider; a test can arm a rejection on any primitive. */
class FakeFs extends FileSystem {
  files = new Map<string, string>()
  rejectWith?: FsError

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
  override async writeText(target: FsTarget, content: string, _expected: FsWriteExpectation): Promise<FsWriteOutcome> {
    this.throwIfArmed()
    const existed = this.files.has(target.targetKey)
    this.files.set(target.targetKey, content)
    return { operation: existed ? 'update' : 'create', version: FsVersion('v2') }
  }
  override async editText(target: FsTarget, edit: FsEditRequest): Promise<FsEditOutcome> {
    this.throwIfArmed()
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
  await ctx.plugin(FileContext)
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

  it('stays pending until ctx.fileContext exists (inject)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(ToolFs) // no fileContext provider
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('unregisters everything on fiber disposal (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(FakeFs)
    await ctx.plugin(FileContext)
    const fiber = await ctx.plugin(ToolFs)
    expect(ctx.tools.schemas()).toHaveLength(3)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
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
    const session = {}
    fs.files.set('key:a.txt', 'hello')
    expect((await call(ctx, 'read', { file_path: 'a.txt' }, { session })).isError).toBe(false)
    const edited = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'hello', new_string: 'bye' }, { session })
    expect(edited.isError).toBe(false)
  })

  it('propagates FS_NOT_FOUND for an absent file', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'read', { file_path: 'missing.txt' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_NOT_FOUND' })
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
  it('formats a create result', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'write', { file_path: 'a.txt', content: 'hi' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Created file')
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
    const session = {}
    fs.files.set('key:a.txt', 'a')
    await call(ctx, 'read', { file_path: 'a.txt' }, { session })
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, { session })
    expect(text(result)).toBe('The file /abs/a.txt has been updated successfully.')
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

  it('propagates FS_NOT_OBSERVED when the file was never read', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:a.txt', 'hello')
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, { session: {} })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })
})
