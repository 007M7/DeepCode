import { describe, expect, it } from 'vitest'
import { selectStaticGates, staticShards } from './static-shards.ts'

const completeInventory = staticShards.flatMap(shard => shard.gateIds).map(id => ({ id }))

describe('static gate shards', () => {
  it.each(staticShards)('selects only the gates owned by $name', (shard) => {
    expect(selectStaticGates(completeInventory, shard.name).map(gate => gate.id)).toEqual(shard.gateIds)
  })

  it('selects multiple lanes in gate inventory order', () => {
    const selectedNames = new Set(['foundation', 'catalogs', 'prose'])
    const expected = staticShards
      .filter(shard => selectedNames.has(shard.name))
      .flatMap(shard => shard.gateIds)
    expect(selectStaticGates(completeInventory, 'foundation,catalogs,prose').map(gate => gate.id)).toEqual(expected)
  })

  it('rejects missing, duplicate, and unknown assignments', () => {
    expect(() => selectStaticGates(completeInventory.slice(1))).toThrow('assign every static gate exactly once')
    expect(() => selectStaticGates([...completeInventory, completeInventory[0]!])).toThrow('static gate IDs must be unique')
    expect(() => selectStaticGates(completeInventory, 'missing')).toThrow('unknown DSH_STATIC_SHARD')
    expect(() => selectStaticGates(completeInventory, 'foundation,foundation')).toThrow('nonempty and unique')
    expect(() => selectStaticGates(completeInventory, 'foundation,,prose')).toThrow('nonempty and unique')
  })
})
