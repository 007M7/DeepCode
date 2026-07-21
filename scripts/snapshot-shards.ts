/** Snapshot-lane definitions for GitHub Actions. */

/** One explicit snapshot file lane, optionally split again by ACP scenarios. */
export interface SnapshotLane {
  /** Stable lane name passed through `DSH_SNAPSHOT_LANE`. */
  name: string
  /** Snapshot test files owned by the lane. */
  files: readonly string[]
  /** Optional one-based ACP scenario partition. */
  scenarioShard?: string
}

/** Exhaustive file ownership plus scenario partitions for the large ACP suite. */
export const snapshotLanes: readonly SnapshotLane[] = [
  {
    name: 'support',
    files: [
      'packages/sdk/scripts/tests/config.snapshot.ts',
      'packages/sdk/create-sdk/tests/create.snapshot.ts',
      'packages/ui/tui/tests/tui.snapshot.ts',
    ],
  },
  {
    name: 'agents',
    files: [
      'examples/tui-agent/tests/tui.snapshot.ts',
      'examples/acp-agent/tests/goal.snapshot.ts',
      'examples/headless-agent/tests/headless.snapshot.ts',
    ],
  },
  ...Array.from({ length: 2 }, (_, offset) => ({
    name: `acp-${offset + 1}`,
    files: ['examples/acp-agent/tests/acp.snapshot.ts'],
    scenarioShard: `${offset + 1}/2`,
  })),
]

/**
 * Resolve one CI lane while preserving a complete ordinary snapshot run.
 *
 * @param name Optional stable lane name.
 * @returns An empty file list for the full suite, or one explicit CI lane.
 */
export function selectSnapshotLane(name?: string): SnapshotLane {
  if (name === undefined || name === '') return { name: 'complete', files: [] }
  const lane = snapshotLanes.find(candidate => candidate.name === name)
  if (lane === undefined) throw new Error(`run-gates: unknown DSH_SNAPSHOT_LANE ${JSON.stringify(name)}.`)
  return lane
}
