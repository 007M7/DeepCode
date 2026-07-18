import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compact'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import { BasicCompactService } from '@deepseek-ai/dsh-compact-basic'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'
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

function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('CBR-001: a real-loop checkpoint is a valid boundary on both sides', () => {
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
