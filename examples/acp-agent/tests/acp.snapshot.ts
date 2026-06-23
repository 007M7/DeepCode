import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type InputScript, runScenario } from './snapshot-harness.ts'
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
   * Whether `test:snapshot:record` regenerates this scenario's `session.jsonl`
   * from the LIVE API. `recorded` scenarios are model-driven and reproducible;
   * `authored` scenarios (a hand-written `replay.override.json` sidecar drives
   * replay — e.g. a provider error or a cancel, which the live API can't be
   * coaxed into deterministically) are NEVER re-recorded.
   */
  recorded: boolean
}

const SCENARIOS: Scenario[] = [
  { name: 'handshake', hasModelTurn: false, recorded: false },
  { name: 'reject-extra-dirs', hasModelTurn: false, recorded: false },
  { name: 'text-turn', hasModelTurn: true, recorded: true },
  { name: 'tool-call-turn', hasModelTurn: true, recorded: true },
  { name: 'workspace-edit', hasModelTurn: true, recorded: true },
  { name: 'multi-turn', hasModelTurn: true, recorded: true },
  { name: 'error-finish', hasModelTurn: true, recorded: false },
  { name: 'cancel', hasModelTurn: true, recorded: false },
]

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
      const result = await runScenario(input, {
        mode: RECORDING ? 'record' : 'replay',
        fixtureFile: join(dir, 'session.jsonl'),
        ...existsSync(overrideFile) ? { overrideFile } : {},
        ...existsSync(workspaceDir) ? { workspaceDir } : {},
      })

      const ctx: NormalizeContext = {
        sessionIds: result.sessionId !== undefined ? [result.sessionId] : [],
        cwd: result.cwd,
      }

      // RECORD mode (recorded scenarios only): persist the freshly-harvested log
      // back to the scenario's session.jsonl fixture. `--update` refreshes the
      // Vitest goldens but NOT this fixture, so write it here.
      if (RECORDING && scenario.recorded && scenario.hasModelTurn) {
        expect(result.sessionLog, 'record produced no session log to harvest').toBeDefined()
        await writeFile(join(dir, 'session.jsonl'), result.sessionLog as string)
      }

      await expect(normalizeStdout(result.rawStdout, ctx))
        .toMatchFileSnapshot(join(dir, 'stdout.golden.jsonl'))

      if (scenario.hasModelTurn) {
        expect(result.sessionLog, 'a model scenario must persist a session log').toBeDefined()
        // Compare the replay run's persisted log against the `session.jsonl`
        // fixture — there is no separate session golden. Both sides pass through
        // normalizeSessionLog so the comparison is on normalized form: the
        // fixture is raw-harvested (its own real session id / cwd / timestamps),
        // the replay output has fresh ones, and each is scrubbed against ITS OWN
        // volatile values. The fixture's are read from its header line (a
        // committed file cannot share the live run's ctx), so the stale recorded
        // cwd/id are scrubbed too, not left to leak past the run's `ctx`.
        const fixture = await readFile(join(dir, 'session.jsonl'), 'utf8')
        expect(normalizeSessionLog(result.sessionLog as string, ctx))
          .toEqual(normalizeSessionLog(fixture, fixtureContext(fixture)))
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
    for (const { name, hasModelTurn, recorded } of SCENARIOS) {
      const dir = join(SNAPSHOTS_DIR, name)
      expect(existsSync(join(dir, 'input.json')), `${name}/input.json`).toBe(true)
      expect(existsSync(join(dir, 'stdout.golden.jsonl')), `${name}/stdout.golden.jsonl`).toBe(true)
      expect(existsSync(join(dir, 'session.jsonl')), `${name}/session.jsonl`).toBe(true)
      if (hasModelTurn && !recorded) {
        expect(existsSync(join(dir, 'replay.override.json')), `${name}/replay.override.json`).toBe(true)
      }
    }
  })
})
