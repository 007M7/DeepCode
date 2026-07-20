import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compact'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import { BasicCompactService } from '@deepseek-ai/dsh-compact-basic'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { SessionId, type SurfaceEvent } from '@deepseek-ai/dsh-session'

/**
 * CBR-001 regression through the real loop. A replacement checkpoint has a high
 * log seq at the surface head and carries no tool pair, so both adjacent cuts
 * must be safe and re-compacting that checkpoint alone must succeed. This pins
 * surface-position semantics rather than raw-log scanning.
 */

class ReproCompactService extends BasicCompactService {
  override async summarize(): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    return {
      summary: [{ type: 'text', text: 'CHECKPOINT SUMMARY' }],
      provider: 'mock',
      model: 'stub',
    }
  }
}

/** Each call emits one tool-call until exhausted, then a final text answer. */
class StepwiseToolAdapter extends LlmAdapter {
  calls = 0
  constructor(private toolSteps: number) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const n = this.calls
    this.calls += 1
    if (n < this.toolSteps) {
      const id = CallId(`c${n}`)
      const args = `{"i":${n}}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `step ${n}` } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'work', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'all done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** First conversation request overflows, then the rebuilt retry succeeds. */
class OverflowRecoveryAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []

  constructor(
    private readonly delivery: 'thrown' | 'in-band',
    private readonly transientAfterOverflow = false,
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.system?.includes('You are a compaction engine')) {
      this.summaryRequests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'RECOVERY CHECKPOINT' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    this.conversationRequests.push(options)
    if (this.conversationRequests.length === 1) {
      if (this.delivery === 'thrown') {
        throw new LlmError('request too large for model context', CONTEXT_WINDOW_EXCEEDED_CODE)
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'request too large for model context',
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
          },
        },
      }
      return
    }
    if (this.transientAfterOverflow && this.conversationRequests.length === 2) {
      throw new LlmError('temporary provider outage', 'SERVER')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(toolSteps: number): Promise<{ ctx: Context; compact: ReproCompactService }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Invariants)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeterService, { contextWindow: 400 })
  ctx.llm.registerAdapter(['mock'], new StepwiseToolAdapter(toolSteps))
  ctx.tools.register(defineTool({
    name: 'work',
    description: 'does work',
    parameters: { i: { type: 'number' } },
    async execute() {
      return [{ type: 'text', text: 'work result' }]
    },
  }))
  // Small window so several tool steps cross the threshold and compaction
  // fires within the runaway turn after enough history can shrink.
  const compact = new ReproCompactService(ctx, {
    auto: true,
    thresholdRatio: 0.5,
    retainTokens: 50,
    summarizationModel: '',
    maxTokens: 8192,
    compactionRetries: 1,
  })
  return { ctx, compact }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function seedOverflowHistory(agent: Agent): void {
  for (let turn = 1; turn <= 2; turn += 1) {
    const sentinel = turn === 1 ? 'OLD HISTORY SENTINEL' : 'RECENT HISTORY'
    agent.session.append('turn/start', {
      turn,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    agent.session.append('user/message', {
      content: [{ type: 'text', text: `${sentinel} ${'old context '.repeat(200)}` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    agent.session.append('step/start', { turn, step: 1 })
    agent.session.append('assistant/message', {
      provenance: { provider: 'mock', model: 'mock' },
      turn,
      step: 1,
      content: [{ type: 'text', text: `historical response ${turn} ${'detail '.repeat(200)}` }],
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn, step: 1 })
    agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

describe('CBR-001: a real-loop checkpoint is a valid boundary on both sides', () => {
  it('uses the model actually routed by agent/request for post-step pressure', async () => {
    const { ctx } = await harness(8)
    ctx.on('agent/request', async (_agent, _turn, _step, config) => ({ ...config, provider: 'mock', model: 'mock' }))
    try {
      const agent = ctx.agentLoop.create(SessionId('routed-pressure'), {
        provider: 'unconfigured-agent-fallback',
        model: 'unconfigured-agent-fallback',
      })
      agent.send([{ type: 'text', text: 'do a routed multi-step task' }])
      await waitForIdle(ctx, agent)

      expect(agent.session.requestHeader()?.config.model).toBe('mock')
      expect(agent.session.events.some(event => event.type === 'compact/summary')).toBe(true)
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs automatic pressure after the current tool result and before step/end', async () => {
    const { ctx } = await harness(8)
    try {
      const agent = ctx.agentLoop.create(SessionId('post-step-order'), { provider: 'mock', model: 'mock' })
      agent.send([{ type: 'text', text: 'do tool work' }])
      await waitForIdle(ctx, agent)

      const events = [...agent.session.events]
      const compactStart = events.find(event => event.type === 'compact/start')
      expect(compactStart).toBeDefined()
      const precedingResult = events.findLast(event =>
        event.type === 'tool/result' && event.seq < compactStart!.seq,
      )
      if (precedingResult?.type !== 'tool/result') throw new Error('expected a durable tool result before compaction')
      const stepEnd = events.find(event =>
        event.type === 'step/end'
        && event.data.step === precedingResult.data.step
        && event.seq > compactStart!.seq,
      )
      expect(precedingResult.seq).toBeLessThan(compactStart!.seq)
      expect(compactStart!.seq).toBeLessThan(stepEnd!.seq)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('the head checkpoint the loop lands is a balanced cut on both sides', async () => {
    const { ctx } = await harness(8)
    try {
      const agent = ctx.agentLoop.create(SessionId('repro'), { provider: 'mock', model: 'mock' })
      agent.send([{ type: 'text', text: 'do a long multi-step task' }])
      await waitForIdle(ctx, agent)

      const events = [...agent.session.events]
      // A compaction ran: at least one checkpoint landed on the surface.
      const checkpoints = events.filter(
        (e): e is SurfaceEvent =>
          e.type === 'user/message'
          && typeof (e as SurfaceEvent).surfaceOp === 'object',
      )
      expect(checkpoints.length).toBeGreaterThan(0)

      // High log position does not make a text-only checkpoint mid-step; both
      // its start and end cuts are balanced in surface order.
      const nodes = agent.session.surface.nodes
      for (const cp of checkpoints) {
        const index = nodes.indexOf(cp.seq)
        if (index === -1) continue // shadowed by a later checkpoint — no longer an edge.
        expect(toolPairingBalancedBefore(agent.session, cp.seq),
          `checkpoint seq ${cp.seq} must be a balanced region START`).toBe(true)
        expect(toolPairingBalancedAfter(agent.session, cp.seq),
          `checkpoint seq ${cp.seq} must be a balanced region END`).toBe(true)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('context-overflow recovery across the real loop and compact-basic', () => {
  it.each(['thrown', 'in-band'] as const)(
    'force-compacts a %s overflow between failed and retry steps',
    async (delivery) => {
      const ctx = new Context()
      const adapter = new OverflowRecoveryAdapter(delivery)
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(Invariants)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(TokenMeterService, { contextWindow: 128 })
      ctx.llm.registerAdapter(['mock'], adapter)
      ctx.on('agent/request', async (_agent, _turn, _step, config) => ({ ...config, provider: 'mock', model: 'mock' }))
      await ctx.plugin(BasicCompactService, {
        thresholdRatio: 1,
        retainTokens: 100,
        maxTokens: 64,
        compactionRetries: 0,
        maxOverflowRetries: 1,
      })

      try {
        const agent = ctx.agentLoop.create(SessionId(`overflow-${delivery}`), {
          provider: 'unconfigured-agent-fallback',
          model: 'unconfigured-agent-fallback',
        })
        seedOverflowHistory(agent)

        agent.send([{ type: 'text', text: 'continue from history' }])
        await agent.whenIdle()

        expect(adapter.conversationRequests).toHaveLength(2)
        expect(adapter.summaryRequests).toHaveLength(1)
        expect(JSON.stringify(adapter.conversationRequests[0]!.messages)).toContain('OLD HISTORY SENTINEL')
        const retry = JSON.stringify(adapter.conversationRequests[1]!.messages)
        expect(retry).toContain('RECOVERY CHECKPOINT')
        expect(retry).not.toContain('OLD HISTORY SENTINEL')

        const events = [...agent.session.events]
        const failedEnd = events.find(event =>
          event.type === 'step/end' && event.data.turn === 3 && event.data.step === 1,
        )!
        const retryStart = events.find(event =>
          event.type === 'step/start' && event.data.turn === 3 && event.data.step === 2,
        )!
        const compaction = events.filter(event =>
          event.type === 'compact/start'
          || event.type === 'compact/summary'
          || event.type === 'compact/end',
        )
        expect(compaction.map(event => event.type)).toEqual([
          'compact/start',
          'compact/summary',
          'compact/end',
        ])
        expect(compaction.every(event => event.seq > failedEnd.seq && event.seq < retryStart.seq)).toBe(true)
        expect(events.at(-1)).toMatchObject({
          type: 'turn/end',
          data: { reason: { kind: 'completed' } },
        })
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('keeps context-overflow and transient retry budgets independent in one sequence', async () => {
    const ctx = new Context()
    const adapter = new OverflowRecoveryAdapter('thrown', true)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Invariants)
    await ctx.plugin(LlmRetry, {
      maxTransientRetries: 1,
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeterService, { contextWindow: 128 })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(BasicCompactService, {
      thresholdRatio: 1,
      retainTokens: 100,
      maxTokens: 64,
      compactionRetries: 0,
      maxOverflowRetries: 1,
    })

    try {
      const agent = ctx.agentLoop.create(SessionId('alternating-recovery'), { provider: 'mock', model: 'mock' })
      seedOverflowHistory(agent)
      agent.send([{ type: 'text', text: 'continue from history' }])
      await agent.whenIdle()

      expect(adapter.conversationRequests).toHaveLength(3)
      expect(adapter.summaryRequests).toHaveLength(1)
      expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => event.data))
        .toEqual([expect.objectContaining({ step: 2, retry: 1, failure: { message: 'temporary provider outage', code: 'SERVER' } })])
      expect(agent.session.events.filter(event => event.type === 'step/start').slice(-3).map(event => event.data.step))
        .toEqual([1, 2, 3])
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
