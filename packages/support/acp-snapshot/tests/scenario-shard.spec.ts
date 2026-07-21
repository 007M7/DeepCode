import { describe, expect, it } from 'vitest'
import { selectSnapshotScenarios } from '../src/scenario-shard.ts'

describe('ACP snapshot scenario shards', () => {
  it('keeps the ordinary suite complete', () => {
    expect(selectSnapshotScenarios(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('partitions the ordered table without gaps or overlap', () => {
    const scenarios = ['a', 'b', 'c', 'd', 'e']
    expect(selectSnapshotScenarios(scenarios, { index: 1, total: 2 })).toEqual(['a', 'c', 'e'])
    expect(selectSnapshotScenarios(scenarios, { index: 2, total: 2 })).toEqual(['b', 'd'])
  })

  it.each([
    [{ index: 0, total: 1 }, 'index must be a positive integer'],
    [{ index: 1.5, total: 2 }, 'index must be a positive integer'],
    [{ index: 1, total: 0 }, 'total must be a positive integer'],
    [{ index: 1, total: Number.NaN }, 'total must be a positive integer'],
    [{ index: 3, total: 2 }, 'exceeds total'],
    [{ index: 1, total: 4 }, 'exceed 3 scenarios'],
  ] as const)('rejects malformed shard %#', (shard, message) => {
    expect(() => selectSnapshotScenarios(['a', 'b', 'c'], shard)).toThrow(message)
  })
})
