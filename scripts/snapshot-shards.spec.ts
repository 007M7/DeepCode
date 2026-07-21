import { existsSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectSnapshotLane, snapshotLanes } from './snapshot-shards.ts'

const root = join(import.meta.dirname, '..')

function snapshotFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return snapshotFiles(path)
    return entry.name.endsWith('.snapshot.ts') ? [relative(root, path).split(sep).join('/')] : []
  })
}

describe('snapshot lanes', () => {
  it('assigns every configured snapshot file and every ACP scenario shard', () => {
    const discovered = [
      ...snapshotFiles(join(root, 'examples')),
      ...snapshotFiles(join(root, 'packages/sdk')),
      ...snapshotFiles(join(root, 'packages/ui/tui')),
    ].filter(path => !path.includes('/node_modules/') && !path.includes('/lib/')).sort()
    const ordinary = snapshotLanes.filter(lane => lane.scenarioShard === undefined).flatMap(lane => lane.files)
    const acp = snapshotLanes.filter(lane => lane.scenarioShard !== undefined)

    expect(new Set(ordinary).size).toBe(ordinary.length)
    expect(acp.map(lane => lane.files)).toEqual(Array.from(
      { length: 8 },
      () => ['examples/acp-agent/tests/acp.snapshot.ts'],
    ))
    expect(acp.map(lane => lane.scenarioShard)).toEqual([
      '1/8',
      '2/8',
      '3/8',
      '4/8',
      '5/8',
      '6/8',
      '7/8',
      '8/8',
    ])
    expect([...ordinary, 'examples/acp-agent/tests/acp.snapshot.ts'].sort()).toEqual(discovered)
  })

  it('keeps ordinary runs complete and selects known lanes', () => {
    expect(selectSnapshotLane()).toEqual({ name: 'complete', files: [] })
    expect(selectSnapshotLane('')).toEqual({ name: 'complete', files: [] })
    for (const lane of snapshotLanes) expect(selectSnapshotLane(lane.name)).toBe(lane)
  })

  it('rejects an unknown lane', () => {
    expect(() => selectSnapshotLane('missing')).toThrow('unknown DSH_SNAPSHOT_LANE')
  })
})
