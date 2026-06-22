/**
 * Consumer-surface tests for the filesystem tools using a fake `ctx.fs` that
 * records the execution context it received and returns canned outcomes. These
 * verify schemas, argument validation, result formatting, FsError→isError
 * propagation, and that each tool passes `exec` straight through to `ctx.fs`.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsExecContext,
  FsReadOutcome,
  FsReadRequest,
  FsTarget,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { formatReadOutput } from '@deepseek-ai/dsh-tool-fs'

/**
 * Records the public-API calls (and the exec each received) and returns canned
 * outcomes; lets a test arm a rejection. Overrides the public methods directly
 * (not the primitives) so we observe exactly what the tool passed.
 */
class FakeFs extends FileSystem {
  calls: Array<{ op: string; exec: FsExecContext | undefined; target: FsTarget }> = []
  rejectWith?: FsError

  override async resolve(path: string): Promise<FsTarget> {
    return { inputPath: path, targetKey: `key:${path}`, displayPath: `/abs/${path}` }
  }

  override async readPage(): Promise<FsReadOutcome> {
    throw new Error('not used: tool tests override read()')
  }
  override async createOrReplace(): Promise<FsWriteOutcome> {
    throw new Error('not used')
  }
  override async applyEdit(): Promise<FsEditOutcome> {
    throw new Error('not used')
  }

  override async read(target: FsTarget, _request: FsReadRequest, exec?: FsExecContext): Promise<FsReadOutcome> {
    this.calls.push({ op: 'read', exec, target })
    if (this.rejectWith) throw this.rejectWith
    return {
      offset: 1,
      limit: 2000,
      lines: [{ number: 1, text: 'hello' }, { number: 2, text: 'world' }],
      totalLines: 2,
      version: 'v1',
      view: 'full',
    }
  }

  override async write(target: FsTarget, _content: string, exec?: FsExecContext): Promise<FsWriteOutcome> {
    this.calls.push({ op: 'write', exec, target })
    if (this.rejectWith) throw this.rejectWith
    return { operation: 'create', version: 'v1' }
  }

  override async edit(target: FsTarget, _edit: FsEditRequest, exec?: FsExecContext): Promise<FsEditOutcome> {
    this.calls.push({ op: 'edit', exec, target })
    if (this.rejectWith) throw this.rejectWith
    return { replacements: 1, replaceAll: false, version: 'v1' }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(FakeFs)
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
    const fiber = await ctx.plugin(ToolFs)
    expect(ctx.tools.schemas()).toHaveLength(3)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
  })
})

describe('read tool', () => {
  it('formats line-numbered content with a footer', async () => {
    const { ctx } = await setup()
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

  it('passes the execution context through to ctx.fs', async () => {
    const { ctx, fs } = await setup()
    const session = {}
    await call(ctx, 'read', { file_path: 'a.txt' }, { session })
    expect(fs.calls).toHaveLength(1)
    expect(fs.calls[0]?.op).toBe('read')
    expect(fs.calls[0]?.exec?.agent?.session).toBe(session)
  })
})

describe('formatReadOutput footer variants', () => {
  const base = { offset: 1, limit: 2000, lines: [{ number: 1, text: 'x' }], totalLines: 1, version: 'v', view: 'full' as const }

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
  it('formats a single-replacement success', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })
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

  it('propagates FS_NOT_OBSERVED from the backend', async () => {
    const { ctx, fs } = await setup()
    fs.rejectWith = new FsError('read first', 'FS_NOT_OBSERVED')
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('propagates FS_PARTIAL_OBSERVATION from the backend', async () => {
    const { ctx, fs } = await setup()
    fs.rejectWith = new FsError('read fully first', 'FS_PARTIAL_OBSERVATION')
    const result = await call(ctx, 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'FS_PARTIAL_OBSERVATION' })
  })
})
