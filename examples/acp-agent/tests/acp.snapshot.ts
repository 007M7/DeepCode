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
 * recorded `session.jsonl` fixture; replay boots the real acp-agent subprocess,
 * drives it, and diffs the normalized stdout transcript (and, for model
 * scenarios, the re-persisted session log) against committed goldens.
 *
 * `pnpm run test:snapshot:record` (DSH_SNAPSHOT=record + -u) re-records the
 * fixtures against the real API and refreshes the goldens in one pass.
 */

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
const RECORDING = process.env.DSH_SNAPSHOT === 'record'

/** A scenario and whether it makes any model call (→ has a behavioral JSONL golden). */
interface Scenario {
  name: string
  /** Whether the scenario drives at least one model turn (so a JSONL golden applies). */
  hasModelTurn: boolean
}

const SCENARIOS: Scenario[] = [
  { name: 'handshake', hasModelTurn: false },
]

for (const scenario of SCENARIOS) {
  describe(`snapshot: ${scenario.name}`, () => {
    it('matches the stdout transcript golden', async () => {
      const dir = join(SNAPSHOTS_DIR, scenario.name)
      const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')) as InputScript
      const overrideFile = join(dir, 'replay.override.json')
      const result = await runScenario(input, {
        mode: RECORDING ? 'record' : 'replay',
        fixtureFile: join(dir, 'session.jsonl'),
        ...existsSync(overrideFile) ? { overrideFile } : {},
      })

      const ctx: NormalizeContext = {
        sessionIds: result.sessionId !== undefined ? [result.sessionId] : [],
        cwd: result.cwd,
      }

      // RECORD mode: persist the freshly-harvested log back to the scenario's
      // session.jsonl fixture (a model scenario must produce one). `--update`
      // refreshes the Vitest goldens but NOT this fixture, so write it here.
      if (RECORDING && scenario.hasModelTurn) {
        expect(result.sessionLog, 'record produced no session log to harvest').toBeDefined()
        await writeFile(join(dir, 'session.jsonl'), result.sessionLog as string)
      }

      await expect(normalizeStdout(result.rawStdout, ctx))
        .toMatchFileSnapshot(join(dir, 'stdout.golden.txt'))

      if (scenario.hasModelTurn) {
        expect(result.sessionLog, 'a model scenario must persist a session log').toBeDefined()
        await expect(normalizeSessionLog(result.sessionLog as string, ctx))
          .toMatchFileSnapshot(join(dir, 'session.golden.txt'))
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
    for (const { name } of SCENARIOS) {
      const dir = join(SNAPSHOTS_DIR, name)
      expect(existsSync(join(dir, 'input.json')), `${name}/input.json`).toBe(true)
      expect(existsSync(join(dir, 'session.jsonl')), `${name}/session.jsonl`).toBe(true)
      expect(existsSync(join(dir, 'stdout.golden.txt')), `${name}/stdout.golden.txt`).toBe(true)
    }
  })
})
