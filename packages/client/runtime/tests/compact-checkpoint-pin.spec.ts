/**
 * Drift trap for the compaction-checkpoint recognition rule.
 *
 * `TranscriptAdapter` restates the compaction seam's checkpoint source as a
 * local literal because it cannot import `dsh-compact` in any form: a VALUE
 * import fails the client purity gate, and a TYPE-ONLY import fails typecheck —
 * `dsh-compact`'s root reaches `dsh-session`'s root, whose cordis `Context`
 * merge declares the HOST `sessions: SessionStore` against the client program's
 * `sessions: ISessions` (`TS2717`). This spec runs in the client TEST program,
 * which does not carry that collision, and it is the only thing keeping the two
 * implementations from drifting: it drives the adapter with a checkpoint built
 * from the canonical `COMPACT_CHECKPOINT_SOURCE` itself, so renaming the seam's
 * plugin fails HERE instead of silently deleting every compaction marker from
 * the web transcript.
 */

import { COMPACT_CHECKPOINT_SOURCE, isCompactCheckpointSource } from '@deepseek-ai/dsh-compact'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { TranscriptAdapter } from '../src/client/sessions/transcript-adapter.ts'

/** A replacement user message stamped with the seam's own canonical source. */
function canonicalCheckpoint(seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1_700_000_000_000 + seq,
    surfaceOp: { op: 'replace', start: 0, end: 0 },
    sourceEventSeqs: [0],
    data: createUserMessage({
      content: [{ type: 'text', text: '<context_checkpoint>model only</context_checkpoint>' }],
      source: COMPACT_CHECKPOINT_SOURCE,
    }),
  } as unknown as SessionEvent
}

describe('compaction checkpoint recognition', () => {
  it('recognizes a checkpoint carrying the seam-canonical source', () => {
    const adapter = new TranscriptAdapter()
    adapter.reset([canonicalCheckpoint(1)])
    expect(adapter.nodes()).toEqual([{ kind: 'compaction', seq: 1, time: 1_700_000_000_001, summary: null }])
  })

  it('agrees with the seam s own predicate on the source it recognizes', () => {
    // Both sides answer the same question about the same value: if the seam
    // renames its plugin, this equality is what breaks.
    const checkpoint = canonicalCheckpoint(1)
    expect(checkpoint.type === 'user/message' && isCompactCheckpointSource(checkpoint.data.source)).toBe(true)
    expect(COMPACT_CHECKPOINT_SOURCE).toEqual({ kind: 'plugin', plugin: 'compact' })
  })
})
