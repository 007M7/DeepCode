import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineAcpSnapshotSuite, type Scenario, type SnapshotSuiteOptions } from '@deepseek-ai/dsh-acp-snapshot'

/**
 * Snapshot suite for the sandboxed composition. Replay swaps only the model;
 * bash still runs under the host's Seatbelt/bwrap backend, so fixtures use
 * portable `cat`/`printf` commands. Real denial stderr is deliberately absent
 * because its wording varies by backend and platform; unit and kernel e2e tests
 * own that path, while escalation fixtures start from a user-stated denial.
 */
const SCENARIOS: Scenario[] = [
  // Protocol-only (keyless, authored): the session config-option surface this composition adds
  // — both advertised selects on session/new, the complete refreshed state every
  // session/set_config_option answers with, and both rejection shapes — as committed wire
  // bytes. It runs no bash and therefore works without a sandbox runner.
  { name: 'config-options', hasModelTurn: false, recorded: false },
  // The runtime mode-switching arc, and NECESSARILY the pinned-header scenario: an
  // approval-policy switch rewrites its prompt section, and the resulting request/header-delta
  // is legal only in the pinning scenario. The pin includes that delta and
  // notice; the sandbox switch stays prompt-silent and is proven by a confined write.
  { name: 'mode-switching', hasModelTurn: true, recorded: true, pinsHeader: true, expectedHeaderDeltas: 1 },
  // Under default read-only/ask, approval executes a confined retry; rejection
  // executes nothing and returns deterministic text.
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
