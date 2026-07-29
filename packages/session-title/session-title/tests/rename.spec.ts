// SessionTitleService.rename: user-source acceptance, normalization/rejection
// boundaries, and the pin (a user-sourced latest title schedules no automatic
// revision; explicit refresh stays the unpin).
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService, {
  SessionTitleProviderId,
  foldSessionTitle,
  type SessionTitleProviderRequest,
} from '@deepseek-ai/dsh-session-title'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 40,
} as const

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function appendHumanPrompt(session: ReturnType<Context['sessions']['create']>, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('SessionTitleService.rename', () => {
  it('appends a normalized user-source title and supersedes automatic work', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const session = ctx.sessions.create(SessionId('rename-accept'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    appendHumanPrompt(session, 'Original prompt text')
    await settle()

    const accepted = ctx.sessionTitle.rename(session, '  Hand\tpicked   name  ')
    expect(accepted).toMatchObject({
      title: 'Hand picked name',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    const event = session.events.findLast(item => item.type === 'session/title')
    expect(event?.data).toEqual({
      title: 'Hand picked name',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    // foldSessionTitle round-trips the third source kind.
    expect(foldSessionTitle(session.events)?.source).toEqual({ kind: 'user' })
  })

  it('rejects titles that normalize to empty and dead sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const session = ctx.sessions.create(SessionId('rename-reject'))
    expect(() => ctx.sessionTitle.rename(session, '  [31m  ')).toThrow(/visible characters/)

    expect(() => ctx.sessionTitle.rename(new Session(SessionId('detached')), 'name'))
      .toThrow(/not live in this store/)
  })

  it('pins the title: later user messages schedule no automatic revision; refresh unpins', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const generate = vi.fn(async (request: SessionTitleProviderRequest) => ({
      title: 'Provider title',
      messageSeqs: request.messages.map(message => message.seq),
    }))
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('pin-provider'),
      automatic: 'all-user-messages',
      generate,
    })
    const session = ctx.sessions.create(SessionId('rename-pin'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    appendHumanPrompt(session, 'First prompt')
    await settle()
    ctx.sessionTitle.rename(session, 'Pinned by hand')

    // A later eligible prompt must schedule nothing while the pin stands.
    appendHumanPrompt(session, 'Second prompt after the pin')
    await settle()
    session.append('request/header', {
      header: { config: { provider: 'main-route', model: 'chat-model' } },
      reason: 'change',
    })
    await settle()
    expect(generate).not.toHaveBeenCalled()
    expect(ctx.sessionTitle.get(session)?.title).toBe('Pinned by hand')

    // Explicit refresh remains the deliberate unpin.
    const refreshed = await ctx.sessionTitle.refresh(session)
    expect(generate).toHaveBeenCalledOnce()
    expect(refreshed?.title).toBe('Provider title')
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('provider')
  })

  it('fallback-only refresh also unpins: the user title yields to a re-derived fallback', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const session = ctx.sessions.create(SessionId('rename-unpin-fallback'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    appendHumanPrompt(session, 'Derivable prompt words')
    await settle()
    ctx.sessionTitle.rename(session, 'Pinned without provider')
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('user')

    const refreshed = await ctx.sessionTitle.refresh(session)
    expect(refreshed).toMatchObject({
      title: 'Derivable prompt words',
      source: { kind: 'fallback' },
    })
    // The pin is gone: the next user message schedules automatic work again
    // (observable as a fresh fallback-source title remaining latest).
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
  })

  it('fallback-only refresh keeps the user title when no fallback is derivable', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // A 3-byte fallback cap cannot hold the 4-byte emoji prompt: the
    // re-derived fallback is empty, so the pinned title survives the refresh.
    await ctx.plugin(SessionTitleService, { ...CONFIG, fallbackMaxBytes: 3 })
    const session = ctx.sessions.create(SessionId('rename-unpin-empty'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    appendHumanPrompt(session, '😀😀')
    await settle()
    ctx.sessionTitle.rename(session, 'Sticky emoji pin')

    const refreshed = await ctx.sessionTitle.refresh(session)
    expect(refreshed?.title).toBe('Sticky emoji pin')
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('user')
  })
})
