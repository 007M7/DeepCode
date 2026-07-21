/** Scenario-level sharding for one ACP snapshot suite. */

/** A one-based, exhaustive partition of a scenario table. */
export interface SnapshotScenarioShard {
  /** One-based lane index. */
  index: number
  /** Total number of lanes. */
  total: number
}

/**
 * Select one stable modulo partition while rejecting empty or malformed lanes.
 *
 * @param scenarios Complete ordered scenario table.
 * @param shard Optional one-based shard description.
 * @returns The complete table or the selected non-empty partition.
 */
export function selectSnapshotScenarios<T>(
  scenarios: readonly T[],
  shard?: SnapshotScenarioShard,
): T[] {
  if (shard === undefined) return [...scenarios]
  if (!Number.isSafeInteger(shard.index) || shard.index < 1) {
    throw new Error(`acp-snapshot: shard index must be a positive integer, got ${shard.index}`)
  }
  if (!Number.isSafeInteger(shard.total) || shard.total < 1) {
    throw new Error(`acp-snapshot: shard total must be a positive integer, got ${shard.total}`)
  }
  if (shard.index > shard.total) {
    throw new Error(`acp-snapshot: shard index ${shard.index} exceeds total ${shard.total}`)
  }
  if (shard.total > scenarios.length) {
    throw new Error(`acp-snapshot: ${shard.total} shards exceed ${scenarios.length} scenarios`)
  }
  return scenarios.filter((_, offset) => offset % shard.total === shard.index - 1)
}
