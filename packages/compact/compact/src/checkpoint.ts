/**
 * The compaction seam's canonical checkpoint source: the plugin marker every
 * backend stamps on the replacement user message that lands a checkpoint, plus
 * the predicate that recognizes it.
 *
 * The seam itself lives in `@deepseek-ai/dsh-compact`, which re-exports both of
 * these; this module is a pure value/predicate outlet (no cordis imports, no
 * module augmentation) so client and wire programs can name the checkpoint
 * source without loading the host plugin's Context merges — the
 * `dsh-commands/brand` shape.
 *
 * @module @deepseek-ai/dsh-compact/checkpoint
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm/message'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { CompactionId } from './brand.ts'

/** Canonical source for the replacement user message produced by every compaction backend. */
export const COMPACT_CHECKPOINT_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'compact' } as const)

/** Message provenance carried by a concrete compaction checkpoint. */
export type CompactCheckpointSource = typeof COMPACT_CHECKPOINT_SOURCE & {
  readonly compactionId: CompactionId
  readonly sourceCommandId?: CommandId
}

/**
 * Create checkpoint provenance correlated with one compaction transaction.
 * @param compactionId - owning compaction identity.
 * @param sourceCommandId - initiating manual command, when present.
 * @returns immutable checkpoint source.
 */
export function compactCheckpointSource(
  compactionId: CompactionId,
  sourceCommandId?: CommandId,
): CompactCheckpointSource {
  return Object.freeze({
    ...COMPACT_CHECKPOINT_SOURCE,
    compactionId,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
  })
}

/**
 * Test whether a persisted message source identifies a compaction checkpoint.
 * @param source - source restored from a surface user message.
 * @returns whether the source carries the backend-independent checkpoint marker.
 */
export function isCompactCheckpointSource(source: MessageSource): boolean {
  return source.kind === 'plugin' && source.plugin === COMPACT_CHECKPOINT_SOURCE.plugin
}
