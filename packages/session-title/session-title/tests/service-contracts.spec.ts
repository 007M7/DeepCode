import { Context, type Fiber } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService, {
  appendSessionTitleOutOfBand,
  SessionTitleProviderId,
  type Config,
  type SessionTitleProvider,
  type SessionTitleProviderRequest,
  type SessionTitleProviderResult,
} from '@deepseek-ai/dsh-session-title'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'test/title-provider-request': { revision: number }
  }

  interface OutOfBandSessionEventMap {
    'test/title-provider-request': true
  }
}

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

  it('rejects fallback refresh cancellation that arrives during durability flush', async () => {
    const ctx = await setup()
    const seed = new Session(SessionId('fallback-cancel-seed'))
    seed.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    const source = appendPrompt(seed, 'Persist this fallback despite caller cancellation')
    seed.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const session = ctx.sessions.create(SessionId('fallback-cancel'), { seed: seed.events })
    const flushStarted = deferred<undefined>()
    const releaseFlush = deferred<undefined>()
    ctx.on('session/flush', async (subject) => {
      if (subject !== session) return
      flushStarted.resolve(undefined)
      await releaseFlush.promise
    })
    const controller = new AbortController()

    const refresh = ctx.sessionTitle.refresh(session, controller.signal)
    await flushStarted.promise
    controller.abort(new Error('cancelled while fallback flushed'))
    releaseFlush.resolve(undefined)

    await expect(refresh).rejects.toThrow('cancelled while fallback flushed')
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      messageSeqs: [source.seq],
      source: { kind: 'fallback' },
    })
  })

  it('shares one durable fallback across concurrent refreshes', async () => {
    const ctx = await setup()
    const seed = new Session(SessionId('fallback-concurrency-seed'))
    seed.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    const source = appendPrompt(seed, 'Create exactly one fallback title')
    seed.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const session = ctx.sessions.create(SessionId('fallback-concurrency'), { seed: seed.events })
    let flushes = 0
    ctx.on('session/flush', (subject) => {
      if (subject === session) flushes += 1
    })

    const results = await Promise.all([
      ctx.sessionTitle.refresh(session),
      ctx.sessionTitle.refresh(session),
    ])

    expect(results[0]).toEqual(results[1])
    expect(session.events.filter(event => event.type === 'session/title')).toHaveLength(1)
    expect(session.events.filter(event => event.type === 'turn/start'
      && event.data.trigger.kind === 'session-title')).toHaveLength(1)
    expect(ctx.sessionTitle.get(session)?.messageSeqs).toEqual([source.seq])
    expect(flushes).toBe(1)
  })

  it('reserves overlapping refresh order before fallback durability settles', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const seed = new Session(SessionId('refresh-order-seed'))
    seed.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    const source = appendPrompt(seed, 'Keep the newest explicit refresh')
    seed.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const session = ctx.sessions.create(SessionId('refresh-order'), { seed: seed.events })
    const flushStarted = deferred<undefined>()
    const releaseFlush = deferred<undefined>()
    let flushCount = 0
    ctx.on('session/flush', async (subject) => {
      if (subject !== session || ++flushCount !== 1) return
      flushStarted.resolve(undefined)
      await releaseFlush.promise
    })
    const result = deferred<SessionTitleProviderResult>()
    const requests: SessionTitleProviderRequest[] = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('refresh-order'),
      automatic: 'first-message',
      generate(request) {
        requests.push(request)
        return result.promise
      },
    })

    const older = ctx.sessionTitle.refresh(session)
    const olderOutcome = older.then(
      () => undefined,
      (error: unknown) => error,
    )
    await flushStarted.promise
    const newer = ctx.sessionTitle.refresh(session)
    await settle()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal.aborted).toBe(false)

    releaseFlush.resolve(undefined)
    await settle()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal.aborted).toBe(false)
    result.resolve({ title: 'Newest explicit title', messageSeqs: [source.seq] })
    await expect(newer).resolves.toMatchObject({ title: 'Newest explicit title' })
    const olderError = await olderOutcome
    expect(olderError).toBeInstanceOf(Error)
    if (!(olderError instanceof Error)) throw new Error('expected older refresh to reject')
    expect(olderError.message).toMatch(/superseded/)
  })

  it('serializes a newer provider write after the superseded write', async () => {
    const ctx = await setup()
    const session = startSession(ctx, 'refresh-provider-write-order')
    const source = appendPrompt(session, 'Serialize explicit provider writes')
    await settle()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const flushStarted = deferred<undefined>()
    const releaseFlush = deferred<undefined>()
    let flushCount = 0
    ctx.on('session/flush', async (subject) => {
      if (subject !== session || ++flushCount !== 1) return
      flushStarted.resolve(undefined)
      await releaseFlush.promise
    })
    let generation = 0
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('refresh-provider-write-order'),
      automatic: 'first-message',
      async generate(request) {
        generation += 1
        const revision = generation
        await appendSessionTitleOutOfBand(ctx, request.session, 'test/title-provider-request', {
          revision,
        }, request.signal)
        return {
          title: `Generated title ${revision}`,
          messageSeqs: [source.seq],
        }
      },
    })

    const older = ctx.sessionTitle.refresh(session)
    const olderOutcome = older.then(
      () => undefined,
      (error: unknown) => error,
    )
    await flushStarted.promise
    const middle = ctx.sessionTitle.refresh(session)
    const middleOutcome = middle.then(
      value => value,
      (error: unknown) => error,
    )
    await settle()

    expect(generation).toBe(2)
    expect(session.events.filter(event => event.type === 'test/title-provider-request'))
      .toHaveLength(1)
    const newer = ctx.sessionTitle.refresh(session)
    const newerOutcome = newer.then(
      value => value,
      (error: unknown) => error,
    )
    await settle()
    expect(generation).toBe(3)
    expect(session.events.filter(event => event.type === 'test/title-provider-request'))
      .toHaveLength(1)

    releaseFlush.resolve(undefined)
    const newerResult = await newerOutcome
    expect(newerResult).toMatchObject({ title: 'Generated title 3' })
    const olderError = await olderOutcome
    expect(olderError).toBeInstanceOf(Error)
    if (!(olderError instanceof Error)) throw new Error('expected older refresh to reject')
    expect(olderError.message).toMatch(/superseded/)
    const middleError = await middleOutcome
    expect(middleError).toBeInstanceOf(Error)
    if (!(middleError instanceof Error)) throw new Error('expected middle refresh to reject')
    expect(middleError.message).toMatch(/superseded/)
    expect(session.events.filter(event => event.type === 'test/title-provider-request').map(event => event.data.revision))
      .toEqual([1, 3])
  })

  it('cancels a queued fallback when the session-title service unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const lifecycle: { fiber?: Fiber; session?: Session; inactiveRefresh?: Promise<unknown> } = {}
    ctx.on('internal/plugin', (subject) => {
      if (subject !== lifecycle.fiber || subject.uid !== null || lifecycle.session === undefined) return
      appendPrompt(lifecycle.session, 'Ignore reentrant disposal prompt')
      lifecycle.session.append('request/header', {
        header: { config: { provider: 'main', model: 'main' } },
        reason: 'initial',
      })
      lifecycle.inactiveRefresh = ctx.sessionTitle.refresh(lifecycle.session).then(
        () => undefined,
        (error: unknown) => error,
      )
    })
    const fiber = await ctx.plugin(SessionTitleService, CONFIG)
    lifecycle.fiber = fiber
    const session = startSession(ctx, 'service-dispose-fallback')
    lifecycle.session = session
    appendPrompt(session, 'Do not publish after service disposal')

    await fiber.dispose()
    await settle()

    expect(session.events.some(event => event.type === 'session/title')).toBe(false)
    const inactiveError = await lifecycle.inactiveRefresh
    expect(inactiveError).toBeInstanceOf(Error)
    if (!(inactiveError instanceof Error)) throw new Error('expected inactive refresh to reject')
    expect(inactiveError.message).toBe('session-title service disposed')
  })

  it('aborts pending and active provider work and drains ignored cancellation during service unload', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionTitleService, CONFIG)
    const result = deferred<SessionTitleProviderResult>()
    const requests: SessionTitleProviderRequest[] = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('service-unload'),
      automatic: 'all-user-messages',
      generate(request) {
        requests.push(request)
        return result.promise
      },
    })
    const active = startSession(ctx, 'service-unload-active')
    const activeMessage = appendPrompt(active, 'Active provider work')
    await settle()
    const refresh = ctx.sessionTitle.refresh(active)
    const refreshOutcome = refresh.then(
      () => undefined,
      (error: unknown) => error,
    )
    await settle()
    expect(requests).toHaveLength(1)
    const pending = startSession(ctx, 'service-unload-pending')
    appendPrompt(pending, 'Pending provider work')

    const disposal = fiber.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await settle()
    expect(requests[0]?.signal.aborted).toBe(true)
    expect(disposed).toBe(false)
    result.resolve({ title: 'Ignored service abort', messageSeqs: [activeMessage.seq] })
    await disposal

    expect(disposed).toBe(true)
    await expect(refreshOutcome).resolves.toEqual(expect.objectContaining({ message: 'session-title service disposed' }))
  })

  it('suppresses a queued fallback failure after service unload begins', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionTitleService, CONFIG)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = startSession(ctx, 'service-unload-flush')
    appendPrompt(session, 'Fallback whose flush outlives the service')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const flushStarted = deferred<undefined>()
    const releaseFlush = deferred<undefined>()
    ctx.on('session/flush', async (subject) => {
      if (subject !== session) return
      flushStarted.resolve(undefined)
      await releaseFlush.promise
      throw new Error('flush failed during service unload')
    })

    await flushStarted.promise
    const disposal = fiber.dispose()
    releaseFlush.resolve(undefined)
    await disposal

    expect(warn).not.toHaveBeenCalled()
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
    const pending = startSession(ctx, 'pending-provider-dispose')
    appendPrompt(pending, 'Drop pending provider work')
    await dispose()
    await settle()
    expect(generate).not.toHaveBeenCalled()
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
    expect(ctx.sessionTitle.get(pending)?.source.kind).toBe('fallback')
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
