import { describe, expect, it } from 'vitest'
import { snapshotScenarioShardFromEnv } from './snapshot-scenario-shard.ts'

describe('ACP snapshot scenario shard environment', () => {
  it('keeps ordinary snapshot runs complete', () => {
    expect(snapshotScenarioShardFromEnv()).toBeUndefined()
    expect(snapshotScenarioShardFromEnv('')).toBeUndefined()
  })

  it('parses a valid one-based shard', () => {
    expect(snapshotScenarioShardFromEnv('2/4')).toEqual({ index: 2, total: 4 })
  })

  it.each(['0/1', '1/0', '2/1', '1.5/2', 'missing', '999999999999999999999/999999999999999999999'])(
    'rejects %s',
    (value) => {
      expect(() => snapshotScenarioShardFromEnv(value)).toThrow('DSH_SNAPSHOT_SCENARIO_SHARD')
    },
  )
})
