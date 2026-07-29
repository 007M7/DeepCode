import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId, createToolResultMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as SourceGuardInvariant from '@deepseek-ai/dsh-source-guard/invariant'

/**
 * The companion validates the durable shape of this package's only
 * model-visible output: its refusal must name the offending path, the branch
 * that protects it, and the skill that lifts it, so the model can act on the
 * denial instead of merely stopping.
 */

const PATH = '/repo/staging/file.ts'

/** A well-formed denial for `path`, as the guard materializes it into a tool result. */
function denial(path = PATH, branch = 'dsh-staging/20260101T000000Z', skill = 'dsh-customize'): string {
  return `Error: Editing "${path}" directly is not allowed: it is inside the dsh checkout this session is running from, `
    + `on branch ${branch}. Load the ${skill} skill first and follow it `
    + '— implement in a task worktree, then integrate under the staging lock.'
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(SourceGuardInvariant)
  return ctx
}

/** One durable tool result carrying `content`, error-flagged unless told otherwise. */
function result(content: unknown[], isError = true): SessionEvent {
  return {
    type: 'tool/result',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    sourceEventSeqs: [0],
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('c0'),
        content: content as ContentBlock[],
        isError,
      }),
    },
  }
}

describe('source-guard invariants', () => {
  it('accepts a denial naming the path, branch, and skill', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('accept'))
    expect(() => { ctx.emit('session/event', session, result([{ type: 'text', text: denial() }])) }).not.toThrow()
  })

  it('accepts a Windows-style absolute path', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('accept-windows'))
    const event = result([{ type: 'text', text: denial(String.raw`C:\repo\staging\file.ts`) }])
    expect(() => { ctx.emit('session/event', session, event) }).not.toThrow()
  })

  it.each([
    ['a successful result that merely quotes the prefix', false],
  ])('ignores %s', async (_label, isError) => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ignore-success'))
    const event = result([{ type: 'text', text: 'Error: Editing "x" was fine' }], isError)
    expect(() => { ctx.emit('session/event', session, event) }).not.toThrow()
  })

  it.each([
    ['a non-text block', [{ type: 'image', data: 'x', mimeType: 'image/png' }]],
    ['text that is not this package\'s denial', [{ type: 'text', text: 'Error: something else' }]],
  ])('ignores %s', async (_label, content) => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ignore-other'))
    expect(() => { ctx.emit('session/event', session, result(content)) }).not.toThrow()
  })

  it('ignores an event that is not a tool result', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('ignore-kind'))
    const event: SessionEvent = {
      type: 'user/message',
      seq: 0,
      time: 1,
      surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: denial() }], source: { kind: 'user' } }),
    }
    expect(() => { ctx.emit('session/event', session, event) }).not.toThrow()
  })

  it.each([
    [
      'omits the skill that lifts it',
      `Error: Editing "${PATH}" directly is not allowed: it is inside the dsh checkout this session is running from, on branch main.`,
    ],
    [
      'names a relative path',
      denial('relative/file.ts'),
    ],
  ])('rejects a denial that %s', async (_label, text) => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('reject'))
    expect(() => { ctx.emit('session/event', session, result([{ type: 'text', text }])) }).toThrow(/source-guard denial/)
  })

  it('rejects an invalid denial already present on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('late'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    const call = session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('c0'), name: 'write', arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('c0'),
        content: [{ type: 'text', text: denial('relative/file.ts') }],
        isError: true,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })

    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(SourceGuardInvariant).then(() => undefined)).rejects.toThrow(/source-guard denial/)
  })
})
