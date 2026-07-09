import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineAcpSnapshotSuite, type Scenario } from '@deepseek-ai/dsh-acp-snapshot'

/**
 * Snapshot suite for the plan-mode composition (`../cordis.yml`, swapped to
 * the sibling `cordis.snapshot.yml` replay overlay by the bin under
 * `DSH_SNAPSHOT=replay`).
 *
 * Deliberately ABSENT (pending a with-key recording session — the plan-mode
 * RFC's recorded-scenario section): the two model-turn scenarios driving the
 * full arc (setMode → explore → denied write → exit_plan_mode → a scripted
 * `elicitationAnswers` approve, and the keep-planning sibling). Their deny and
 * keep-planning texts are meanwhile pinned at the unit tier
 * (packages/mode/mode/tests) and the ACP mode round-trip in the bridge's
 * protocol tests (packages/ui/acp/tests/modes.spec.ts).
 */
const SCENARIOS: Scenario[] = [
  // Protocol-only (keyless, authored): the session-mode surface this
  // composition adds. No model turn runs, so no header pin
  // is needed here — the pinning scenario arrives with the recorded plan-mode
  // arc. Composition-wise it adds — availableModes/currentModeId advertised on
  // session/new, the optimistic current_mode_update a session/set_mode
  // answers with, and the loud rejection of an unknown mode id — as committed
  // wire bytes. No model turn, so it replays keyless.
  { name: 'modes-advertise', hasModelTurn: false, recorded: false },
]

defineAcpSnapshotSuite({
  agent: {
    binScript: fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS,
  mode: process.env.DSH_SNAPSHOT === 'record' ? 'record' : 'replay',
})
