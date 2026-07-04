import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type HarvestedLog, type InputScript, runScenario } from './snapshot-harness.ts'
import { type NormalizeContext, normalizeSessionLog, normalizeStdout } from './snapshot-normalize.ts'

/**
 * ACP snapshot tests (REPLAY by default, keyless). Each scenario under
 * `snapshots/<name>/` ships an `input.json` (the client stdin script) and a
 * `session.jsonl` fixture; replay boots the real acp-agent subprocess, drives
 * it, and diffs the normalized stdout transcript against the committed
 * `stdout.golden.jsonl`. For model scenarios it ALSO checks the re-persisted
 * session log — against the `session.jsonl` fixture itself, not a separate
 * golden: the fixture doubles as the replay source (recorded scenarios) and the
 * expected produced log (both sides normalized before comparing).
 *
 * `pnpm run test:snapshot:record` (DSH_SNAPSHOT=record + -u) re-records the
 * `session.jsonl` fixtures against the real API and refreshes the stdout golden
 * in one pass.
 */

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
const RECORDING = process.env.DSH_SNAPSHOT === 'record'

/** A snapshot scenario and how its fixtures are produced. */
interface Scenario {
  name: string
  /** Whether the scenario drives at least one model turn (so a JSONL golden applies). */
  hasModelTurn: boolean
  /**
   * Whether the run persists a comparable session log to diff against the
   * `session.jsonl` fixture. Defaults to {@link hasModelTurn} (a model turn
   * always produces a log worth comparing). Set it independently for a scenario
   * that produces a non-trivial log WITHOUT a model turn — e.g. a prompt blocked
   * by a `UserPromptSubmit` hook, which opens a `rejected` turn carrying `hook/*`
   * events but never calls the model.
   */
  comparesLog?: boolean
  /**
   * Whether `test:snapshot:record` regenerates this scenario's `session.jsonl`
   * from the LIVE API. `recorded` scenarios are model-driven and reproducible;
   * `authored` scenarios (a hand-written `replay.override.json` sidecar drives
   * replay — e.g. a provider error or a cancel, which the live API can't be
   * coaxed into deterministically — or a deterministic hook scenario whose
   * derived empty script needs no sidecar) are NEVER re-recorded.
   */
  recorded: boolean
  /**
   * How many SUBAGENT child sessions this scenario records beyond the top-level
   * one (0 for a single-session scenario). Each child rides in a sibling fixture
   * `session.<n>.jsonl` (1-based); replay forwards them to `dsh-llm-replay` so
   * each child session replays from its own script, and record mode writes the
   * harvested child logs back to those files. Defaults to 0.
   */
  childSessions?: number
}

const SCENARIOS: Scenario[] = [
  { name: 'handshake', hasModelTurn: false, recorded: false },
  { name: 'reject-extra-dirs', hasModelTurn: false, recorded: false },
  { name: 'text-turn', hasModelTurn: true, recorded: true },
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
  { name: 'error-finish', hasModelTurn: true, recorded: false },
  { name: 'cancel', hasModelTurn: true, recorded: false },
  { name: 'subagent-spawn', hasModelTurn: true, recorded: true, childSessions: 1 },
  { name: 'subagent-multi', hasModelTurn: true, recorded: true, childSessions: 2 },
  { name: 'subagent-fork', hasModelTurn: true, recorded: true, childSessions: 1 },
  { name: 'subagent-mixed', hasModelTurn: true, recorded: true, childSessions: 2 },
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
]

/** The sibling child-fixture paths for a scenario (`session.1.jsonl` …). */
function childFixturePaths(dir: string, childSessions: number): string[] {
  return Array.from({ length: childSessions }, (_, i) => join(dir, `session.${i + 1}.jsonl`))
}

/**
 * Derive the {@link NormalizeContext} for a `session.jsonl` fixture from its own
 * header line (`{ type: 'session', id, cwd }`). A committed fixture carries the
 * session id and cwd of the run that harvested it — different from the live
 * replay run — so normalizing it against the live run's ctx would leave those
 * recorded values unscrubbed. Reading them from the header scrubs the fixture's
 * own id/cwd to the same `{{sessionId}}`/`{{cwd}}` tokens the replay output gets.
 * An authored fixture whose header is already normalized (`id:'{{sessionId}}'`,
 * `cwd:'{{cwd}}'`) yields those tokens as the volatile values, so scrubbing them
 * is an idempotent no-op. A header with no `cwd` falls back to a sentinel that
 * cannot occur in a log (NOT `''`, which `String.split` would match on every
 * character boundary and corrupt the output).
 */
function fixtureContext(fixture: string): NormalizeContext {
  const firstLine = fixture.split('\n').find(line => line.trim().length > 0) ?? '{}'
  const header = JSON.parse(firstLine) as { id?: unknown; cwd?: unknown }
  return {
    sessionIds: typeof header.id === 'string' ? [header.id] : [],
    cwd: typeof header.cwd === 'string' ? header.cwd : '\0no-cwd\0',
  }
}

