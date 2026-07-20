import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import BasicCompactService from '@deepseek-ai/dsh-compact-basic'
import type { BasicCompactConfig } from '@deepseek-ai/dsh-compact-basic'
import { selectCompactableRange } from '@deepseek-ai/dsh-compact-basic/src/region.ts'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compact'
import { resolveConfig } from '@deepseek-ai/dsh-compact-basic/src/config.ts'
import type { CompactionResult } from '@deepseek-ai/dsh-compact'
import LlmService, { CallId, CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import ToolResultPruneService from '@deepseek-ai/dsh-compact-tool-result-prune'

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
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
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
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
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

/** One closed routed tool step followed by an open turn for rewrite events. */
function oversizedToolResult(chars = 3_000, withCompactablePrompt = false): Session {
  const session = new Session(SessionId(`oversized-tool-${chars}`))
  const callId = CallId('oversized')
  session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  if (withCompactablePrompt) {
    session.append('user/message', {
      content: [{ type: 'text', text: 'older history '.repeat(200) }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
  }
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
    provenance: { provider: MODEL, model: MODEL },
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    callId,
    content: [{ type: 'text', text: 'X'.repeat(chars) }],
    isError: false,
    meta: { presentation: 'preserved' },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
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
  trigger: 'pressure' | 'context-overflow' = 'pressure',
  model: string | undefined = MODEL,
): Promise<CompactionResult | null> {
  return compact.compactIfNeeded(agent(session, model), trigger, SIGNAL)
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
      maxOverflowRetries: 1,
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
      [{ maxOverflowRetries: -1 }, /maxOverflowRetries/],
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

  it('skips when no durable routed model exists instead of using AgentOptions fallback', async () => {
    const compact = service(compactConfig)
    const session = new Session(SessionId('headerless'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    await expect(compact.compactIfNeeded(agent(session, MODEL), 'pressure', SIGNAL))
      .resolves.toBeNull()
    expect(compact.calls).toHaveLength(0)
  })

  it('meters any routed model without profile resolution', async () => {
    const compact = service(compactConfig)
    const session = conversation()
    session.append('request/header', {
      header: { config: { provider: 'unlisted-provider', model: 'unlisted-model' } },
      reason: 'resume',
    })
    await expect(compactIfNeeded(compact, session))
      .resolves.not.toBeNull()
  })

  it('declines forced overflow when the whole surface is one indivisible tool pair', async () => {
    const compact = service(compactConfig)
    const session = new Session(SessionId('single-tool-pair'))
    const callId = CallId('single-call')
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
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
    const generation = session.surface.replaceGeneration

    await expect(compactIfNeeded(compact, session, 'context-overflow')).resolves.toBeNull()
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(session.events.some(event => event.type === 'compact/start')).toBe(false)
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

  it('counts the durable routed request envelope without putting its prefix on the surface', async () => {
    const compact = service({
      auto: false,
      thresholdRatio: 0.9,
      retainTokens: 50,
    })
    const session = conversation(2, 'x'.repeat(600))
    expect(await compactIfNeeded(compact, session)).toBeNull()

    const prefix = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'p'.repeat(600) }] }]
    session.append('request/header', {
      header: {
        config: { provider: MODEL, model: MODEL },
        system: 's'.repeat(600),
        messagePrefix: prefix,
      },
      reason: 'resume',
    })
    const result = await compactIfNeeded(compact, session)
    expect(result).not.toBeNull()
    expect(prefix).toHaveLength(1)
    expect(session.events.some(event => event.type === 'context/message')).toBe(false)
  })

  it('uses the latest logged request envelope without an AgentOptions override', async () => {
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

    const result = await compactIfNeeded(compact, session, 'pressure', 'fallback')
    expect(result).not.toBeNull()
    expect(session.requestHeader()?.config.model).toBe('actual')
    expect(measure.mock.calls[0]).toEqual([session])
  })

  it('declines when envelope pressure is high but the surface has no compactable range', async () => {
    const compact = service(compactConfig)
    const empty = new Session(SessionId('empty'))
    empty.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    empty.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL }, system: 'x'.repeat(100_000) },
      reason: 'initial',
    })
    expect(await compactIfNeeded(compact, empty)).toBeNull()

    const retained = conversation(1)
    retained.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL }, system: 'x'.repeat(100_000) },
      reason: 'resume',
    })
    expect(await compactIfNeeded(compact, retained)).toBeNull()
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

