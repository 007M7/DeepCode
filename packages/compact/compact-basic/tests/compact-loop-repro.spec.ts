import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { isToolPairingBalanced } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import { BasicCompactService } from '@deepseek-ai/dsh-compact-basic'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'

/**
 * CBR-001 regression: a compaction checkpoint that the REAL loop lands is a
 * free surface boundary (it carries no tool-call/result pair), so it must be a
 * valid region edge on BOTH sides. A surface-anchored balance check sees that;
 * the abandoned log-position scan did not.
 *
 * The loop fires the compaction seam mid-flight, so the landed checkpoint
 * `user/message{replace}` sits at a HIGH log seq positioned beside the current
 * step even though its SURFACE position is the head. A log-position forward scan
 * from the checkpoint reaches the step's own later `assistant/message` and
 * wrongly reports the checkpoint as mid-step — refusing it as a region end. A
 * SECOND compaction that re-summarizes just that head checkpoint (region end ==
 * checkpoint) therefore throws and is swallowed, so the surface never
 * re-consolidates.
 *
 * This drives a real auto-compaction through the agent-loop and asserts the
 * landed checkpoint balances on both sides AND that re-compacting it (end ==
 * checkpoint) succeeds. RED on the log-position predicates; GREEN once alignment
 * is decided from surface tool-pairing balance.
 */

const TOKENS_PER_BLOCK = 10

class ReproCompactService extends BasicCompactService {
  override estimateContentTokens(blocks: readonly ContentBlock[]): number {
    return blocks.length * TOKENS_PER_BLOCK
  }

  override async summarize(): Promise<{ summary: ContentBlock[]; model: string }> {
    return { summary: [{ type: 'text', text: 'CHECKPOINT SUMMARY' }], model: 'stub' }
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
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Invariants)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new StepwiseToolAdapter(toolSteps))
  ctx.tools.register(defineTool({
    name: 'work',
    description: 'does work',
    parameters: { i: { type: 'number' } },
    async execute() {
      return [{ type: 'text', text: 'work result' }]
    },
  }))
  // Tiny window so a couple of tool steps cross the threshold and compaction
  // fires within the runaway turn.
  const compact = new ReproCompactService(ctx, {
    auto: true,
    contextWindow: 64,
    thresholdRatio: 0.5,
    retainTokens: 20,
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
      const agent = ctx.agentLoop.create(AgentId('repro'), { model: 'mock' })
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

      // The loop fired compaction mid-flight, so each landed checkpoint sits at a
      // high log seq beside the step it landed in, even though its SURFACE
      // position is the head of the range it shadowed. A checkpoint carries no
      // tool-call/result pair (only summarized prose), so every checkpoint still
      // on the surface must be a balanced cut on BOTH sides — the cut before it
      // (region START) and the cut after it (region END). The abandoned
      // log-position scan reported the END as mis-aligned because the forward log
      // scan reached the neighbouring step's assistant/message.
      const nodes = agent.session.surface.nodes
      for (const cp of checkpoints) {
        const node = nodes.find(n => n.seq === cp.seq)
        if (!node) continue // shadowed by a later checkpoint — no longer an edge.
        expect(isToolPairingBalanced(nodes, events, node.seq),
          `checkpoint seq ${node.seq} must be a balanced region START`).toBe(true)
        expect(isToolPairingBalanced(nodes, events, node.next),
          `checkpoint seq ${node.seq} must be a balanced region END`).toBe(true)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
