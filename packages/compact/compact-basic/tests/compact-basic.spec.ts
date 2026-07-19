import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import BasicCompactService from '@deepseek-ai/dsh-compact-basic'
import type { BasicCompactConfig } from '@deepseek-ai/dsh-compact-basic'
import { selectCompactableRange } from '@deepseek-ai/dsh-compact-basic/src/region.ts'
import { resolveConfig } from '@deepseek-ai/dsh-compact-basic/src/config.ts'
import type { CompactionResult } from '@deepseek-ai/dsh-compact'
import LlmService, { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const SIGNAL = new AbortController().signal
const MODEL = 'test-model'

function createContext(contextWindow = 1_000): Context {
  const ctx = new Context()
  void new TokenMeterService(ctx, { contextWindow })
  return ctx
}

function agent(session: Session, model?: string): Agent {
  return { session, options: model === undefined ? {} : { provider: model, model } } as Agent
}

/** Closed two-message turns followed by one open turn for durable compaction events. */
function conversation(turns = 4, text = 'fixture '.repeat(40).trim()): Session {
  const session = new Session(SessionId(`conversation-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', {
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      provenance: { provider: MODEL, model: MODEL },
      turn,
      step: 1,
      content: [{ type: 'text', text: `${text} assistant ${turn}` }],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', {
    turn: turns + 1,
    trigger: { kind: 'message', source: { kind: 'user' } },
  })
  return session
}

function toolConversation(): Session {
  const session = new Session(SessionId('tools'))
  for (let turn = 1; turn <= 3; turn += 1) {
    const callId = CallId(`call-${turn}`)
    session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', {
      content: [{ type: 'text', text: `request ${turn} `.repeat(300) }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      provenance: { provider: MODEL, model: MODEL },
      turn,
      step: 1,
      content: [
        { type: 'text', text: `calling ${turn} `.repeat(300) },
        { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
      ],
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      callId,
      content: [{ type: 'text', text: `result ${turn} `.repeat(300) }],
      isError: false,
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4, trigger: { kind: 'message', source: { kind: 'user' } } })
  return session
}

class TestCompactService extends BasicCompactService {
  summary: ContentBlock[] = [{ type: 'text', text: 'small checkpoint' }]
  summaryProvider = 'summary-provider'
  summaryModel = 'summary-model'
  error: unknown
  mutateDuringSummary: (() => void) | undefined
  calls: Array<{ text: string; signal: AbortSignal | undefined }> = []

  override async summarize(
    text: string,
    _agent: Agent,
    signal?: AbortSignal,
  ): Promise<{ summary: ContentBlock[]; provider: string; model: string; maxTokens?: number }> {
    this.calls.push({ text, signal })
    this.mutateDuringSummary?.()
    if (this.error !== undefined) throw this.error
    return {
      summary: this.summary,
      provider: this.summaryProvider,
      model: this.summaryModel,
      maxTokens: 123,
    }
  }
}

function service(
  config: BasicCompactConfig = { auto: false },
  ctx = createContext(),
): TestCompactService {
  return new TestCompactService(ctx, config)
}

async function compactIfNeeded(
  compact: BasicCompactService,
  session: Session,
  model: string | undefined = MODEL,
  system = '',
  prefix: readonly Message[] = [],
): Promise<CompactionResult | null> {
  return compact.compactIfNeeded(agent(session, model), system, prefix, SIGNAL)
}

describe('compact configuration and defaults', () => {
  it('uses low-friction service-wide defaults', () => {
    const ctx = createContext()
    const resolved = resolveConfig({}, ctx.tokenMeter)

    expect(resolved).toEqual({
      thresholdRatio: 0.8,
      retainTokens: 160,
      summarizationProvider: '',
      summarizationModel: '',
      maxTokens: 8192,
      compactionRetries: 1,
      auto: true,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('resolves threshold and retention overrides independently', () => {
    const ctx = createContext()
    const thresholdOnly = resolveConfig({
      thresholdRatio: 0.5,
    }, ctx.tokenMeter)
    expect(thresholdOnly).toMatchObject({
      thresholdRatio: 0.5,
      retainTokens: 160,
    })

    const retentionOnly = resolveConfig({
      retainTokens: 70,
    }, ctx.tokenMeter)
    expect(retentionOnly).toMatchObject({
      thresholdRatio: 0.8,
      retainTokens: 70,
    })
  })

  it('validates common values and pressure-policy invariants', () => {
    const ctx = createContext()
    const bad = [
      [{ maxTokens: 0 }, /maxTokens/],
      [{ compactionRetries: -1 }, /compactionRetries/],
      [{ auto: 'yes' }, /auto must be a boolean/],
      [{ summarizationProvider: 1 }, /summarizationProvider must be a string/],
      [{ summarizationModel: 1 }, /summarizationModel must be a string/],
      [{ summarizationProvider: MODEL }, /must both be set or both be empty/],
      [{ summarizationModel: MODEL }, /must both be set or both be empty/],
      [{ thresholdRatio: 0 }, /number in \(0, 1\]/],
      [{ thresholdRatio: 1.1 }, /number in \(0, 1\]/],
      [{ retainTokens: -1 }, /non-negative integer/],
      [{ thresholdRatio: 0.5, retainTokens: 500 }, /less than threshold/],
      [{ models: { [MODEL]: { retainTokens: 10 } } }, /BasicCompactConfig: unknown key "models"/],
      [{ thresholdRato: 0.5 }, /BasicCompactConfig: unknown key "thresholdRato"/],
    ] as Array<[unknown, RegExp]>

    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as BasicCompactConfig, ctx.tokenMeter)).toThrow(pattern)
    }
  })
})

describe('pressure measurement and retention', () => {
  const compactConfig: BasicCompactConfig = {
    auto: false,
    thresholdRatio: 0.5,
    retainTokens: 180,
  }

  it('skips the provisional check only when no routed or fallback model exists', async () => {
    const compact = service(compactConfig)
    const session = conversation()
    expect(await compact.compactIfNeeded(agent(session), '', [], SIGNAL)).toBeNull()
    expect(compact.calls).toHaveLength(0)
  })

  it('meters any routed model without profile resolution', async () => {
    const compact = service(compactConfig)
    await expect(compactIfNeeded(compact, conversation(), 'unlisted-model'))
      .resolves.not.toBeNull()
  })

  it('does nothing below threshold and compacts a priced head above threshold', async () => {
    const compact = service(compactConfig)
    expect(await compactIfNeeded(compact, conversation(2))).toBeNull()

    const session = conversation(4)
    const result = await compactIfNeeded(compact, session)
    expect(result).not.toBeNull()
    expect(result?.shadowedSeqs.length).toBeGreaterThan(2)
    expect(session.surface.nodes.length).toBeLessThan(8)
  })

  it('counts the current prompt and request prefix without putting either on the surface', async () => {
    const compact = service({
      auto: false,
      thresholdRatio: 0.7,
      retainTokens: 50,
    })
    const session = conversation(2, 'x'.repeat(200))
    expect(await compactIfNeeded(compact, session)).toBeNull()

    const prefix: Message[] = [{
      role: 'user',
      content: [{ type: 'text', text: 'p'.repeat(1_000) }],
    }]
    const result = await compactIfNeeded(compact, session, MODEL, 's'.repeat(1_000), prefix)
    expect(result).not.toBeNull()
    expect(prefix).toHaveLength(1)
    expect(session.events.some(event => event.type === 'context/message')).toBe(false)
  })

  it('uses the latest logged routed model in the provisional request envelope', async () => {
    const ctx = createContext()
    const compact = service({
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 180,
    }, ctx)
    const session = conversation(4)
    session.append('request/header', {
      header: { config: { provider: 'actual', model: 'actual' } },
      reason: 'initial',
    })
    const measure = vi.spyOn(ctx.tokenMeter, 'measure')

    const result = await compactIfNeeded(compact, session, 'fallback')
    expect(result).not.toBeNull()
    expect(measure.mock.calls[0]?.[1]?.config.provider).toBe('actual')
    expect(measure.mock.calls[0]?.[1]?.config.model).toBe('actual')
  })

  it('declines when envelope pressure is high but the surface has no compactable range', async () => {
    const compact = service(compactConfig)
    const empty = new Session(SessionId('empty'))
    expect(await compactIfNeeded(compact, empty, MODEL, 'x'.repeat(100_000))).toBeNull()

    const retained = conversation(1)
    expect(await compactIfNeeded(compact, retained, MODEL, 'x'.repeat(100_000))).toBeNull()
  })

  it('uses one unified measurement for each pressure-and-retention decision', async () => {
    const ctx = createContext()
    const compact = service(compactConfig, ctx)
    const measure = vi.spyOn(ctx.tokenMeter, 'measure')
    const stop = new Error('stop after first decision')
    vi.spyOn(compact, 'compactRegion').mockRejectedValueOnce(stop)

    await expect(compactIfNeeded(compact, conversation(4))).rejects.toBe(stop)
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('bounds retries when a shrinking checkpoint remains above threshold', async () => {
    const compact = service({
      auto: false,
      compactionRetries: 0,
      thresholdRatio: 0.3,
      retainTokens: 180,
    })
    compact.summary = Array.from({ length: 7 }, (_, index) => ({
      type: 'text',
      text: `summary ${index}`,
    }))

    await expect(compactIfNeeded(compact, conversation(4)))
      .rejects.toThrow(/still above threshold after 1 compaction attempts/)
  })

  it('rounds a retention cut head-ward to preserve tool-call/result pairing', async () => {
    const compact = service({
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 80,
    }, createContext(4_000))
    const session = toolConversation()
    const result = await compactIfNeeded(compact, session)
    expect(result).not.toBeNull()

    const messages = session.deriveMessages()
    const calls = new Set<string>()
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'tool-call') calls.add(block.id)
        if (block.type === 'tool-result') expect(calls.has(block.toolCallId)).toBe(true)
      }
    }
  })

  it('rejects a priced surface that is not the current positional surface', () => {
    const ctx = createContext()
    const session = conversation(2)
    const priced = ctx.tokenMeter.measure(session)
    expect(() => selectCompactableRange(session, {
      ...priced,
      nodes: priced.nodes.slice(1),
    }, 1)).toThrow(/does not match/)
  })

  it('declines when rounding a cut would consume the only tool pair', () => {
    const ctx = createContext()
    const session = new Session(SessionId('one-tool-pair'))
    const callId = CallId('only')
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      provenance: { provider: MODEL, model: MODEL },
      turn: 1,
      step: 1,
      content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      callId,
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })

    const priced = ctx.tokenMeter.measure(session)
    expect(selectCompactableRange(session, priced, 1)).toBeNull()
  })
})

describe('compaction region transaction', () => {
  it('lands a framed, replayable checkpoint with exact pricing provenance', async () => {
    const compact = service()
    const session = conversation(3)
    const before = session.surface.nodes
    const result = await compact.compactRegion(
      before[0]!,
      before[3]!,
      agent(session, MODEL),
      SIGNAL,
    )

    expect(result.shadowedSeqs).toEqual(before.slice(0, 4))
    expect(result.shadowedTokenCount).toBeGreaterThan(0)
    expect(compact.calls[0]).toMatchObject({ signal: SIGNAL })
    expect(compact.calls[0]?.text).toContain('fixture user 1')
    const summary = session.events.findLast(event => event.type === 'compact/summary')
    expect(summary?.data).toMatchObject({
      shadowedSeqs: result.shadowedSeqs,
      shadowedTokenCount: result.shadowedTokenCount,
      provider: 'summary-provider',
      model: 'summary-model',
      maxTokens: 123,
    })
    const head = session.deriveMessages()[0]!
    expect(head.content[0]?.type).toBe('text')
    expect(head.content[0]?.type === 'text' ? head.content[0].text : '').toContain('<compacted-summary>')
    expect(head.content.at(-1)).toEqual({ type: 'text', text: '</compacted-summary>' })

    const replay = new Session(SessionId('replay'), [...session.events])
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
  })

  it.each([
    ['start missing', 9_001, undefined, /start seq 9001 not found/],
    ['end missing', undefined, 9_002, /end seq 9002 not found/],
  ])('rejects %s', async (_label, startOverride, endOverride, pattern) => {
    const compact = service()
    const session = conversation(2)
    const nodes = session.surface.nodes
    await expect(compact.compactRegion(
      startOverride ?? nodes[0]!,
      endOverride ?? nodes[1]!,
      agent(session, MODEL),
    )).rejects.toThrow(pattern)
  })

  it('rejects reversed and tool-unbalanced positional boundaries', async () => {
    const compact = service()
    const plain = conversation(2)
    const nodes = plain.surface.nodes
    await expect(compact.compactRegion(
      nodes[2]!,
      nodes[1]!,
      agent(plain, MODEL),
    )).rejects.toThrow(/is after end/)

    const tools = toolConversation()
    const toolNodes = tools.surface.nodes
    await expect(compact.compactRegion(
      toolNodes[2]!,
      toolNodes[4]!,
      agent(tools, MODEL),
    )).rejects.toThrow(/start seq .* not a balanced boundary/)
    await expect(compact.compactRegion(
      toolNodes[0]!,
      toolNodes[1]!,
      agent(tools, MODEL),
    )).rejects.toThrow(/end seq .* not a balanced boundary/)
  })

  it('requires an open turn and an idle compaction bracket', async () => {
    const compact = service()
    const closed = conversation(1)
    closed.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const nodes = closed.surface.nodes
    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[1]!,
      agent(closed, MODEL),
    )).rejects.toThrow(/no open turn/)

    const locked = conversation(1)
    locked.append('compact/start', { turn: 2 })
    const lockedNodes = locked.surface.nodes
    await expect(compact.compactRegion(
      lockedNodes[0]!,
      lockedNodes[1]!,
      agent(locked, MODEL),
    )).rejects.toThrow(/already in progress/)
  })

  it('rejects a session with no turn boundary at all', async () => {
    const compact = service()
    const session = new Session(SessionId('turnless'))
    session.append('user/message', {
      content: [{ type: 'text', text: 'orphan' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const node = session.surface.nodes[0]!

    await expect(compact.compactRegion(
      node,
      node,
      agent(session, MODEL),
    )).rejects.toThrow(/no open turn/)
  })

  it('rejects a meter snapshot that changed before summarization began', async () => {
    const ctx = createContext()
    const meter = ctx.tokenMeter
    const original = meter.measure.bind(meter)
    vi.spyOn(meter, 'measure').mockImplementationOnce((session) => {
      const measurement = original(session)
      return { ...measurement, nodes: measurement.nodes.slice(1) }
    })
    const compact = service({ auto: false }, ctx)
    const session = conversation(2)
    const nodes = session.surface.nodes

    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[2]!,
      agent(session, MODEL),
    )).rejects.toThrow(/selected surface changed/)
  })

  it('records summarizer failures without mutating the surface', async () => {
    const compact = service()
    compact.error = new Error('summary unavailable')
    const session = conversation(2)
    const before = session.surface.nodes

    await expect(compact.compactRegion(
      before[0]!,
      before[2]!,
      agent(session, MODEL),
    )).rejects.toThrow('summary unavailable')
    expect(session.surface.nodes).toEqual(before)
    expect(session.events.findLast(event => event.type === 'compact/end')?.data)
      .toMatchObject({ error: 'summary unavailable' })
  })

  it('stringifies non-Error failures in the durable end bracket', async () => {
    const compact = service()
    compact.error = 'plain failure'
    const session = conversation(2)
    const nodes = session.surface.nodes
    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[2]!,
      agent(session, MODEL),
    )).rejects.toBe('plain failure')
    expect(session.events.findLast(event => event.type === 'compact/end')?.data)
      .toMatchObject({ error: 'plain failure' })
  })

  it('rejects concurrent durable appends before committing the replacement', async () => {
    const compact = service()
    const session = conversation(2)
    compact.mutateDuringSummary = () => {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    const nodes = session.surface.nodes

    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[2]!,
      agent(session, MODEL),
    )).rejects.toThrow(/session log changed/)
    expect(session.events.some(event => event.type === 'compact/summary')).toBe(false)
  })

  it('rejects a non-shrinking framed summary under the conversation meter', async () => {
    const compact = service()
    compact.summary = Array.from({ length: 100 }, (_, index) => ({
      type: 'text',
      text: `verbose ${index}`,
    }))
    const session = conversation(2)
    const nodes = session.surface.nodes

    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[2]!,
      agent(session, MODEL),
    )).rejects.toThrow(/summary is not smaller/)
    expect(session.events.some(event => event.type === 'compact/summary')).toBe(false)
  })

  it('lets a model-independent custom summarizer compact without a conversation model', async () => {
    const compact = service()
    const session = conversation(1)
    const nodes = session.surface.nodes
    await expect(compact.compactRegion(
      nodes[0]!,
      nodes[1]!,
      agent(session),
    )).resolves.toMatchObject({ shadowedSeqs: [nodes[0]!, nodes[1]!] })
  })
})

class ScriptedAdapter extends LlmAdapter {
  lastOptions: GenerateOptions | undefined

  constructor(
    private readonly blocks: readonly ContentBlock[],
    private readonly finish: (StreamChunk & { type: 'finish' })['reason'] = { kind: 'stop' },
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    for (const [index, block] of this.blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      if (block.type === 'text') {
        yield { type: 'text-delta', index, text: block.text }
      } else if (block.type === 'reasoning') {
        yield { type: 'reasoning-delta', index, text: block.text }
      } else {
        yield { type: 'block-end', index, block }
      }
    }
    yield { type: 'finish', reason: this.finish }
  }
}

class ExposedCompactService extends BasicCompactService {
  runSummarize(
    text: string,
    owner: Agent,
    signal?: AbortSignal,
  ): Promise<{ summary: ContentBlock[]; provider: string; model: string; maxTokens?: number }> {
    return this.summarize(text, owner, signal)
  }
}

async function summarizerHarness(
  blocks: readonly ContentBlock[],
  finish?: (StreamChunk & { type: 'finish' })['reason'],
  model = MODEL,
  config: BasicCompactConfig = { auto: false },
): Promise<{ ctx: Context; adapter: ScriptedAdapter; compact: ExposedCompactService }> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  void new TokenMeterService(ctx, { contextWindow: 1_000 })
  const adapter = new ScriptedAdapter(blocks, finish)
  ctx.llm.registerAdapter([model], adapter)
  const compact = new ExposedCompactService(ctx, config)
  return { ctx, adapter, compact }
}

describe('default one-shot summarizer', () => {
  it('uses configured model/default cap, forwards cancellation, and keeps only safe text', async () => {
    const { adapter, compact } = await summarizerHarness([
      { type: 'reasoning', text: 'private' },
      { type: 'text', text: 'public summary' },
      { type: 'tool-call', id: CallId('unexpected'), name: 'x', arguments: '{}' },
    ], undefined, MODEL, {
      auto: false,
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 321,
    })
    const session = conversation(1)
    const output = await compact.runSummarize('transcript', agent(session, 'fallback'), SIGNAL)

    expect(output).toEqual({
      summary: [{ type: 'text', text: 'public summary' }],
      provider: MODEL,
      model: MODEL,
      maxTokens: 321,
    })
    expect(adapter.lastOptions).toMatchObject({
      provider: MODEL,
      model: MODEL,
      maxTokens: 321,
      signal: SIGNAL,
      sessionId: session.id,
    })
    expect(adapter.lastOptions?.system).toContain('## Primary Request and Intent')
  })

  it('resolves the latest routed provider/model before the AgentOptions pair', async () => {
    const { adapter, compact } = await summarizerHarness([{ type: 'text', text: 'summary' }], undefined, 'routed')
    const session = conversation(1)
    session.append('request/header', {
      header: { config: { provider: 'routed', model: 'routed' } },
      reason: 'initial',
    })
    const output = await compact.runSummarize('history', agent(session, 'fallback'))
    expect(output.provider).toBe('routed')
    expect(output.model).toBe('routed')
    expect(adapter.lastOptions?.provider).toBe('routed')
    expect(adapter.lastOptions?.model).toBe('routed')
  })

  it('fails clearly when no complete summarization target can be resolved', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    void new TokenMeterService(ctx)
    const compact = new ExposedCompactService(ctx, { auto: false })
    await expect(compact.runSummarize('history', agent(new Session(SessionId('model-less')))))
      .rejects.toThrow(/no provider\/model available for summarization/)
  })

  it.each([
    [{ kind: 'error', message: 'provider failed', code: 'PROVIDER' }, 'PROVIDER', /provider failed/],
    [{ kind: 'error', message: 'opaque' }, undefined, /opaque/],
    [{ kind: 'aborted' }, 'ABORTED', /aborted/],
    [{ kind: 'max-tokens' }, 'MAX_TOKENS', /token cap/],
  ] as Array<[(StreamChunk & { type: 'finish' })['reason'], string | undefined, RegExp]>) (
    'rejects terminal finish %#',
    async (finish, code, pattern) => {
      const { compact } = await summarizerHarness([], finish)
      let thrown: unknown
      try {
        await compact.runSummarize('history', agent(conversation(1), MODEL))
      } catch (error: unknown) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(pattern)
      expect((thrown as Error & { code?: string }).code).toBe(code)
    },
  )

  it('rejects empty or reasoning-only successful output', async () => {
    const { compact } = await summarizerHarness([{ type: 'reasoning', text: 'private' }])
    await expect(compact.runSummarize('history', agent(conversation(1), MODEL)))
      .rejects.toThrow(/no text summary content/)
  })
})

describe('automatic listener and loader composition', () => {
  function preStep(ctx: Context, owner: Agent): Promise<unknown> {
    return ctx.serial('agent/pre-step', owner, 1, 1, '', [], SIGNAL)
  }

  it('compacts above threshold and remains idle below it', async () => {
    const ctx = createContext()
    const compact = new TestCompactService(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const pressured = conversation(4)
    await preStep(ctx, agent(pressured, MODEL))
    expect(pressured.events.some(event => event.type === 'compact/summary')).toBe(true)

    const small = conversation(1)
    await preStep(ctx, agent(small, MODEL))
    expect(small.events.some(event => event.type === 'compact/start')).toBe(false)
    expect(compact.calls).toHaveLength(1)
  })

  it('warns and continues after operational failures, including non-Errors', async () => {
    const ctx = createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const compact = new TestCompactService(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    compact.error = 'temporary failure'
    const session = conversation(4)

    await expect(preStep(ctx, agent(session, MODEL))).resolves.toBeUndefined()
    expect(warnings).toContainEqual(expect.stringContaining('temporary failure'))
    expect(session.events.some(event => event.type === 'compact/summary')).toBe(false)
  })

  it('auto:false installs no listener', async () => {
    const ctx = createContext()
    void new TestCompactService(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const session = conversation(4)
    await preStep(ctx, agent(session, MODEL))
    expect(session.events.some(event => event.type === 'compact/start')).toBe(false)
  })

  it('loads and disposes the real zero-config service stack', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const meterFiber = await ctx.plugin(TokenMeterService)
    const compactFiber = await ctx.plugin(BasicCompactService, { auto: false })

    expect(ctx.tokenMeter.contextWindow).toBe(128_000)
    expect(ctx.get('compact')).toBeInstanceOf(BasicCompactService)
    await compactFiber.dispose()
    expect(ctx.get('compact')).toBeUndefined()
    await meterFiber.dispose()
    expect(ctx.get('tokenMeter')).toBeUndefined()
  })

  it('removes its automatic listener with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(TokenMeterService, { contextWindow: 1_000 })
    const fiber = await ctx.plugin(TestCompactService, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    await fiber.dispose()

    const session = conversation(4)
    await preStep(ctx, agent(session, MODEL))
    expect(session.events.some(event => event.type === 'compact/start')).toBe(false)
  })
})
