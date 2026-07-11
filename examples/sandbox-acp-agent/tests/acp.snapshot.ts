import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineAcpSnapshotSuite, type Scenario, type SnapshotSuiteOptions } from '@deepseek-ai/dsh-acp-snapshot'

/**
 * Snapshot suite for the sandboxed composition (`../cordis.yml`, swapped to the sibling
 * `cordis.snapshot.yml` replay overlay by the bin under `DSH_SNAPSHOT=replay`).
 */
const SCENARIOS: Scenario[] = [
  // Protocol-only (keyless, authored): the session config-option surface this composition adds
  // — both advertised selects on session/new, the complete refreshed state every
  // session/set_config_option answers with, and both rejection shapes — as committed wire
  // bytes.
  { name: 'config-options', hasModelTurn: false, recorded: false },
  // The runtime mode-switching arc, and NECESSARILY the pinned-header scenario: an
  // approval-policy switch rewrites its prompt section, and the resulting request/header-delta
  // is legal only in the pinning scenario (the factory's uniformity guard).
  { name: 'mode-switching', hasModelTurn: true, recorded: true, pinsHeader: true, expectedHeaderDeltas: 1 },
  // Pin both approval branches under the default read-only/ask policy.
  { name: 'escalation-approved', hasModelTurn: true, recorded: true },
  { name: 'escalation-rejected', hasModelTurn: true, recorded: true },
]

function snapshotModeFromEnv(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay':
      return 'replay'
    case 'record':
      return 'record'
    case 'refresh':
      return 'refresh'
    default:
      throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

defineAcpSnapshotSuite({
  agent: {
    binScript: fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS,
  mode: snapshotModeFromEnv(process.env.DSH_SNAPSHOT),
})
