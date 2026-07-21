import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as TodoInvariant from '@deepseek-ai/dsh-tool-todo/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(TodoInvariant)
  return ctx
}

function event(todos: unknown): SessionEvent {
  return { type: 'todo/write', seq: 0, time: 0, data: { todos } } as SessionEvent
}

describe('todo snapshot invariants', () => {
  it('accepts a unique whole-list snapshot with one active item', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event([
      { content: 'Inspect state', status: 'completed' },
      { content: 'Apply fix', status: 'in_progress' },
      { content: 'Run checks', status: 'pending' },
    ])) }).not.toThrow()
  })

  it.each([
    ['not-an-array', /must be an array/],
    [[null], /entries must be objects/],
    [[42], /entries must be objects/],
    [[{ content: 42, status: 'pending' }], /content must be non-empty/],
    [[{ content: '', status: 'pending' }], /content must be non-empty/],
    [[{ content: ' padded ', status: 'pending' }], /already trimmed/],
    [[{ content: 'same', status: 'pending' }, { content: 'same', status: 'completed' }], /repeats content/],
    [[{ content: 'task', status: 42 }], /unknown status/],
    [[{ content: 'task', status: 'paused' }], /unknown status/],
    [[{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'in_progress' }], /at most one/],
  ])('rejects an incoherent durable todo snapshot', async (todos, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(todos)) }).toThrow(message)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      })
    }).not.toThrow()
  })

  it('rejects an invalid existing snapshot on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('todo/write', {
      todos: [
        { content: 'duplicate', status: 'pending' },
        { content: 'duplicate', status: 'completed' },
      ],
    })
    await ctx.plugin(InvariantService, { enabled: true })

    await expect(ctx.plugin(TodoInvariant).then(() => undefined)).rejects.toThrow(/repeats content "duplicate"/)
  })
})