describe('optional model-free tool-result pruning', () => {
  const pruneConfig = { thresholdChars: 100, headChars: 20, tailChars: 10 }

  it('does not prune a below-pressure session opportunistically', async () => {
    const ctx = createContext(10_000)
    const prune = new ToolResultPruneService(ctx, pruneConfig)
    const compact = new TestCompactService(ctx, {
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 100,
    })
    const session = oversizedToolResult()
    const pruneSession = vi.spyOn(prune, 'pruneSession')

    expect(await compactIfNeeded(compact, session)).toBeNull()
    expect(pruneSession).not.toHaveBeenCalled()
    expect(compact.calls).toHaveLength(0)
    expect(session.surface.replaceGeneration).toBe(0)
  })

  it('skips LLM summarization when pruning alone clears pressure', async () => {
    const ctx = createContext(1_000)
    void new ToolResultPruneService(ctx, pruneConfig)
    const compact = new TestCompactService(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })
    const session = oversizedToolResult()

    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThanOrEqual(500)
    expect(await compactIfNeeded(compact, session)).toBeNull()
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(500)
    expect(compact.calls).toHaveLength(0)
    expect(session.surface.replaceGeneration).toBe(1)
  })

  it('summarizes the pruned surface when pruning is insufficient', async () => {
    const ctx = createContext(2_000)
    void new ToolResultPruneService(ctx, pruneConfig)
    const compact = new TestCompactService(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })
    const session = toolConversation()

    expect(await compactIfNeeded(compact, session)).not.toBeNull()
    expect(compact.calls).toHaveLength(1)
    expect(compact.calls[0]!.text).toContain('tool result middle pruned')
    expect(compact.calls[0]!.text).not.toContain('result 1 '.repeat(300))
  })

  it('retains the original compact-basic behavior without the optional plugin', async () => {
    const ctx = createContext(2_000)
    const compact = new TestCompactService(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })
    const session = oversizedToolResult(3_000, true)

    expect(await compactIfNeeded(compact, session)).not.toBeNull()
    expect(compact.calls).toHaveLength(1)
    const original = session.events.find(event => event.type === 'tool/result')
    expect(original?.type === 'tool/result' && original.data.content[0])
      .toEqual({ type: 'text', text: 'X'.repeat(3_000) })
    expect(session.events.filter(event =>
      event.type === 'tool/result' && event.surfaceOp !== 'append')).toHaveLength(0)
  })
})

