import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { COMPACT_CHECKPOINT_SOURCE } from '@deepseek-ai/dsh-compact'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'workspace-context-compaction'

/** Replace the visible workspace baseline before the snapshot's second step. */
export function apply(ctx: Context): void {
  ctx.on('agent/step', (agent, turn, step) => {
    if (turn !== 1 || step !== 2) return
    const baseline = agent.session.surface.nodes
      .map(seq => agent.session.events[seq])
      .find(event => event?.type === 'user/message'
        && event.data.source.kind === 'workspace-instructions'
        && event.data.source.baseline === true)
    if (baseline === undefined) throw new Error('workspace baseline missing before snapshot compaction')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Earlier context was compacted for this snapshot.' }],
      source: COMPACT_CHECKPOINT_SOURCE,
    }), {
      surfaceOp: { op: 'replace', start: baseline.seq, end: baseline.seq },
      sourceEventSeqs: [baseline.seq],
    })
  })
}
