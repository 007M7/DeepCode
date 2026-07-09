import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defineAcpSnapshotSuite, type Scenario } from '@deepseek-ai/dsh-acp-snapshot'

/**
 * The acp-agent example's snapshot suite: the scenario table for
 * `dsh-acp-snapshot`'s suite factory, which owns every compare/guard mechanic
 * (golden + re-persisted-log diffs, record write-back, the pinned-header
 * uniformity guard, the fixture guards). Fixtures live under `snapshots/<name>/`;
 * `pnpm run test:snapshot:record` re-records the `recorded` scenarios against
 * the real API. See the package README (packages/support/acp-snapshot) and the
 * snapshot RFC, docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md.
 */

// The dsh-acp-agent bin (the demo:acp entry), this example's cordis.yml, and
// the repo-root tsconfig (four levels up from examples/acp-agent/tests) — all
// ABSOLUTE: the subprocess cwd is a temp dir outside the repo.
const AGENT = {
  binScript: fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

// The Code Mode overlay configs (include-patched variants of cordis.yml; the
// replay swap resolves each one's sibling `*cordis.snapshot.yml`).
const CODE_MODE_CONFIG = fileURLToPath(new URL('../code-mode.cordis.yml', import.meta.url))
const BOTH_MODE_CONFIG = fileURLToPath(new URL('../both-mode.cordis.yml', import.meta.url))

const SCENARIOS: Scenario[] = [
  { name: 'handshake', hasModelTurn: false, recorded: false },
  { name: 'reject-extra-dirs', hasModelTurn: false, recorded: false },
  // text-turn is the pinned-header scenario: the minimal single text turn,
  // whose fixture is the ONE place the full system prompt + tool schemas are
  // committed and compared verbatim.
  { name: 'text-turn', hasModelTurn: true, recorded: true, pinsHeader: true },
  { name: 'tool-call-turn', hasModelTurn: true, recorded: true },
  { name: 'fs-terminal-card', hasModelTurn: true, recorded: true },
  { name: 'todo-plan', hasModelTurn: true, recorded: true },
  { name: 'workspace-edit', hasModelTurn: true, recorded: true },
  { name: 'fs-read', hasModelTurn: true, recorded: true },
  { name: 'fs-write', hasModelTurn: true, recorded: true },
  { name: 'fs-edit', hasModelTurn: true, recorded: true },
  { name: 'fs-write-overwrite', hasModelTurn: true, recorded: true },
  { name: 'fs-read-window', hasModelTurn: true, recorded: true },
  { name: 'fs-policy-reject', hasModelTurn: true, recorded: true },
  { name: 'multi-turn', hasModelTurn: true, recorded: true },
  { name: 'error-finish', hasModelTurn: true, recorded: false, overridden: true },
  // Keyless, authored (like error-finish/cancel): deterministically forcing a
  // LIVE model to repeat one call three times is not a stable recording, so
  // the fixture scripts five identical todo_write calls and pins BOTH reminder
  // tiers (gentle at 3, detailed at 5) as context/message in transcript and log.
  { name: 'repeat-tool-guard', hasModelTurn: true, recorded: false },
  { name: 'cancel', hasModelTurn: true, recorded: false, overridden: true },
  { name: 'subagent-spawn', hasModelTurn: true, recorded: true, childSessions: 1 },
  { name: 'subagent-multi', hasModelTurn: true, recorded: true, childSessions: 2 },
  { name: 'subagent-fork', hasModelTurn: true, recorded: true, childSessions: 1 },
  { name: 'subagent-mixed', hasModelTurn: true, recorded: true, childSessions: 2 },
  // The workflow tool: the model writes a one-child orchestration script; the
  // child runs as a spawn subagent under the worker-thread engine (its session is the
  // child fixture), and the tool result carries the script's return value.
  { name: 'workflow-run', hasModelTurn: true, recorded: true, childSessions: 1 },
  // Hook matrix — one scenario per hook point × its headline Decision outcome,
  // across BOTH bridges (Claude `hooks.json`, Codex `codex-hooks.json`, seeded in
  // workspace/). The block scenarios need no model call: a UserPromptSubmit hook
  // blocks the prompt before any step runs (keyless, authored — the derived
  // script is empty so no sidecar), yet persists a `rejected` turn carrying
  // `hook/*` events, so their logs ARE compared. Every other point fires a real
  // seam mid-turn, so its transcript is recorded WITH the hook active.
  { name: 'hook-cc-promptsubmit-block', hasModelTurn: false, comparesLog: true, recorded: false },
  { name: 'hook-codex-promptsubmit-block', hasModelTurn: false, comparesLog: true, recorded: false },
  // The mid-turn seams fire during a real model turn, so each is recorded WITH
  // its hook active (the model's reaction to a deny/block/force-continue is part
  // of the captured transcript). The Codex bridge exercises the same seams in its
  // own snake_case dialect.
  //
  // Two hook points are deliberately NOT snapshotted, and stay on the bridges'
  // unit coverage (`bridge.spec.ts` / `coverage.spec.ts`) instead:
  //   - SessionStart and SubagentStart inject context through a detached,
  //     best-effort `void runPoint(...).then(agent.inject())` with no turn
  //     binding, so the resulting `context/message` races the work it precedes
  //     and lands at a nondeterministic log position — a recorded golden does not
  //     even reproduce on its own replay.
  //   - SubagentStop is observe-only with no turn and no injection, so it writes
  //     NOTHING to the transcript — a golden would be byte-identical to the
  //     no-hook run and could never be proven to fail.
  // See the hook-snapshot-matrix RFC for the full rationale.
  { name: 'hook-cc-promptsubmit-context', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-pretool-deny', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-pretool-ask', hasModelTurn: true, recorded: true },
  // TODO(hook-snapshot-noise): re-record the PostToolUse block fixtures with a
  // self-limiting prompt or hook so one rejected result proves the seam without
  // repeated block/retry cycles in the committed JSONL.
  { name: 'hook-cc-posttool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-posttool-context', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-stop-continue', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-promptsubmit-context', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-pretool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-posttool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-posttool-context', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-stop-continue', hasModelTurn: true, recorded: true },
  // Code Mode: the registry in `mode: code` — the wire tool list collapses to
  // [run_code], the tools:sdk section rides in the prompt, and the program's
  // tool calls land as tool/code-dispatch events. Each mode boots its own
  // overlay config, composes a different header by construction, and
  // therefore pins its own class.
  { name: 'code-mode-turn', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'code', configPath: CODE_MODE_CONFIG },
  { name: 'both-mode-turn', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'both', configPath: BOTH_MODE_CONFIG },
]

defineAcpSnapshotSuite({
  agent: AGENT,
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS,
  mode: process.env.DSH_SNAPSHOT === 'record' ? 'record' : 'replay',
})
