import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defineAcpSnapshotSuite, type Scenario, type SnapshotSuiteOptions } from '@deepseek-ai/dsh-acp-snapshot'

/**
 * The acp-agent example's snapshot suite: the scenario table for
 * `dsh-acp-snapshot`'s suite factory, which owns every compare/guard mechanic
 * (golden + re-persisted-log diffs, record/refresh write-back, the pinned-header
 * uniformity guard, the fixture guards). Fixtures live under `snapshots/<name>/`;
 * `pnpm run test:snapshot:record` re-records model transcripts against the real
 * API; `pnpm run test:snapshot:refresh` rewrites current replay goldens keyless.
 * See the package README (packages/support/acp-snapshot) and the snapshot RFC,
 * docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md.
 */

// The dsh-acp-demo bin (the demo:acp entry), this example's cordis.yml, and
// the repo-root tsconfig (four levels up from examples/acp-agent/tests) — all
// ABSOLUTE: the subprocess cwd is a temp dir outside the repo.
const AGENT = {
  binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

// The Code Mode overlay configs (include-patched variants of cordis.yml; the
// replay swap resolves each one's sibling `*cordis.snapshot.yml`).
const CODE_MODE_CONFIG = fileURLToPath(new URL('../code-mode.cordis.yml', import.meta.url))
const CODE_MODE_WORKSPACE_CONTEXT_CONFIG = fileURLToPath(new URL('../code-mode-workspace-context.cordis.yml', import.meta.url))
const BOTH_MODE_CONFIG = fileURLToPath(new URL('../both-mode.cordis.yml', import.meta.url))
const WORKSPACE_CONTEXT_CONFIG = fileURLToPath(new URL('../workspace-context.cordis.yml', import.meta.url))
const ADVANCED_CONFIG = fileURLToPath(new URL('../advanced.cordis.yml', import.meta.url))
const FS_CONFIG = fileURLToPath(new URL('../fs.cordis.yml', import.meta.url))

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
  { name: 'handshake', hasModelTurn: false, recorded: false },
  { name: 'reject-extra-dirs', hasModelTurn: false, recorded: false },
  // text-turn is the pinned-header scenario: the minimal single text turn.
  // Its prompt and tool-schema sidecars pin the composed header.
  { name: 'text-turn', hasModelTurn: true, recorded: true, pinsHeader: true },
  { name: 'tool-call-turn', hasModelTurn: true, recorded: true },
  {
    name: 'parallel-tool-calls',
    hasModelTurn: true,
    recorded: false,
    headerClass: 'fs',
    configPath: FS_CONFIG,
  },
  { name: 'bash-spill', hasModelTurn: true, recorded: false, headerClass: 'fs', configPath: FS_CONFIG },
  { name: 'fs-terminal-card', hasModelTurn: true, recorded: true },
  { name: 'todo-plan', hasModelTurn: true, recorded: true },
  { name: 'skill-load', hasModelTurn: true, recorded: false, pinsHeader: true, headerClass: 'skill' },
  { name: 'workspace-edit', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'fs', configPath: FS_CONFIG },
  { name: 'fs-read', hasModelTurn: true, recorded: true, headerClass: 'fs', configPath: FS_CONFIG },
  { name: 'fs-write', hasModelTurn: true, recorded: true, headerClass: 'fs', configPath: FS_CONFIG },
  { name: 'fs-edit', hasModelTurn: true, recorded: true, headerClass: 'fs', configPath: FS_CONFIG },
  { name: 'fs-write-overwrite', hasModelTurn: true, recorded: true, headerClass: 'fs', configPath: FS_CONFIG },
  { name: 'fs-read-window', hasModelTurn: true, recorded: true, headerClass: 'fs', configPath: FS_CONFIG },
  { name: 'fs-policy-reject', hasModelTurn: true, recorded: true, headerClass: 'fs', configPath: FS_CONFIG },
  { name: 'multi-turn', hasModelTurn: true, recorded: true },
  // ACP exposes the adapter catalog as a session-scoped model select. This
  // scenario pins the default flash request, the switch response, and the
  // resulting changed request-header snapshot for pro.
  {
    name: 'model-switching',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    expectedHeaderChanges: 1,
    headerClass: 'model-switching',
  },
  { name: 'error-finish', hasModelTurn: true, recorded: false, overridden: true },
  // Keyless, authored (like error-finish/cancel): deterministically forcing a
  // LIVE model to repeat one call three times is not a stable recording, so
  // the fixture scripts five identical todo_write calls and pins BOTH reminder
  // tiers (gentle at 3, detailed at 5) as context/message in transcript and log.
  { name: 'repeat-tool-guard', hasModelTurn: true, recorded: false },
  // Authored replay: a root AGENTS.md pins the session prefix, then a read in
  // nested/ discovers its narrower AGENTS.md as a raw, metadata-bearing
  // context/message. The scenario-specific config keeps home/root discovery
  // hermetic, and the resulting prefix needs its own pinned header class.
  {
    name: 'workspace-context',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    pinsHeader: true,
    headerClass: 'workspace-context',
    configPath: WORKSPACE_CONTEXT_CONFIG,
  },
  { name: 'cancel', hasModelTurn: true, recorded: false, overridden: true },
  { name: 'subagent-spawn', hasModelTurn: true, recorded: true },
  { name: 'subagent-multi', hasModelTurn: true, recorded: true },
  { name: 'subagent-fork', hasModelTurn: true, recorded: true },
  { name: 'subagent-mixed', hasModelTurn: true, recorded: true },
  // The workflow tool: the model writes a one-child orchestration script; the
  // child runs as a spawn subagent under the worker-thread engine (its session is the
  // child fixture), and the tool result carries the script's return value.
  { name: 'workflow-run', hasModelTurn: true, recorded: true },
  // Authored counterpart to the packaged Python SDK snapshot: mount a live marker, inspect it
  // through Code Mode, run direct and workflow children, then unmount it. The extra Code Mode and
  // Cordis plugins require their own request-header pin; the fixture tests deterministic composition.
  {
    name: 'advanced-toolchain',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'advanced',
    configPath: ADVANCED_CONFIG,
  },
  {
    name: 'cordis-inspect-jsdoc',
    hasModelTurn: true,
    recorded: false,
    headerClass: 'advanced',
    configPath: ADVANCED_CONFIG,
  },
  // Prompt-submit blocks are authored keylessly: they persist a rejected turn
  // and hook events without starting a model step, so their logs still compare.
  { name: 'hook-cc-promptsubmit-block', hasModelTurn: false, comparesLog: true, recorded: false },
  { name: 'hook-codex-promptsubmit-block', hasModelTurn: false, comparesLog: true, recorded: false },
  // The mid-turn seams fire during a real model turn, so each is recorded with its hook active
  // (the model's reaction to a deny/block/force-continue is part of the captured transcript).
  // SessionStart/SubagentStart are excluded because detached injection races log
  // order; SubagentStop writes no transcript, so a golden could not prove it ran.
  // Unit tests cover those points; the hook-snapshot-matrix RFC owns the rationale.
  { name: 'hook-cc-promptsubmit-context', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-pretool-deny', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-pretool-ask', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-posttool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-posttool-context', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-stop-continue', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-promptsubmit-context', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-pretool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-posttool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-posttool-context', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-stop-continue', hasModelTurn: true, recorded: true },
  // Code Mode: the registry in `mode: code` — the wire tool list collapses to [run_code], the
  // tools:sdk section rides in the prompt, and the program's tool calls land as
  // tool/code-dispatch events. Each overlay composes and pins its own header class.
  { name: 'code-mode-turn', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'code', configPath: CODE_MODE_CONFIG },
  // A nested fs dispatch inside run_code discovers workspace instructions. The
  // context/message must follow the outer result while retaining workspace
  // provenance, which proves Code Mode carries deferred tool context end to end.
  {
    name: 'code-mode-workspace-context',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'code-workspace-context',
    configPath: CODE_MODE_WORKSPACE_CONTEXT_CONFIG,
  },
  { name: 'both-mode-turn', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'both', configPath: BOTH_MODE_CONFIG },
  // The default tree also owns the Permissions select. Snapshot mode starts in
  // danger-full-access so established fixtures stay runner-independent; these
  // policy scenarios switch to workspace-write in their input scripts.
  // Real-kernel confinement remains in escalation.e2e.ts and the sandbox
  // packages' e2e suites.
  { name: 'config-options', hasModelTurn: false, recorded: false, headerClass: 'sandbox' },
  { name: 'permission-switching', hasModelTurn: true, recorded: true, pinsHeader: true, expectedHeaderChanges: 1, headerClass: 'sandbox' },
  { name: 'escalation-approved', hasModelTurn: true, recorded: true, headerClass: 'sandbox' },
  { name: 'escalation-rejected', hasModelTurn: true, recorded: true, headerClass: 'sandbox' },
]

defineAcpSnapshotSuite({
  agent: AGENT,
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS,
  mode: snapshotModeFromEnv(process.env.DSH_SNAPSHOT),
})
