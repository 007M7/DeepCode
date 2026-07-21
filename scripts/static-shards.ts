/** Static-gate shard definitions for GitHub Actions. */

/** A static CI lane identified by the gate IDs it owns. */
export interface StaticShard {
  /** Stable lane identifier passed through `DSH_STATIC_SHARD`. */
  name: string
  /** Gate IDs selected from the static gate inventory. */
  gateIds: readonly string[]
}

/** Exhaustive, non-overlapping ownership of static CI gates. */
export const staticShards = [
  {
    name: 'foundation',
    gateIds: [
      'runtime-closure',
      'constraints',
      'package-invariants',
      'cordis-config',
      'module-graph',
      'knip',
    ],
  },
  {
    name: 'api-contracts',
    gateIds: ['doc-typecheck', 'export-jsdoc', 'scoped-events', 'type-equivalence'],
  },
  {
    name: 'catalogs',
    gateIds: ['cordis-catalog', 'tool-catalog', 'config-catalog', 'persistence-catalog', 'doc-graphs'],
  },
  {
    name: 'prose',
    gateIds: [
      'markdown-wrap',
      'markdown-links',
      'doc-refs',
      'package-paths',
      'package-readme-model-experience',
      'mermaid',
      'agent-note-classification',
      'agent-note-format',
      'translation-prompt',
      'translation-pairing',
      'doc-budgets',
      'package-readme-limitations',
    ],
  },
  { name: 'site', gateIds: ['docs-site'] },
] as const satisfies readonly StaticShard[]

/**
 * Validate the complete gate partition and optionally select one lane.
 *
 * @param gates Complete static gate inventory.
 * @param name Optional stable shard name.
 * @returns All gates when no shard is requested, otherwise the selected lane.
 */
export function selectStaticGates<T extends { id: string }>(gates: readonly T[], name?: string): T[] {
  const gateIds = gates.map(gate => gate.id)
  const assignedIds = staticShards.flatMap(shard => shard.gateIds)
  const uniqueGateIds = new Set<string>(gateIds)
  const uniqueAssignedIds = new Set<string>(assignedIds)
  if (uniqueGateIds.size !== gateIds.length) throw new Error('run-gates: static gate IDs must be unique.')
  if (uniqueAssignedIds.size !== assignedIds.length) throw new Error('run-gates: static shard gate IDs must be unique.')
  if (gateIds.length !== assignedIds.length
    || gateIds.some(id => !uniqueAssignedIds.has(id))
    || assignedIds.some(id => !uniqueGateIds.has(id))) {
    throw new Error('run-gates: static shards must assign every static gate exactly once.')
  }
  if (name === undefined || name === '') return [...gates]

  const shard = staticShards.find(candidate => candidate.name === name)
  if (shard === undefined) throw new Error(`run-gates: unknown DSH_STATIC_SHARD ${JSON.stringify(name)}.`)
  const selectedIds = new Set<string>(shard.gateIds)
  return gates.filter(gate => selectedIds.has(gate.id))
}
