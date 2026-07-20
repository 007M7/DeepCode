import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmService, { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  generateSessionTitleWithLlm,
  resolveSessionTitleLlmConfig,
  SESSION_TITLE_TIMEOUT_CODE,
} from '@deepseek-ai/dsh-session-title-llm'
import type { SessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

class CooperativeAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected title request signal')
    await new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise exact AbortSignal.reason propagation
        reject(signal.reason)
      }
      if (signal.aborted) {
        rejectAbort()
        return
      }
      signal.addEventListener('abort', rejectAbort, { once: true })
    })
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  五个字标题  ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

function request(signal = new AbortController().signal): SessionTitleProviderRequest {
  return {
    session: new Session(SessionId('title-call')),
    messages: [
      { seq: 2, text: 'first prompt' },
      { seq: 9, text: '第二个问题' },
    ],
    route: { provider: 'current-route', model: 'current-model' },
    signal,
  }
}

function requestWithoutRoute(signal = new AbortController().signal): SessionTitleProviderRequest {
  return {
    session: new Session(SessionId('title-call-no-route')),
    messages: [{ seq: 2, text: 'first prompt' }],
    signal,
  }
}

async function withScript(script: readonly StreamChunk[]): Promise<{
  ctx: Context
  adapter: RecordingAdapter
}> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  const adapter = new RecordingAdapter(script)
  ctx.llm.registerAdapter(['current-route'], adapter)
  return { ctx, adapter }
}

describe('generateSessionTitleWithLlm', () => {
  it('uses the exact logged route, language targets, full framed input, and output token cap', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['current-route'], adapter)

    const result = await generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      request(),
      request().messages,
    )

    expect(result).toEqual({
      title: '五个字标题',
      messageSeqs: [2, 9],
      model: { provider: 'current-route', model: 'current-model' },
    })
    expect(adapter.requests).toHaveLength(1)
    const options = adapter.requests[0]!
    expect(options).toMatchObject({
      provider: 'current-route',
      model: 'current-model',
      maxTokens: 32,
      sessionId: SessionId('title-call'),
    })
    expect(options.system).toContain('5 words')
    expect(options.system).toContain('10 CJK characters')
    const prompt = options.messages[0]?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toContain('first prompt')
    expect(prompt?.type === 'text' && prompt.text).toContain('第二个问题')
  })

  it('uses paired explicit overrides and rejects an oversized input without calling the model', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['explicit-route'], adapter)
    const config = resolveSessionTitleLlmConfig({
      ...CONFIG,
      provider: 'explicit-route',
      model: 'explicit-model',
      maxInputBytes: 4,
    })

    await expect(generateSessionTitleWithLlm(ctx, config, request(), request().messages))
      .rejects.toThrow(/input.*bytes.*maxInputBytes/i)
    expect(adapter.requests).toEqual([])

    const withinLimit = resolveSessionTitleLlmConfig({ ...config, maxInputBytes: 1_000 })
    await generateSessionTitleWithLlm(ctx, withinLimit, request(), [request().messages[0]!])
    expect(adapter.requests[0]).toMatchObject({
      provider: 'explicit-route',
      model: 'explicit-model',
    })
  })

  it('requires every deployment limit and a complete optional route pair', () => {
    expect(() => resolveSessionTitleLlmConfig(undefined as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig(null as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig('invalid' as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, extra: true } as SessionTitleLlmConfig))
      .toThrow(/unknown config key "extra"/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 0 }))
      .toThrow(/targetWords.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 1.5 }))
      .toThrow(/targetWords.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'only-provider' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, model: 'only-model' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: '', model: 'model' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: '' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 1, model: 'model' } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: 1 } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/timeoutMs must not exceed/)
    expect(() => resolveSessionTitleLlmConfig(CONFIG)).not.toThrow()
  })

  it('rejects an absent route, empty selection, and pre-aborted caller before model dispatch', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const config = resolveSessionTitleLlmConfig(CONFIG)
    await expect(generateSessionTitleWithLlm(ctx, config, requestWithoutRoute(), requestWithoutRoute().messages))
      .rejects.toThrow(/no logged request route/)
    await expect(generateSessionTitleWithLlm(ctx, config, request(), []))
      .rejects.toThrow(/at least one source message/)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(generateSessionTitleWithLlm(ctx, config, request(controller.signal), request().messages))
      .rejects.toThrow('caller stopped')
    expect(adapter.requests).toEqual([])
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'SERVER' } }, 'provider failed', 'SERVER'],
    [{ kind: 'aborted', failure: { message: 'provider aborted', code: 'ABORTED' } }, 'provider aborted', 'ABORTED'],
  ] satisfies Array<[FinishReason, string, string]>)('preserves %s terminal failure details', async (reason, message, code) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      request(),
      request().messages,
    )).rejects.toMatchObject({ message, code })
  })

  it.each([
    [{ kind: 'max-tokens' }, /reached maxOutputTokens/],
    [{ kind: 'tool-calls' }, /unexpectedly requested a tool/],
    [{ kind: 'future-finish' } as never, /unsupported finish reason "future-finish"/],
  ] satisfies Array<[FinishReason, RegExp]>)('rejects the terminal finish reason %s', async (reason, error) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      request(),
      request().messages,
    )).rejects.toThrow(error)
  })

  it('rejects tool-call blocks and a successful response with no text', async () => {
    const toolScript: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: CallId('title-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const tool = await withScript(toolScript)
    await expect(generateSessionTitleWithLlm(
      tool.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      request(),
      request().messages,
    )).rejects.toThrow(/output must contain text only/)

    const reasoning = await withScript([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'no final title' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(generateSessionTitleWithLlm(
      reasoning.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      request(),
      request().messages,
    )).rejects.toThrow(/produced no text/)
  })

  it('aborts a cooperative model stream at the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(LlmService)
      ctx.llm.registerAdapter(['current-route'], new CooperativeAdapter())
      const pending = generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        request(),
        request().messages,
      )
      const rejected = expect(pending).rejects.toMatchObject({
        code: SESSION_TITLE_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
