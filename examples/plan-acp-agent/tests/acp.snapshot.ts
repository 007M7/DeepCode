import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineAcpSnapshotSuite, type Scenario, type SnapshotSuiteOptions } from '@deepseek-ai/dsh-acp-snapshot'

/**
 * Snapshot suite for the plan-mode composition (`../cordis.yml`, swapped to
 * the sibling `cordis.snapshot.yml` replay overlay by the bin under
 * `DSH_SNAPSHOT=replay`).
 *
 * The recorded scenarios re-execute the fs tools AND the sandboxed bash
 * executor for real on replay (the replay overlay swaps only the model), so
 * the plan-mode arc doubles as a live check of plan's read-only `access`
 * cap: the recorded `cat` runs under the host's actual runner (Seatbelt on
 * macOS, bwrap on Linux CI). The recorded commands stay `cat`-shaped —
 * byte-identical across those backends and across GNU/BSD userlands — and
 * the transcripts carry NO sandbox denial (a denied command's stderr is the
 * backend's dialect; the denial→marker path is pinned at dsh-tool-bash's
 * unit tier, and the cap's clamp at dsh-mode's). Prompts pin the model to
 * RELATIVE paths, because a recorded absolute temp path would neither replay
 * on another host nor normalize (the normalizers scrub the RUN's own cwd,
 * not the recording's).
 */

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

const SCENARIOS: Scenario[] = [
  // Protocol-only (keyless, authored): the session-mode surface this
  // composition adds — availableModes/currentModeId advertised on
  // session/new, the optimistic current_mode_update a session/set_mode
  // answers with, and the loud rejection of an unknown mode id — as committed
  // wire bytes. No model turn → no headers, so its class membership is
  // vacuous; it joins 'plan' because the factory requires every scenario's
  // class to carry a pin.
  { name: 'modes-advertise', hasModelTurn: false, recorded: false, headerClass: 'plan' },
  // The full plan-mode arc, and NECESSARILY the pinned-header scenario for
  // the 'plan' class: the first request ships the plan-shaped header (reason
  // initial) — the full toolset plus exit_plan_mode and the mode section —
  // and the approved exit narrows it back by exactly that tool and section,
  // a pure removal the delta encoding CAN express (one header-delta; the
  // ENTERING flip's front-of-list insertion has no delta form and falls back
  // to a snapshot, pinned at the unit tier). The arc: setMode(plan) → the
  // model runs a real `cat` through the clamped read-only sandbox and
  // presents the plan via exit_plan_mode → the scripted elicitation approves
  // → the very next step already runs unclamped and edits for real, mid-turn.
  { name: 'plan-mode', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'plan', expectedHeaderDeltas: 1 },
  // The keep-planning branch: one presentation, the scripted review answers
  // with free-text feedback (no approval), and the corrective isError carries
  // it back verbatim — the session stays in plan mode, so the log holds one
  // plan-shaped header, uniform with the pin's first.
  { name: 'plan-mode-reject', hasModelTurn: true, recorded: true, headerClass: 'plan' },
]

defineAcpSnapshotSuite({
  agent: {
    binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS,
  mode: snapshotModeFromEnv(process.env.DSH_SNAPSHOT),
})