describe('compaction region transaction', () => {
  it('lands a framed, replayable checkpoint with exact pricing provenance', async () => {
    const compact = service()
    const session = conversation(3)
    const before = [...session.surface.nodes]
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
    const session = new Session(SessionId('model-less-region'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', {
      content: [{ type: 'text', text: 'history '.repeat(100) }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      provenance: { provider: 'historical', model: 'historical' },
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'answer '.repeat(100) }],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
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

  it('records the model actually dispatched after one-shot stream routing', async () => {
    const { ctx, compact } = await summarizerHarness([{ type: 'text', text: 'unused' }])
    const routedAdapter = new ScriptedAdapter([{ type: 'text', text: 'routed summary' }])
    ctx.llm.registerAdapter(['routed-summary-provider'], routedAdapter)
    ctx.on('llm/stream', (options, next) => {
      options.provider = 'routed-summary-provider'
      options.model = 'routed-summary-model'
      return next()
    })

    const session = conversation(3, 'large history '.repeat(500))
    const nodes = session.surface.nodes
    await compact.compactRegion(nodes[0]!, nodes[3]!, agent(session, MODEL), SIGNAL)
    expect(session.events.findLast(event => event.type === 'compact/summary')?.data).toMatchObject({
      summary: [{ type: 'text', text: 'routed summary' }],
      provider: 'routed-summary-provider',
      model: 'routed-summary-model',
    })
    expect(routedAdapter.lastOptions?.provider).toBe('routed-summary-provider')
    expect(routedAdapter.lastOptions?.model).toBe('routed-summary-model')
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
    [{ kind: 'error', failure: { message: 'provider failed', code: 'PROVIDER' } }, 'PROVIDER', /provider failed/],
    [{ kind: 'error', failure: { message: 'opaque', code: 'UNKNOWN' } }, 'UNKNOWN', /opaque/],
    [{ kind: 'aborted', failure: { message: 'summarization aborted', code: 'ABORTED' } }, 'ABORTED', /aborted/],
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
  function postStep(ctx: Context, owner: Agent, signal = SIGNAL): Promise<unknown> {
    return agentEvents(ctx, owner).serial('agent/post-step', 1, 1, signal)
  }

  function recover(
    ctx: Context,
    owner: Agent,
    error: Error & { code?: string },
    retryAttempt = 0,
    signal = SIGNAL,
    next: () => Promise<{ action: 'fail' | 'retry' }> = () => Promise.resolve({ action: 'fail' }),
  ): Promise<{ action: 'fail' | 'retry' }> {
    const failure: LlmFailure = { message: error.message, code: error.code ?? 'UNKNOWN' }
    const priorFailures = Object.freeze(Array.from({ length: retryAttempt }, () => failure))
    return agentEvents(ctx, owner).waterfall(
      'agent/request-error', 1, 1, error, failure, priorFailures, signal, next,
    )
  }

  function overflow(message = 'provider overflow'): Error & { code: string } {
    return Object.assign(new Error(message), { code: CONTEXT_WINDOW_EXCEEDED_CODE })
  }

  it('compacts post-step above threshold using the durable routed model and remains idle below it', async () => {
    const ctx = createContext()
    const compact = new TestCompactService(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const pressured = conversation(4)
    await postStep(ctx, agent(pressured, 'unconfigured-agent-fallback'))
    expect(pressured.events.some(event => event.type === 'compact/summary')).toBe(true)

    const small = conversation(1)
    await postStep(ctx, agent(small, MODEL))
    expect(small.events.some(event => event.type === 'compact/start')).toBe(false)
    expect(compact.calls).toHaveLength(1)
  })

  it('skips post-step pressure when the step signal is already aborted', async () => {
    const ctx = createContext()
    const compact = new TestCompactService(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const pressured = conversation(4)
    const compactIfNeeded = vi.spyOn(compact, 'compactIfNeeded')

    await expect(postStep(ctx, agent(pressured, MODEL), AbortSignal.abort('step aborted')))
      .resolves.toBeUndefined()

    expect(compactIfNeeded).not.toHaveBeenCalled()
    expect(pressured.events.some(event => event.type === 'compact/start')).toBe(false)
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

    await expect(postStep(ctx, agent(session, MODEL))).resolves.toBeUndefined()
    expect(warnings).toContainEqual(expect.stringContaining('temporary failure'))
    expect(session.events.some(event => event.type === 'compact/summary')).toBe(false)
  })

  it('force-compacts below normal pressure for canonical overflow and retries only after replacement', async () => {
    const ctx = createContext(10_000)
    void new TestCompactService(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = conversation(3)
    const beforeGeneration = session.surface.replaceGeneration
    const retainedSeq = session.surface.nodes.at(-1)!
    const threshold = 10_000
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(threshold)
    const decision = await recover(ctx, agent(session, 'unconfigured-agent-fallback'), overflow())

    expect(decision).toEqual({ action: 'retry' })
    expect(session.surface.replaceGeneration).toBe(beforeGeneration + 1)
    expect(session.events.some(event => event.type === 'compact/summary')).toBe(true)
    expect(session.surface.nodes).toContain(retainedSeq)
  })

  it('authorizes overflow retry when pruning alone advances an indivisible surface', async () => {
    const ctx = createContext(10_000)
    void new ToolResultPruneService(ctx, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactService(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = oversizedToolResult()

    expect(await recover(ctx, agent(session, MODEL), overflow())).toEqual({ action: 'retry' })
    expect(session.surface.replaceGeneration).toBe(1)
    expect(session.events.some(event => event.type === 'compact/summary')).toBe(false)
    expect(compact.calls).toHaveLength(0)
  })

  it('continues overflow recovery with summarization on the pruned surface', async () => {
    const ctx = createContext(10_000)
    void new ToolResultPruneService(ctx, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactService(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = toolConversation()

    expect(await recover(ctx, agent(session, MODEL), overflow())).toEqual({ action: 'retry' })
    expect(session.events.some(event => event.type === 'compact/summary')).toBe(true)
    expect(compact.calls).toHaveLength(1)
    expect(compact.calls[0]!.text).toContain('tool result middle pruned')
  })

  it('retries from a durable prune when later overflow summarization throws', async () => {
    const ctx = createContext(10_000)
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    void new ToolResultPruneService(ctx, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactService(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    compact.error = new Error('summary unavailable after prune')
    const session = oversizedToolResult(3_000, true)

    expect(await recover(ctx, agent(session, MODEL), overflow())).toEqual({ action: 'retry' })
    expect(session.surface.replaceGeneration).toBe(1)
    expect(session.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(session.events.findLast(event => event.type === 'compact/end')?.data)
      .toMatchObject({ error: 'summary unavailable after prune' })
    expect(warnings).toContainEqual(expect.stringContaining('retrying from the replacement surface'))
  })

  it('lets cancellation win when summary throws after a durable prune', async () => {
    const ctx = createContext(10_000)
    const controller = new AbortController()
    void new ToolResultPruneService(ctx, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactService(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    compact.mutateDuringSummary = () => { controller.abort('cancelled during summary') }
    compact.error = new Error('summary cancelled after prune')
    const session = oversizedToolResult(3_000, true)

    expect(await recover(ctx, agent(session, MODEL), overflow(), 0, controller.signal))
      .toEqual({ action: 'fail' })
    expect(session.surface.replaceGeneration).toBe(1)
  })

  it('preserves the newest whole tool-call/result pair during forced overflow compaction', async () => {
    const ctx = createContext()
    void new TestCompactService(ctx, {
      thresholdRatio: 1,
      retainTokens: 90,
    })
    const session = toolConversation()
    const newestAssistant = session.surface.nodes.at(-2)!
    const newestResult = session.surface.nodes.at(-1)!

    expect(await recover(ctx, agent(session, MODEL), overflow())).toEqual({ action: 'retry' })
    const currentAssistant = session.surface.nodes.find(node => node === newestAssistant)
    const currentResult = session.surface.nodes.find(node => node === newestResult)
    expect(currentAssistant).toBeDefined()
    expect(currentResult).toBeDefined()
    expect(toolPairingBalancedBefore(session, currentAssistant!)).toBe(true)
    expect(toolPairingBalancedAfter(session, currentResult!)).toBe(true)
  })

  it('does not retry when a backend reports success without replacing the surface', async () => {
    const ctx = createContext()
    const compact = new TestCompactService(ctx)
    const session = conversation(2)
    const fakeResult: CompactionResult = {
      startSeq: 1,
      summarySeq: 2,
      endSeq: 3,
      summary: [{ type: 'text', text: 'fake' }],
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 10,
    }
    vi.spyOn(compact, 'compactIfNeeded').mockResolvedValue(fakeResult)

    expect(await recover(ctx, agent(session, MODEL), overflow())).toEqual({ action: 'fail' })
    expect(session.surface.replaceGeneration).toBe(0)
  })

  it('delegates downstream exactly once when no replacement is available', async () => {
    const ctx = createContext()
    const compact = new TestCompactService(ctx)
    vi.spyOn(compact, 'compactIfNeeded').mockResolvedValue(null)
    const downstream = new Error('downstream recovery failed')
    let calls = 0

    await expect(recover(
      ctx,
      agent(conversation(2), MODEL),
      overflow(),
      0,
      SIGNAL,
      () => {
        calls += 1
        return Promise.reject(downstream)
      },
    )).rejects.toBe(downstream)
    expect(calls).toBe(1)
  })

  it('preserves the original provider error when recovery throws', async () => {
    const ctx = createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const compact = new TestCompactService(ctx)
    compact.error = new Error('summary unavailable')
    const original = overflow('original provider overflow')

    expect(await recover(ctx, agent(conversation(3), MODEL), original)).toEqual({ action: 'fail' })
    expect(original).toMatchObject({
      message: 'original provider overflow',
      code: CONTEXT_WINDOW_EXCEEDED_CODE,
    })
    expect(warnings).toContainEqual(expect.stringContaining('preserving the original request error'))
  })

  it('delegates once when overflow recovery throws a non-Error value', async () => {
    const ctx = createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const compact = new TestCompactService(ctx)
    compact.error = 'non-error recovery failure'
    const session = conversation(3)
    const generation = session.surface.replaceGeneration
    const original = overflow('original provider failure')
    let delegations = 0

    const decision = await recover(ctx, agent(session, MODEL), original, 0, SIGNAL, () => {
      delegations += 1
      return Promise.resolve({ action: 'fail' })
    })

    expect(decision).toEqual({ action: 'fail' })
    expect(delegations).toBe(1)
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(original).toMatchObject({
      message: 'original provider failure',
      code: CONTEXT_WINDOW_EXCEEDED_CODE,
    })
    expect(warnings).toContainEqual(expect.stringContaining('non-error recovery failure'))
  })

  it('recovers an overflow for an unlisted routed model', async () => {
    const ctx = createContext()
    void new TestCompactService(ctx)
    const session = conversation(2)
    session.append('request/header', {
      header: { config: { provider: 'unknown-routed-provider', model: 'unknown-routed-model' } },
      reason: 'resume',
    })
    expect(await recover(ctx, agent(session, MODEL), overflow('unlisted-model overflow')))
      .toEqual({ action: 'retry' })
  })

  it('honors retry caps, non-context failures, and cancellation', async () => {
    const ctx = createContext()
    const compact = new TestCompactService(ctx, { maxOverflowRetries: 1 })
    const compactSpy = vi.spyOn(compact, 'compactIfNeeded')
    const owner = agent(conversation(3), MODEL)
    expect(await recover(ctx, owner, Object.assign(new Error('rate limit'), { code: 'RATE_LIMIT' })))
      .toEqual({ action: 'fail' })
    expect(await recover(ctx, owner, overflow(), 1)).toEqual({ action: 'fail' })

    const controller = new AbortController()
    controller.abort('cancelled')
    expect(await recover(ctx, owner, overflow(), 0, controller.signal)).toEqual({ action: 'fail' })
    expect(compactSpy).not.toHaveBeenCalled()
  })

  it('does not retry when cancellation lands during an awaited compaction', async () => {
    const ctx = createContext()
    const compact = new TestCompactService(ctx)
    const controller = new AbortController()
    compact.mutateDuringSummary = () => { controller.abort('cancelled during summary') }
    const session = conversation(3)
    const generation = session.surface.replaceGeneration

    expect(await recover(ctx, agent(session, MODEL), overflow(), 0, controller.signal))
      .toEqual({ action: 'fail' })
    expect(session.surface.replaceGeneration).toBe(generation + 1)
  })

  it('maxOverflowRetries:0 disables recovery without disabling post-step pressure', async () => {
    const ctx = createContext()
    void new TestCompactService(ctx, {
      maxOverflowRetries: 0,
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const session = conversation(4)
    await postStep(ctx, agent(session, MODEL))
    const summaries = session.events.filter(event => event.type === 'compact/summary').length
    expect(summaries).toBe(1)
    expect(await recover(ctx, agent(session, MODEL), overflow())).toEqual({ action: 'fail' })
    expect(session.events.filter(event => event.type === 'compact/summary')).toHaveLength(summaries)
  })

  it('auto:false installs neither automatic listener', async () => {
    const ctx = createContext()
    void new TestCompactService(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const session = conversation(4)
    await postStep(ctx, agent(session, MODEL))
    expect(session.events.some(event => event.type === 'compact/start')).toBe(false)
    expect(await recover(ctx, agent(session, MODEL), overflow())).toEqual({ action: 'fail' })
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
    await postStep(ctx, agent(session, MODEL))
    expect(session.events.some(event => event.type === 'compact/start')).toBe(false)
    expect(await recover(ctx, agent(session, MODEL), overflow())).toEqual({ action: 'fail' })
  })
})