for (const scenario of SCENARIOS) {
  describe(`snapshot: ${scenario.name}`, () => {
    // In RECORD mode, only re-run the `recorded` (live-API) scenarios; the
    // `authored` ones (sidecar-driven errors/cancel) are never re-recorded.
    it.skipIf(RECORDING && !scenario.recorded)('matches the goldens', async () => {
      const dir = join(SNAPSHOTS_DIR, scenario.name)
      const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')) as InputScript
      const overrideFile = join(dir, 'replay.override.json')
      const workspaceDir = join(dir, 'workspace')
      const childSessions = scenario.childSessions ?? 0
      const result = await runScenario(input, {
        mode: RECORDING ? 'record' : 'replay',
        fixtureFile: join(dir, 'session.jsonl'),
        ...existsSync(overrideFile) ? { overrideFile } : {},
        // In REPLAY, forward the recorded child fixtures so each subagent session
        // replays from its own script. In RECORD they are harvested, not read.
        ...!RECORDING && childSessions > 0 ? { childFiles: childFixturePaths(dir, childSessions) } : {},
        ...existsSync(workspaceDir) ? { workspaceDir } : {},
      })

      // Scrub every volatile id the run produced: the ACP server-issued session
      // id plus every harvested log's recorded id (a subagent child id never
      // surfaces over ACP, but it appears in the child's own log header). The
      // normalizer's UUID catch-all covers any we don't enumerate.
      const ctx: NormalizeContext = {
        sessionIds: [
          ...result.sessionId !== undefined ? [result.sessionId] : [],
          ...result.sessionLogs.map(l => l.id),
        ],
        cwd: result.cwd,
      }

      // RECORD mode (recorded model scenarios only): persist the freshly-harvested
      // logs back to their fixtures — the primary to session.jsonl, each child to
      // session.<n>.jsonl in harvest order. `--update` refreshes the Vitest
      // goldens but NOT these fixtures, so write them here.
      if (RECORDING && scenario.recorded && scenario.hasModelTurn) {
        expect(result.sessionLogs.length, 'record produced no session log to harvest').toBeGreaterThan(0)
        expect(result.sessionLogs.length, `expected ${childSessions + 1} session logs (parent + children)`)
          .toBe(childSessions + 1)
        await writeFile(join(dir, 'session.jsonl'), (result.sessionLogs[0] as HarvestedLog).content)
        for (let i = 1; i < result.sessionLogs.length; i++) {
          await writeFile(join(dir, `session.${i}.jsonl`), (result.sessionLogs[i] as HarvestedLog).content)
        }
      }

      await expect(normalizeStdout(result.rawStdout, ctx))
        .toMatchFileSnapshot(join(dir, 'stdout.golden.jsonl'))

      // A model turn always produces a log worth comparing; a hook scenario can
      // produce one without a model turn (a `rejected` turn carrying `hook/*`).
      const comparesLog = scenario.comparesLog ?? scenario.hasModelTurn
      if (comparesLog) {
        // The harvested logs (primary-first) must match their committed fixtures
        // 1:1. Each side passes through normalizeSessionLog, scrubbed against ITS
        // OWN volatile values — the live run's via `ctx`, the committed fixture's
        // via its own header (a committed file cannot share the live run's ids).
        expect(result.sessionLogs.length, 'this scenario must persist a session log').toBe(childSessions + 1)
        const fixtureFiles = ['session.jsonl', ...Array.from({ length: childSessions }, (_, i) => `session.${i + 1}.jsonl`)]
        for (let i = 0; i < fixtureFiles.length; i++) {
          const harvested = (result.sessionLogs[i] as HarvestedLog).content
          const fixture = await readFile(join(dir, fixtureFiles[i] as string), 'utf8')
          expect(normalizeSessionLog(harvested, ctx), `${fixtureFiles[i]} mismatch`)
            .toEqual(normalizeSessionLog(fixture, fixtureContext(fixture)))
        }
      }
    })
  })
}

describe('snapshot fixtures', () => {
  it('every scenario directory is registered (no orphans)', async () => {
    // toMatchFileSnapshot does not prune orphaned golden/fixture files, so a
    // renamed/removed scenario could leave a stale dir that nothing exercises.
    // Fail loud on any snapshots/<dir> not present in SCENARIOS.
    const entries = await readdir(SNAPSHOTS_DIR, { withFileTypes: true })
    const onDisk = entries.filter(e => e.isDirectory()).map(e => e.name).sort()
    const registered = SCENARIOS.map(s => s.name).sort()
    expect(onDisk).toEqual(registered)
  })

  it('every registered scenario has its required fixture files', async () => {
    // Every scenario has an input script and an stdout golden. EVERY scenario
    // also needs `session.jsonl`: the harness boots `llm-replay` with that path
    // as the replay source for ALL scenarios (acp.snapshot.ts passes
    // `fixtureFile: <dir>/session.jsonl` unconditionally), and `loadReplayScript`
    // throws "fixture not found" when it is absent and no override replaces it.
    // A no-model scenario ships a header-only `session.jsonl` (it derives to an
    // empty script — no model call is made); a model scenario's fixture also
    // doubles as the expected-log artifact the run is diffed against. An authored
    // (non-`recorded`) model scenario additionally ships a `replay.override.json`
    // sidecar for the throw/hang cases a derived script cannot express.
    for (const { name, hasModelTurn, recorded, childSessions } of SCENARIOS) {
      const dir = join(SNAPSHOTS_DIR, name)
      expect(existsSync(join(dir, 'input.json')), `${name}/input.json`).toBe(true)
      expect(existsSync(join(dir, 'stdout.golden.jsonl')), `${name}/stdout.golden.jsonl`).toBe(true)
      expect(existsSync(join(dir, 'session.jsonl')), `${name}/session.jsonl`).toBe(true)
      if (hasModelTurn && !recorded) {
        expect(existsSync(join(dir, 'replay.override.json')), `${name}/replay.override.json`).toBe(true)
      }
      // A nested-agent scenario ships one child fixture per recorded subagent
      // session (`session.1.jsonl` …), the replay source for that child session.
      for (const childFixture of childFixturePaths(dir, childSessions ?? 0)) {
        expect(existsSync(childFixture), childFixture).toBe(true)
      }
    }
  })
})
