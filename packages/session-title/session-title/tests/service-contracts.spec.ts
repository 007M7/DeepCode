import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService, {
  SessionTitleProviderId,
  type Config,
  type SessionTitleProvider,
  type SessionTitleProviderRequest,
  type SessionTitleProviderResult,
} from '@deepseek-ai/dsh-session-title'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function setup(config: Config = CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionTitleService, config)
  return ctx
}

function startSession(ctx: Context, id: string): ReturnType<Context['sessions']['create']> {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', {
    turn: 1,
    trigger: { kind: 'message', source: { kind: 'user' } },
  })
  return session
}

function appendPrompt(session: ReturnType<Context['sessions']['create']>, text: string) {
  return session.append('user/message', {
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
}

describe('SessionTitleService configuration and refresh boundaries', () => {
  it('requires explicit positive limits with a fallback cap no larger than the accepted-title cap', () => {
    expect(() => new SessionTitleService(new Context(), undefined as never))
      .toThrow('configuration is required')
    expect(() => new SessionTitleService(new Context(), null as never))
      .toThrow('configuration is required')
    expect(() => new SessionTitleService(new Context(), { ...CONFIG, fallbackMaxWords: 0 }))
      .toThrow(/fallbackMaxWords must be a positive integer/)
    expect(() => new SessionTitleService(new Context(), { ...CONFIG, fallbackMaxWords: 1.5 }))
      .toThrow(/fallbackMaxWords must be a positive integer/)
    expect(() => new SessionTitleService(new Context(), { ...CONFIG, fallbackMaxBytes: 81 }))
      .toThrow(/fallbackMaxBytes must not exceed maxTitleBytes/)
  })

  it('returns no title for empty input with or without a provider, and rejects detached or pre-aborted refreshes', async () => {
    const fallbackOnly = await setup()
    const empty = fallbackOnly.sessions.create(SessionId('empty-fallback'))
    await expect(fallbackOnly.sessionTitle.refresh(empty)).resolves.toBeUndefined()

    const withProvider = await setup()
    const generate = vi.fn(async (): Promise<SessionTitleProviderResult> => ({
      title: 'unused',
      messageSeqs: [0],
    }))
    withProvider.sessionTitle.register({
      id: SessionTitleProviderId('empty-provider'),
      automatic: 'first-message',
      generate,
    })
    const providerEmpty = withProvider.sessions.create(SessionId('empty-provider'))
    await expect(withProvider.sessionTitle.refresh(providerEmpty)).resolves.toBeUndefined()
    expect(generate).not.toHaveBeenCalled()

    await expect(withProvider.sessionTitle.refresh(new Session(SessionId('detached'))))
      .rejects.toThrow(/not live in this store/)
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(withProvider.sessionTitle.refresh(providerEmpty, controller.signal))
      .rejects.toThrow('already cancelled')
  })

  it('passes an absent route and caller cancellation into explicit generation', async () => {
    const ctx = await setup()
    let observed: SessionTitleProviderRequest | undefined
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('explicit-no-route'),
      automatic: 'first-message',
      async generate(request) {
        observed = request
        return { title: 'Explicit title', messageSeqs: [request.messages[0]!.seq] }
      },
    })
    const session = startSession(ctx, 'explicit-no-route')
    appendPrompt(session, 'Refresh before any request header')
    await settle()
    const controller = new AbortController()

    await expect(ctx.sessionTitle.refresh(session, controller.signal))
      .resolves.toMatchObject({ title: 'Explicit title' })
    expect(observed?.route).toBeUndefined()
    expect(observed?.signal.aborted).toBe(false)
  })

  it('propagates explicit cancellation and session disposal to active work', async () => {
    const callerCtx = await setup()
    const callerPending = deferred<SessionTitleProviderResult>()
    let callerSignal: AbortSignal | undefined
    callerCtx.sessionTitle.register({
      id: SessionTitleProviderId('caller-cancel'),
      automatic: 'first-message',
      generate(request) {
        callerSignal = request.signal
        return callerPending.promise
      },
    })
    const callerSession = startSession(callerCtx, 'caller-cancel')
    const callerMessage = appendPrompt(callerSession, 'Cancel this refresh')
    await settle()
    const controller = new AbortController()
    const refresh = callerCtx.sessionTitle.refresh(callerSession, controller.signal)
    await settle()
    controller.abort(new Error('caller cancelled'))
    callerPending.resolve({ title: 'ignored', messageSeqs: [callerMessage.seq] })
    await expect(refresh).rejects.toThrow('caller cancelled')
    expect(callerSignal?.aborted).toBe(true)

    const disposeCtx = await setup()
    const disposePending = deferred<SessionTitleProviderResult>()
    let disposeSignal: AbortSignal | undefined
    disposeCtx.sessionTitle.register({
      id: SessionTitleProviderId('session-dispose'),
      automatic: 'first-message',
      generate(request) {
        disposeSignal = request.signal
        return disposePending.promise
      },
    })
    const disposed = disposeCtx.sessions.prepare(SessionId('session-dispose'))
    const detach = disposeCtx.sessions.enter(disposed)
    disposeCtx.sessions.announce(disposed)
    disposed.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    const disposedMessage = appendPrompt(disposed, 'Dispose this session')
    await settle()
    const disposedRefresh = disposeCtx.sessionTitle.refresh(disposed)
    await settle()
    detach()
    disposePending.resolve({ title: 'ignored', messageSeqs: [disposedMessage.seq] })
    await expect(disposedRefresh).rejects.toThrow(/session disposed/)
    expect(disposeSignal?.aborted).toBe(true)
  })

  it('warns when a detached session prevents queued fallback publication', async () => {
    const ctx = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = ctx.sessions.prepare(SessionId('fallback-detach'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    ctx.on('session/event', (subject, event) => {
      if (subject === session && event.type === 'user/message') detach()
    })
    session.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    appendPrompt(session, 'Detach before the fallback microtask')
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fallback title update failed'))
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
  })

  it('leaves a title absent when the byte cap cannot hold the first code point', async () => {
    const ctx = await setup({ fallbackMaxWords: 5, fallbackMaxBytes: 1, maxTitleBytes: 2 })
    const session = startSession(ctx, 'no-code-point')
    appendPrompt(session, '😀')
    await settle()
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
    await expect(ctx.sessionTitle.refresh(session)).resolves.toBeUndefined()
  })
})

describe('SessionTitleService provider validation and stale scheduling', () => {
  it('rejects malformed provider registrations before publishing them', async () => {
    const ctx = await setup()
    const generate = async (): Promise<SessionTitleProviderResult> => ({ title: 'title', messageSeqs: [0] })
    expect(() => ctx.sessionTitle.register(null as never)).toThrow(/must be an object/)
    expect(() => ctx.sessionTitle.register('provider' as never)).toThrow(/must be an object/)
    expect(() => ctx.sessionTitle.register({
      id: 1,
      automatic: 'first-message',
      generate,
    } as unknown as SessionTitleProvider)).toThrow(/id must be a non-empty string/)
    expect(() => ctx.sessionTitle.register({
      id: SessionTitleProviderId(''),
      automatic: 'first-message',
      generate,
    })).toThrow(/id must be a non-empty string/)
    expect(() => ctx.sessionTitle.register({
      id: SessionTitleProviderId('bad-mode'),
      automatic: 'sometimes' as never,
      generate,
    })).toThrow(/automatic mode is invalid/)
    expect(() => ctx.sessionTitle.register({
      id: SessionTitleProviderId('missing-generate'),
      automatic: 'first-message',
      generate: undefined,
    } as unknown as SessionTitleProvider)).toThrow(/requires generate/)
  })

  it('drops automatic work when its provider is disposed before the queued start', async () => {
    const ctx = await setup()
    const generate = vi.fn(async (request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult> => ({
      title: 'too late',
      messageSeqs: [request.messages[0]!.seq],
    }))
    const dispose = ctx.sessionTitle.register({
      id: SessionTitleProviderId('queued-dispose'),
      automatic: 'all-user-messages',
      generate,
    })
    const session = startSession(ctx, 'queued-dispose')
    appendPrompt(session, 'Queue provider work')
    await settle()
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main' } },
      reason: 'initial',
    })
    dispose()
    await settle()
    expect(generate).not.toHaveBeenCalled()
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
  })

  it('rejects malformed provider results without replacing the fallback', async () => {
    const ctx = await setup()
    let result: unknown
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('invalid-results'),
      automatic: 'first-message',
      generate: async () => result as SessionTitleProviderResult,
    })
    const session = startSession(ctx, 'invalid-results')
    const first = appendPrompt(session, 'First source')
    await settle()
    const second = appendPrompt(session, 'Second source')
    await settle()

    const cases: Array<{ value: unknown; error: RegExp }> = [
      { value: null, error: /invalid result/ },
      { value: 1, error: /invalid result/ },
      { value: { title: 1, messageSeqs: [first.seq] }, error: /title must be a string/ },
      { value: { title: '\u001B[31m', messageSeqs: [first.seq] }, error: /empty title/ },
      { value: { title: 'valid', messageSeqs: undefined }, error: /at least one source message/ },
      { value: { title: 'valid', messageSeqs: [] }, error: /at least one source message/ },
      { value: { title: 'valid', messageSeqs: ['not-a-seq'] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [1.5] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [-1] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [999] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [first.seq, first.seq] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [second.seq, first.seq] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: null }, error: /model provenance/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: 'route' }, error: /model provenance/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: { provider: 1, model: 'm' } }, error: /model provenance/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: { provider: '', model: 'm' } }, error: /model provenance/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: { provider: 'p', model: 1 } }, error: /model provenance/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: { provider: 'p', model: '' } }, error: /model provenance/ },
    ]
    for (const item of cases) {
      result = item.value
      await expect(ctx.sessionTitle.refresh(session)).rejects.toThrow(item.error)
      expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
    }
  })
})
