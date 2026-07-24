import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import { type Agent } from '@deepseek-ai/dsh-agent'

import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-todo` on a real `ToolRegistry`
 * and invokes the registered `todo_write` tool through `ctx.tools.execute`,
 * with a fake parent Agent carrying a real `Session` — so the append the tool
 * makes is observable on a genuine session log (only the agent wrapper is a
 * stand-in; the session and the tool are the shipping code).
 */

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = new Session(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(tool)
  return ctx
}

let callCounter = 0
function callTodo(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'todo_write',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-todo', () => {
  it('registers a `todo_write` tool whose schema is an array of {content,status}', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'todo_write')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['todos'])
    const todos = props.todos as { type: string; items?: { properties?: Record<string, { type: string; enum?: string[] }> } }
    expect(todos.type).toBe('array')
    const itemProps = todos.items?.properties ?? {}
    expect(Object.keys(itemProps).sort()).toEqual(['content', 'status'])
    expect(itemProps.status?.enum).toEqual(['pending', 'in_progress', 'completed'])
  })

  it('appends a todo/write event carrying the whole list to the calling session', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer')
    const todos: TodoItem[] = [
      { content: 'plan', status: 'in_progress' },
      { content: 'build', status: 'pending' },
    ]
    const result = await callTodo(ctx, { todos }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected todo_write success')
    expect(result.value).toEqual({
      todos,
      counts: { pending: 1, inProgress: 1, completed: 0 },
    })
    expect(text(result)).toContain('1 pending, 1 in progress, 0 completed')

    const event = agent.session.events.findLast(e => e.type === 'todo/write')!
    expect(event.data.todos).toEqual(todos)
  })

  it('stores the trimmed content (the dedupe/length key), not the raw input', async () => {
    const ctx = await setup()
    const agent = agentWithSession('trim')
    const result = await callTodo(ctx, { todos: [{ content: '  plan the work  ', status: 'pending' }] }, { agent })
    expect(result.isError).toBe(false)

    const event = agent.session.events.findLast(e => e.type === 'todo/write')!
    expect(event.data.todos).toEqual([{ content: 'plan the work', status: 'pending' }])
  })

  it('replaces the list on a second call (last-write-wins on the log)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer-2')
    await callTodo(ctx, { todos: [{ content: 'a', status: 'pending' }] }, { agent })
    await callTodo(ctx, { todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ] }, { agent })

    const current = agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos
    expect(current).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ])
  })

  it('rejects a malformed status before execute runs (registry arg-validation)', async () => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos: [{ content: 'x', status: 'doing' }] })
    expect(result.isError).toBe(true)
  })

  it('rejects a non-array todos argument', async () => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos: 'nope' })
    expect(result.isError).toBe(true)
  })

  it.each([
    { label: 'empty content', todos: [{ content: '   ', status: 'pending' }], fragment: 'non-empty' },
    { label: 'duplicate content', todos: [{ content: 'dup', status: 'pending' }, { content: 'dup', status: 'completed' }], fragment: 'duplicate' },
    { label: 'two in_progress', todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }], fragment: 'in_progress' },
    { label: 'unknown item keys', todos: [{ content: 'a', status: 'pending', children: [] }], fragment: 'not a declared property' },
  ])('rejects $label as an isError result', async ({ todos, fragment }) => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
  })

  it('rejects a non-agent caller (the list has no owning session)', async () => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos: [{ content: 'a', status: 'pending' }] }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  it('presents the call with a stable title and the list as raw input', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('todo_write')!
    const todos = [{ content: 'a', status: 'pending' }]
    expect(def.presentCall?.({ todos })).toEqual({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: todos })
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(s => s.name === 'todo_write')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'todo_write')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-todo')
    expect(tool.inject).toEqual(['tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-todo')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
