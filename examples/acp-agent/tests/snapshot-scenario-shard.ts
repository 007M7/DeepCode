import type { SnapshotScenarioShard } from '@deepseek-ai/dsh-acp-snapshot'

/**
 * Parse the optional CI scenario shard passed to this snapshot suite.
 *
 * @param value An `INDEX/TOTAL` string or an unset value.
 * @returns A validated one-based shard, or undefined for the complete suite.
 */
export function snapshotScenarioShardFromEnv(value?: string): SnapshotScenarioShard | undefined {
  if (value === undefined || value === '') return undefined
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value)
  if (match === null) throw new Error(`DSH_SNAPSHOT_SCENARIO_SHARD must be INDEX/TOTAL, got ${JSON.stringify(value)}`)
  const shard = { index: Number(match[1]), total: Number(match[2]) }
  if (!Number.isSafeInteger(shard.index) || !Number.isSafeInteger(shard.total) || shard.index > shard.total) {
    throw new Error(`DSH_SNAPSHOT_SCENARIO_SHARD is out of range: ${JSON.stringify(value)}`)
  }
  return shard
}
