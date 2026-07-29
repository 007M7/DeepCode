import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'

const contexts: Context[] = []
const roots: string[] = []
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId(`str-replace-editor-owner-${callNumber}`)
  const scope = ctx.plugin(() => {})
  const value: Agent = {
    id,
    options: {},
    session: new Session(id, [], { version: 0, id, createdAt: 0, cwd }),
    status: 'idle',
    acceptsNextStep: false,
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function call(ctx: Context, owner: Agent | undefined, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`str-replace-editor-${++callNumber}`),
    name: 'str_replace_editor',
    arguments: args,
    ...owner === undefined ? {} : { agent: owner },
  })
}

async function setup(config: ToolStrReplaceEditor.Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-str-replace-editor-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(ToolStrReplaceEditor, config)
  return { ctx, root, owner: agent(ctx, root) }
}

describe('tool-str-replace-editor', () => {
  it('registers the standalone schema and configurable description', async () => {
    const { ctx } = await setup({ description: 'custom editor description' })
    const schema = ctx.tools.schemas()[0]
    expect(ctx.tools.schemas().map(item => item.name)).toEqual(['str_replace_editor'])
    expect(schema?.description).toBe('custom editor description')
    const properties = (schema?.parameters as {
      properties: Record<string, { type?: string; items?: { type?: string } }>
    }).properties
    expect(properties).not.toHaveProperty('replace_all')
    expect(properties.insert_line?.type).toBe('integer')
    expect(properties.view_range?.items?.type).toBe('integer')
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'view',
      path: '/workspace/a.txt',
    })).toMatchObject({ card: 'generic', kind: 'read' })
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'insert',
      path: '/workspace/a.txt',
      insert_line: 0,
      new_str: 'x',
    })).toMatchObject({ card: 'generic', kind: 'edit' })
  })

  it('creates, views, replaces, and inserts with the canonical model-facing output', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'sample.txt')
    expect(text(await call(ctx, owner, {
      command: 'create',
      path: sample,
      file_text: 'one\ntwo\nthree\n',
    }))).toBe(`New file created successfully at: ${sample}`)

    expect(text(await call(ctx, owner, {
      command: 'view',
      path: sample,
      view_range: [2, -1],
    }))).toBe([
      `Here's the content of ${sample} with line numbers (which has a total of 4 lines) with view_range=[2, -1]:`,
      '     2  two',
      '     3  three',
      '     4  ',
      '',
    ].join('\n'))

    expect(text(await call(ctx, owner, {
      command: 'str_replace',
      path: sample,
      old_str: 'two',
      new_str: 'TWO',
    }))).toBe(`The file ${sample} has been edited successfully.`)
    expect(text(await call(ctx, owner, {
      command: 'str_replace',
      path: sample,
      old_str: 'TWO',
    }))).toBe(`The file ${sample} has been edited successfully.`)
    expect(text(await call(ctx, owner, {
      command: 'insert',
      path: sample,
      insert_line: 1,
      new_str: 'between',
    }))).toBe(`The file ${sample} has been edited successfully.`)
    expect(await readFile(sample, 'utf8')).toBe('one\nbetween\n\nthree\n')
  })

  it('lists visible entries to depth two and clips at the configured view limit', async () => {
    const { ctx, root, owner } = await setup({ maxOutputChars: 10 })
    await mkdir(join(root, 'dir', 'nested', 'third'), { recursive: true })
    await mkdir(join(root, 'dir', 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, 'dir', '__pycache__'), { recursive: true })
    await writeFile(join(root, 'dir', 'visible.txt'), 'ok')
    await writeFile(join(root, 'dir', '.hidden'), 'hidden')
    await writeFile(join(root, 'dir', 'nested', 'child.txt'), 'child')
    await writeFile(join(root, 'dir', 'nested', 'third', 'too-deep.txt'), 'deep')
    await writeFile(join(root, 'dir', 'node_modules', 'pkg', 'index.js'), 'hidden dependency')
    await writeFile(join(root, 'dir', '__pycache__', 'module.pyc'), 'cache')
    const listDir = ctx.fs.listDir.bind(ctx.fs)
    const otherTarget = await ctx.fs.resolve(join(root, 'dir', 'other'))
    ctx.fs.listDir = async (target, signal) => {
      const entries = await listDir(target, signal)
      return target.displayPath === join(root, 'dir')
        ? [...entries, { name: 'other', type: 'other', target: otherTarget }]
        : entries
    }

    const listing = text(await call(ctx, owner, { command: 'view', path: join(root, 'dir') }))
    expect(listing).toContain('<response clipped>')
    expect(listing).not.toContain('.hidden')
    expect(listing).not.toContain('too-deep.txt')
    expect(listing).not.toContain('index.js')
    expect(listing).not.toContain('module.pyc')

    await writeFile(join(root, 'large.txt'), 'x'.repeat(100))
    expect(text(await call(ctx, owner, { command: 'view', path: join(root, 'large.txt') })))
      .toContain('<response clipped>')
  })

  it('matches canonical empty-line, range, and end-insert behavior', async () => {
    const { ctx, root, owner } = await setup()
    const empty = join(root, 'empty.txt')
    const newline = join(root, 'newline.txt')
    const plain = join(root, 'plain.txt')
    await writeFile(empty, '')
    await writeFile(newline, '\n')
    await writeFile(plain, 'one\ntwo')

    expect(text(await call(ctx, owner, { command: 'view', path: empty })))
      .toContain('(which has a total of 1 lines):\n     1  \n')
    expect(text(await call(ctx, owner, { command: 'view', path: newline })))
      .toContain('(which has a total of 2 lines):\n     1  \n     2  \n')
    expect(text(await call(ctx, owner, {
      command: 'view',
      path: plain,
      view_range: [1, 2],
    }))).toContain('     2  two')
    expect(text(await call(ctx, undefined, {
      command: 'view',
      path: plain,
    }))).toContain('     1  one')

    await call(ctx, owner, {
      command: 'insert',
      path: plain,
      insert_line: 2,
      new_str: 'three',
    })
    expect(await readFile(plain, 'utf8')).toBe('one\ntwo\nthree')

    await writeFile(newline, 'one\n')
    await call(ctx, owner, {
      command: 'insert',
      path: newline,
      insert_line: 2,
      new_str: 'three',
    })
    expect(await readFile(newline, 'utf8')).toBe('one\n\nthree')
  })

  it('uses old_str-only replacement failures and rejects relative paths', async () => {
    const { ctx, root, owner } = await setup()
    const ambiguous = join(root, 'ambiguous.txt')
    await writeFile(ambiguous, 'same\nother\nsame')

    const missing = await call(ctx, owner, {
      command: 'str_replace',
      path: ambiguous,
      old_str: 'absent',
      new_str: 'x',
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain(`old_str \`absent\` did not appear verbatim in ${ambiguous}`)
    expect(text(missing)).not.toContain('old_string')

    const repeated = await call(ctx, owner, {
      command: 'str_replace',
      path: ambiguous,
      old_str: 'same',
      new_str: 'x',
    })
    expect(repeated.isError).toBe(true)
    expect(text(repeated)).toContain('Multiple occurrences of old_str `same` in lines [1, 3]')
    expect(text(repeated)).not.toContain('replace_all')

    const relative = await call(ctx, owner, { command: 'view', path: 'ambiguous.txt' })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toContain('is not an absolute path')
    expect(await readFile(ambiguous, 'utf8')).toBe('same\nother\nsame')
  })

  it('reports invalid commands or arguments without mutating files', async () => {
    const { ctx, root, owner } = await setup()
    const ambiguous = join(root, 'ambiguous.txt')
    const empty = join(root, 'empty.txt')
    const trailingNewline = join(root, 'trailing-newline.txt')
    const threeLines = join(root, 'three-lines.txt')
    const directory = join(root, 'directory')
    await writeFile(ambiguous, 'same same')
    await writeFile(empty, '')
    await writeFile(trailingNewline, 'one\n')
    await writeFile(threeLines, 'one\ntwo\nthree')
    await mkdir(directory)

    const cases = [
      { command: 'view', path: '' },
      { command: 'view', path: join(root, 'missing.txt') },
      { command: 'view', path: ambiguous, view_range: [1] },
      { command: 'view', path: ambiguous, view_range: [0, 1] },
      { command: 'view', path: ambiguous, view_range: [1.5, 2] },
      { command: 'view', path: threeLines, view_range: [1, 99] },
      { command: 'view', path: threeLines, view_range: [2, 1] },
      { command: 'view', path: directory, view_range: [1, 1] },
      { command: 'create', path: join(root, 'new.txt') },
      { command: 'create', path: ambiguous, file_text: 'overwrite' },
      { command: 'str_replace', path: ambiguous, new_str: 'x' },
      { command: 'str_replace', path: ambiguous, old_str: '', new_str: 'x' },
      { command: 'insert', path: ambiguous, new_str: 'x' },
      { command: 'insert', path: ambiguous, insert_line: -1, new_str: 'x' },
      { command: 'insert', path: ambiguous, insert_line: 1.5, new_str: 'x' },
      { command: 'insert', path: ambiguous, insert_line: 99, new_str: 'x' },
      { command: 'insert', path: empty, insert_line: 2, new_str: 'x' },
      { command: 'insert', path: directory, insert_line: 0, new_str: 'x' },
    ]
    for (const args of cases) {
      expect((await call(ctx, owner, args)).isError).toBe(true)
    }
    expect(await readFile(ambiguous, 'utf8')).toBe('same same')

    ctx.fs.stat = async () => ({ version: FsVersion('special'), type: 'other' })
    const special = await call(ctx, owner, { command: 'view', path: join(root, 'special') })
    expect(special.isError).toBe(true)
    expect(special.error).toMatchObject({ info: { code: 'FS_NOT_REGULAR_FILE' } })
    expect((await call(ctx, owner, {
      command: 'str_replace',
      path: join(root, 'special'),
      old_str: 'x',
      new_str: 'y',
    })).error).toMatchObject({ info: { code: 'FS_NOT_REGULAR_FILE' } })
    expect((await call(ctx, owner, {
      command: 'insert',
      path: join(root, 'special'),
      insert_line: 0,
      new_str: 'x',
    })).error).toMatchObject({ info: { code: 'FS_NOT_REGULAR_FILE' } })
  })

  it('can opt into session-relative paths for non-canonical deployments', async () => {
    const { ctx, root, owner } = await setup({ requireAbsolutePath: false })
    await writeFile(join(root, 'relative.txt'), 'relative')
    expect(text(await call(ctx, owner, { command: 'view', path: 'relative.txt' })))
      .toContain("Here's the content of")
  })

  it('rejects invalid plugin config', () => {
    expect(() => {
      ToolStrReplaceEditor.apply(new Context(), { maxOutputChars: 0 })
    }).toThrow('maxOutputChars must be a positive safe integer')
    expect(() => {
      ToolStrReplaceEditor.apply(new Context(), { description: ' ' })
    }).toThrow('description must be non-empty')
  })
})
