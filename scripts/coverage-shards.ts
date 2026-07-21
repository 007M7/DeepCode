/** Coverage shard definitions for the GitHub Actions source-test lanes. */

/** A coverage lane that owns complete package roots and optional cross-package tests. */
export interface CoverageShard {
  /** Stable lane identifier passed through `DSH_COVERAGE_SHARD`. */
  name: string
  /** Group or package paths below `packages/` whose tests and source coverage belong to the lane. */
  packageRoots: readonly string[]
  /** Additional test roots needed for cross-package behavior or repository scripts. */
  extraTestRoots?: readonly string[]
}

/** Exhaustive, non-overlapping ownership of workspace packages in coverage CI. */
export const coverageShards = [
  {
    name: 'core',
    packageRoots: ['core', 'context'],
    extraTestRoots: ['packages/examples/cli-demo/tests'],
  },
  { name: 'models-protocol', packageRoots: ['llm', 'compact', 'hooks/hook-protocol'] },
  { name: 'sdk-codex', packageRoots: ['sdk', 'hooks/hooks-codex'] },
  {
    name: 'interfaces',
    packageRoots: ['ui', 'examples', 'goal'],
    extraTestRoots: ['examples'],
  },
  { name: 'execution', packageRoots: ['fs', 'bash', 'sandbox', 'code-runtime'] },
  {
    name: 'workflow',
    packageRoots: ['workflow/workflow', 'workflow/tool-workflow', 'workflow/tool-ralph'],
  },
  { name: 'workflow-worker', packageRoots: ['workflow/workflow-workerthread'] },
  { name: 'delegation', packageRoots: ['subagent', 'tasks'] },
  {
    name: 'repository',
    packageRoots: [
      'cordis',
      'support/acp-snapshot',
      'support/agent-loop-testkit',
      'support/llm-replay',
      'support/loader-smoke',
    ],
  },
  {
    name: 'session-scripts',
    packageRoots: ['session-persistence', 'session-query', 'support/invariants'],
    extraTestRoots: ['scripts'],
  },
  { name: 'integrations-claude', packageRoots: ['lsp', 'mcp', 'hooks/hooks-claude'] },
  {
    name: 'capabilities',
    packageRoots: ['web', 'skill', 'spill', 'util', 'guard', 'todo', 'timeout'],
  },
] as const satisfies readonly CoverageShard[]

/**
 * Build Vitest filters and coverage include globs for one source-test lane.
 *
 * @param name Stable shard name from {@link coverageShards}.
 * @returns Positional test roots followed by per-group coverage include flags.
 */
export function coverageArgs(name: string): string[] {
  const shard = coverageShards.find(candidate => candidate.name === name)
  if (shard === undefined) {
    throw new Error(`run-gates: unknown DSH_COVERAGE_SHARD ${JSON.stringify(name)}.`)
  }

  const testRoots = new Set([
    ...shard.packageRoots.map(packageRoot => `packages/${packageRoot}`),
    ...('extraTestRoots' in shard ? shard.extraTestRoots : []),
    'scripts/test-invariants.spec.ts',
  ])
  return [
    ...testRoots,
    ...shard.packageRoots.map(packageRoot => packageRoot.includes('/')
      ? `--coverage.include=packages/${packageRoot}/src/**/*.ts`
      : `--coverage.include=packages/${packageRoot}/*/src/**/*.ts`),
  ]
}
