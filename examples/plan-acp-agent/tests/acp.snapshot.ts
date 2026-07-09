import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineAcpSnapshotSuite, type Scenario } from '@deepseek-ai/dsh-acp-snapshot'

/**
 * Snapshot suite for the plan-mode composition (`../cordis.yml`, swapped to
 * the sibling `cordis.snapshot.yml` replay overlay by the bin under
 * `DSH_SNAPSHOT=replay`).
 *
 * The recorded scenarios re-execute the fs tools for real on replay (the
 * replay overlay swaps only the model); their prompts pin the model to
 * RELATIVE paths, because a recorded absolute temp path would neither replay
 * on another host nor normalize (the normalizers scrub the RUN's own cwd,
 * not the recording's). The gate's deny path is pinned at the unit tier
 * (packages/mode/mode/tests) — the recorded model never calls a filtered
 * tool, which is the behavior the soft layer exists to produce.
 */
const SCENARIOS: Scenario[] = [
  // Protocol-only (keyless, authored): the session-mode surface this
  // composition adds — availableModes/currentModeId advertised on
  // session/new, the optimistic current_mode_update a session/set_mode
  // answers with, and the loud rejection of an unknown mode id — as committed
  // wire bytes. No model turn, so it replays keyless and needs no header pin.
  { name: 'modes-advertise', hasModelTurn: false, recorded: false },
  // The full plan-mode arc, and NECESSARILY the pinned-header scenario for
  // the 'plan' class: the first request ships the plan-shaped header (reason
  // initial), the approved exit widens it back — a second, fallback snapshot
  // (adding/removing exit_plan_mode resorts the canonical tool list, which
  // the delta encoding cannot express) — so this composition's full header
  // content, both shapes, is committed here verbatim. The arc: setMode(plan)
  // → the model reads under the plan allowlist (it never attempts the
  // filtered write — the deny path stays pinned at the unit tier) and
  // presents the plan via exit_plan_mode → the scripted elicitation approves
  // → the very next step already runs the widened toolset and writes for
  // real, mid-turn.
  { name: 'plan-mode', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'plan' },
  // The keep-planning branch: one presentation, the scripted review answers
  // with free-text feedback (no approval), and the corrective isError carries
  // it back verbatim — the session stays in plan mode, so the log holds one
  // plan-shaped header, uniform with the pin's first.
  { name: 'plan-mode-reject', hasModelTurn: true, recorded: true, headerClass: 'plan' },
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
