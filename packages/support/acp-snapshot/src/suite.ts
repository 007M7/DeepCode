/**
 * The ACP snapshot suite factory (REPLAY by default, keyless). A suite is a
 * scenario table plus a snapshots directory: each scenario under
 * `<snapshotsDir>/<name>/` ships an `input.json` (the client stdin script) and
 * a `session.jsonl` fixture; replay boots the real agent subprocess
 * (./harness.ts), drives it, and diffs the normalized stdout transcript
 * against the committed `stdout.golden.jsonl`. For model scenarios it ALSO
 * checks the re-persisted session log — against the `session.jsonl` fixture
 * itself, not a separate golden: the fixture doubles as the replay source
 * (recorded scenarios) and the expected produced log (both sides normalized
 * before comparing).
 *
 * Request-header content (the composed system prompt + tool schemas riding on
 * `request/header` events) is pinned by exactly ONE scenario per HEADER CLASS
 * — scenarios that boot the same config compose the same header; each class's
 * `pinsHeader` scenario commits it verbatim — and scrubbed to
 * `{{system}}`/`{{tools}}` tokens in every other fixture and compare, so a
 * prompt or tool-schema edit churns one committed line per class instead of
 * every fixture. A per-run uniformity guard keeps each pin sound: every live
 * header must equal its class's pinned one, and no header-delta may appear
 * outside a pinning scenario (see the pinned-header RFC,
 * docs/rfc/implemented/testing/2026-07-06-pin-request-header-content-in-one-scenario.md).
 *
 * `pnpm run test:snapshot:record` (DSH_SNAPSHOT=record + -u) re-records the
 * `session.jsonl` fixtures against the real API and refreshes the stdout golden
 * in one pass. `pnpm run test:snapshot:refresh` (DSH_SNAPSHOT=refresh) instead
 * replays the committed model scripts keylessly and writes the current stdout
 * + persisted-log goldens back without calling a live LLM. The caller resolves
 * that env into {@link SnapshotSuiteOptions} (env reading stays at the suite
 * edge, not in this library).
 *
 * @module @deepseek-ai/dsh-acp-snapshot/suite
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AgentUnderTest, type HarvestedLog, type InputScript, runScenario } from './harness.ts'
import { type NormalizeContext, normalizeSessionLog, normalizeStdout, scrubRequestHeaders } from './normalize.ts'

/** A snapshot scenario and how its fixtures are produced. */
export interface Scenario {
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
   * `authored` scenarios (fixtures hand-written or hand-harvested — e.g. a
   * provider error or a cancel the live API can't be coaxed into
   * deterministically, a deterministic hook scenario, or a scripted repetition
   * a live model won't reproduce) are NEVER re-recorded.
   */
  recorded: boolean
  /**
   * Whether replay is driven by a hand-written `replay.override.json` sidecar
   * (a `ReplayEntry[]` that REPLACES the script derived from `session.jsonl`)
   * — the throw/hang cases chunks cannot express. The fixture guard requires
   * the sidecar exactly when this is set: the harness forwards the file purely
   * on existence, so an unregistered stray sidecar would silently replace the
   * derived script — the guard fails loud on either mismatch. Defaults to
   * false (replay derives from the fixture's `assistant/chunk` events).
   */
  overridden?: boolean
  /**
   * How many SUBAGENT child sessions this scenario records beyond the top-level
   * one (0 for a single-session scenario). Each child rides in a sibling fixture
   * `session.<n>.jsonl` (1-based); replay forwards them to `dsh-llm-replay` so
   * each child session replays from its own script, and record mode writes the
   * harvested child logs back to those files. Defaults to 0.
   */
  childSessions?: number
  /**
   * Whether THIS scenario's fixtures keep the full request-header content (the
   * composed system prompt and tool schema list on `request/header` /
   * `request/header-delta` events) and compare it verbatim. Exactly one
   * scenario per HEADER CLASS ({@link headerClass}) pins it; every other
   * scenario of that class stores and compares that content as
   * `{{system}}`/`{{tools}}` tokens ({@link scrubRequestHeaders}),
   * so a system prompt or tool-schema change shows up as ONE committed-fixture
   * diff per class, not one per scenario. One pin per class suffices because
   * header composition is class-uniform (parent, spawn child, and fork child
   * all compose the same prompt-modulo-cwd and the same tools) — and that
   * premise is ASSERTED, not assumed: every non-pinning run's live headers
   * must equal its class's pinned fixture's (normalized), so a
   * session-dependent header (say, a restricted subagent toolset) fails loud
   * until it gets its own pinning scenario.
   * Defaults to false.
   */
  pinsHeader?: boolean
  /**
   * Which header-composition class this scenario belongs to. Scenarios that
   * boot the same config compose the same header; each class has exactly one
   * {@link pinsHeader} scenario, and the uniformity guard compares every
   * other member against ITS class's pin. Defaults to `'default'`; a
   * scenario booting an alternate config ({@link configPath}) whose tool
   * list or prompt sections differ by construction carries its own class.
   */
  headerClass?: string
  /**
   * Alternate LIVE config path (absolute) this scenario boots instead of
   * {@link AgentUnderTest.configPath} — an overlay composing a different
   * tree (its basename must still end in `cordis.yml` so the bin's replay
   * swap finds the sibling `*cordis.snapshot.yml`). A scenario whose
   * overlay changes the composed header also needs its own
   * {@link headerClass}.
   */
  configPath?: string
}

/** One suite's inputs: the agent to boot, where its fixtures live, and its scenario table. */
export interface SnapshotSuiteOptions {
  /** The agent composition every scenario boots. */
  agent: AgentUnderTest
  /** Absolute path of the suite's `snapshots/` directory (one subdir per scenario). */
  snapshotsDir: string
  /** The scenario table; exactly one entry must set `pinsHeader`. */
  scenarios: Scenario[]
  /**
   * `replay` (keyless, the default tier), `record` (live API; re-records the
   * `recorded` scenarios' fixtures and refreshes the Vitest goldens under
   * `--update`), or `refresh` (keyless replay that rewrites stdout goldens and
   * comparable session fixtures from the replay run). The caller derives this
   * from `$DSH_SNAPSHOT` — env reading stays outside this library.
   */
  mode: 'replay' | 'record' | 'refresh'
}

/**
 * The sibling child-fixture paths for a scenario (`session.1.jsonl` …).
 *
 * @param dir The scenario's snapshots directory (`<snapshotsDir>/<name>`).
 * @param childSessions How many subagent child sessions the scenario records.
 * @returns One path per child, 1-based, in fixture order.
 */
export function childFixturePaths(dir: string, childSessions: number): string[] {
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
 *
 * @param fixture The committed `session.jsonl` content.
 * @returns The fixture's own volatile values, ready for {@link normalizeSessionLog}.
 */
export function fixtureContext(fixture: string): NormalizeContext {
  const firstLine = fixture.split('\n').find(line => line.trim().length > 0) ?? '{}'
  const header = JSON.parse(firstLine) as { id?: unknown; cwd?: unknown }
  return {
    sessionIds: typeof header.id === 'string' ? [header.id] : [],
    cwd: typeof header.cwd === 'string' ? header.cwd : '\0no-cwd\0',
  }
}

/**
 * The `data.header` payload of every `request/header` event in a session
 * JSONL, in log order, with the log's volatile values scrubbed first
 * ({@link normalizeSessionLog}) so headers harvested from different runs —
 * each embedding its own temp cwd in the composed prompt — compare on equal
 * footing.
 *
 * @param rawLog The session `.jsonl` content to extract headers from.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized `data.header` payloads, in log order.
 */
export function normalizedHeaders(rawLog: string, ctx: NormalizeContext): unknown[] {
  return normalizeSessionLog(rawLog, ctx)
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { type?: unknown; data?: { header?: unknown } })
    .filter(record => record.type === 'request/header')
    .map(record => record.data?.header)
}

/**
 * Count the `request/header-delta` events in a session JSONL.
 *
 * @param rawLog The session `.jsonl` content.
 * @returns How many `request/header-delta` events the log carries.
 */
export function headerDeltaCount(rawLog: string): number {
  return rawLog.split('\n')
    .filter(line => line.trim().length > 0)
    .filter(line => (JSON.parse(line) as { type?: unknown }).type === 'request/header-delta')
    .length
}

/** A literal string replacement used to carry an existing fixture's volatile value into a refreshed log. */
export interface FixtureReplacement {
  /** The fresh replay-run value to replace. */
  from: string
  /** The existing fixture value to keep. */
  to: string
}

function parseJsonlRecords(text: string): Record<string, unknown>[] {
  return text.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Build the cross-log id/cwd replacements used by refresh write-back.
 *
 * @param logs The freshly harvested logs, in fixture order.
 * @param fixtures The existing fixture contents, in matching order.
 * @returns Literal replacements from fresh volatile values to the fixture's old values.
 */
export function refreshFixtureReplacements(logs: HarvestedLog[], fixtures: string[]): FixtureReplacement[] {
  const replacements: FixtureReplacement[] = []
  for (let i = 0; i < logs.length; i++) {
    const fresh = parseJsonlRecords((logs[i] as HarvestedLog).content)[0]
    const existing = parseJsonlRecords(fixtures[i] ?? '')[0]
    for (const field of ['id', 'cwd'] as const) {
      const from = fresh?.[field]
      const to = existing?.[field]
      if (typeof from === 'string' && typeof to === 'string' && from.length > 0 && from !== to) {
        replacements.push({ from, to })
      }
    }
  }
  return replacements
}

function preserveFixtureVolatiles(record: Record<string, unknown>, existing: Record<string, unknown> | undefined): void {
  if (existing === undefined || existing.type !== record.type) return
  if (record.type === 'session') {
    for (const field of ['id', 'createdAt', 'cwd', 'parentSession'] as const) {
      if (field in record && field in existing) record[field] = existing[field]
    }
    return
  }
  if ('time' in record && 'time' in existing) record.time = existing.time
  if (record.type !== 'hook/result') return
  const data = record.data
  const existingData = existing.data
  if (
    data !== null && typeof data === 'object'
    && existingData !== null && typeof existingData === 'object'
    && 'durationMs' in data && 'durationMs' in existingData
  ) {
    (data as Record<string, unknown>).durationMs = (existingData as Record<string, unknown>).durationMs
  }
}

/**
 * Rewrite a fresh replay-produced log so repeated refreshes do not churn
 * volatile fixture fields. Meaningful event payloads come from `fresh`; the
 * existing fixture lends session ids, cwd, creation times, event times, and
 * hook durations where the record shape still matches.
 *
 * @param fresh The newly harvested session JSONL.
 * @param existing The committed fixture JSONL being refreshed.
 * @param replacements Cross-log literal replacements from {@link refreshFixtureReplacements}.
 * @returns The stabilized JSONL content to write back.
 */
export function stabilizeRefreshLog(fresh: string, existing: string, replacements: FixtureReplacement[]): string {
  let stable = fresh
  for (const { from, to } of replacements) stable = stable.split(from).join(to)
  const existingRecords = parseJsonlRecords(existing)
  const records = parseJsonlRecords(stable)
  for (let i = 0; i < records.length; i++) {
    preserveFixtureVolatiles(records[i] as Record<string, unknown>, existingRecords[i])
  }
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

/**
 * Register the suite: one `describe` per scenario (the golden/log compares and
 * the header-uniformity guard) plus the fixture guard block (no orphan
 * scenario dirs, required files present, exactly one pin per header class,
 * pinning fixtures well-formed, non-pinning fixtures header-scrubbed). Must
 * run at vitest collection time — it calls `describe`/`it`. Throws
 * immediately if any header class lacks a pinning scenario or carries two
 * (the uniformity guard needs exactly one comparison anchor per class).
 *
 * @param options The agent, snapshots directory, scenario table, and mode.
 */
export function defineAcpSnapshotSuite(options: SnapshotSuiteOptions): void {
  const { agent, snapshotsDir, scenarios, mode } = options
  const RECORDING = mode === 'record'
  const REFRESHING = mode === 'refresh'
  const childMode: 'replay' | 'record' = RECORDING ? 'record' : 'replay'

  /** The class a scenario's header composition belongs to (see {@link Scenario.headerClass}). */
  const classOf = (scenario: Scenario): string => scenario.headerClass ?? 'default'

  /** Each header class's single pinning scenario. Guarded here (and by meta-tests) so a pin cannot silently vanish or split. */
  const pinningByClass = new Map<string, Scenario>()
  for (const scenario of scenarios) {
    if (scenario.pinsHeader !== true) continue
    const cls = classOf(scenario)
    const existing = pinningByClass.get(cls)
    if (existing) throw new Error(`acp-snapshot: header class "${cls}" pinned by both ${existing.name} and ${scenario.name}`)
    pinningByClass.set(cls, scenario)
  }
  for (const scenario of scenarios) {
    if (!pinningByClass.has(classOf(scenario))) {
      throw new Error(`acp-snapshot: no scenario pins the request-header content of class "${classOf(scenario)}" (needed by ${scenario.name})`)
    }
  }

  for (const scenario of scenarios) {
    describe(`snapshot: ${scenario.name}`, () => {
      // In RECORD mode, only re-run the `recorded` (live-API) scenarios; the
      // `authored` ones (sidecar-driven errors/cancel) are never re-recorded.
      // REFRESH mode is replay-backed and deterministic, so it runs every
      // scenario and rewrites the comparable fixtures from that replay run.
      it.skipIf(RECORDING && !scenario.recorded)('matches the goldens', async () => {
        const dir = join(snapshotsDir, scenario.name)
        const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')) as InputScript
        const overrideFile = join(dir, 'replay.override.json')
        const workspaceDir = join(dir, 'workspace')
        const childSessions = scenario.childSessions ?? 0
        const comparesLog = scenario.comparesLog ?? scenario.hasModelTurn
        const result = await runScenario(input, {
          agent,
          mode: childMode,
          fixtureFile: join(dir, 'session.jsonl'),
          ...existsSync(overrideFile) ? { overrideFile } : {},
          // In REPLAY, forward the recorded child fixtures so each subagent session
          // replays from its own script. In RECORD they are harvested, not read.
          ...!RECORDING && childSessions > 0 ? { childFiles: childFixturePaths(dir, childSessions) } : {},
          ...existsSync(workspaceDir) ? { workspaceDir } : {},
          // A scenario booting an overlay tree passes its own live config; the
          // bin's replay swap derives the sibling `*cordis.snapshot.yml` from it.
          ...scenario.configPath !== undefined ? { configPath: scenario.configPath } : {},
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
        // live logs back to their fixtures. REFRESH mode does the same from a
        // keyless replay run for every comparable log, including authored
        // scenarios that live record deliberately skips. The primary goes to
        // session.jsonl, each child to session.<n>.jsonl in harvest order. A
        // non-pinning scenario's fixtures are written header-scrubbed, so a
        // re-record/refresh can never smuggle the full prompt/schema content
        // back into every fixture.
        const scrub = scenario.pinsHeader === true
          ? (log: string): string => log
          : scrubRequestHeaders
        const fixtureFiles = ['session.jsonl', ...Array.from({ length: childSessions }, (_, i) => `session.${i + 1}.jsonl`)]
        const existingFixtures = REFRESHING
          ? await Promise.all(fixtureFiles.map(file => readFile(join(dir, file), 'utf8')))
          : []
        const replacements = REFRESHING ? refreshFixtureReplacements(result.sessionLogs, existingFixtures) : []
        const writesSessionFixtures = (RECORDING && scenario.recorded && scenario.hasModelTurn)
          || (REFRESHING && comparesLog)
        if (writesSessionFixtures) {
          expect(result.sessionLogs.length, `${mode} produced no session log to harvest`).toBeGreaterThan(0)
          expect(result.sessionLogs.length, `expected ${childSessions + 1} session logs (parent + children)`)
            .toBe(childSessions + 1)
          const primary = (result.sessionLogs[0] as HarvestedLog).content
          await writeFile(join(dir, 'session.jsonl'), scrub(
            REFRESHING ? stabilizeRefreshLog(primary, existingFixtures[0] as string, replacements) : primary,
          ))
          for (let i = 1; i < result.sessionLogs.length; i++) {
            const child = (result.sessionLogs[i] as HarvestedLog).content
            await writeFile(join(dir, `session.${i}.jsonl`), scrub(
              REFRESHING ? stabilizeRefreshLog(child, existingFixtures[i] as string, replacements) : child,
            ))
          }
        }

        const stdout = normalizeStdout(result.rawStdout, ctx)
        if (REFRESHING) {
          await writeFile(join(dir, 'stdout.golden.jsonl'), stdout)
        }
        await expect(stdout).toMatchFileSnapshot(join(dir, 'stdout.golden.jsonl'))

        // A model turn always produces a log worth comparing; a hook scenario can
        // produce one without a model turn (a `rejected` turn carrying `hook/*`).
        if (comparesLog) {
          // The harvested logs (primary-first) must match their committed fixtures
          // 1:1. Each side passes through normalizeSessionLog, scrubbed against ITS
          // OWN volatile values — the live run's via `ctx`, the committed fixture's
          // via its own header (a committed file cannot share the live run's ids).
          // Unless this scenario pins the header, both sides ALSO pass through
          // scrubRequestHeaders: the live log carries the real prompt/schemas, the
          // fixture carries the `{{system}}`/`{{tools}}` tokens, and the scrub is
          // idempotent — so the compare checks the header's presence, position,
          // reason, and config, but not its bulk content (pinned once, in the
          // `pinsHeader` scenario).
          expect(result.sessionLogs.length, 'this scenario must persist a session log').toBe(childSessions + 1)
          for (let i = 0; i < fixtureFiles.length; i++) {
            const harvested = scrub((result.sessionLogs[i] as HarvestedLog).content)
            const fixture = scrub(await readFile(join(dir, fixtureFiles[i] as string), 'utf8'))
            expect(normalizeSessionLog(harvested, ctx), `${fixtureFiles[i]} mismatch`)
              .toEqual(normalizeSessionLog(fixture, fixtureContext(fixture)))
          }
        }

        // Header-uniformity guard: a class's single pin is sound only while
        // every session in that class composes the SAME header and keeps it
        // for the whole run. Assert both halves live. (1) Every
        // request/header the run produced (parent, spawn child, fork child,
        // initial or resume) must equal the CLASS's pinned fixture's header
        // after each side is normalized against its own volatile values.
        // (2) No request/header-delta may appear at all — a mid-run header
        // change diverges from the pin by construction, and its content
        // would be invisible under the scrub. If either fails, either the
        // header changed (update the pin: re-record or hand-edit the pinning
        // scenario's fixture) or composition became session-dependent by
        // design (give the divergent shape its own pinning scenario and
        // class).
        if (scenario.pinsHeader !== true) {
          /* v8 ignore next -- construction guarantees the pin exists; a miss would fail the one-header assertion loudly. */
          const pinningScenario = pinningByClass.get(classOf(scenario)) ?? scenario
          const pinnedFixture = await readFile(join(snapshotsDir, pinningScenario.name, 'session.jsonl'), 'utf8')
          const pinned = normalizedHeaders(pinnedFixture, fixtureContext(pinnedFixture))
          expect(pinned.length, `the pinning fixture (${pinningScenario.name}) must carry exactly one request/header`)
            .toBe(1)
          for (const log of result.sessionLogs) {
            expect(headerDeltaCount(log.content), `session ${log.id}: a request/header-delta in a non-pinning scenario`)
              .toBe(0)
            const headers = normalizedHeaders(log.content, ctx)
            for (const [k, header] of headers.entries()) {
              expect(header, `session ${log.id}: request/header #${k + 1} diverged from the pinned (${pinningScenario.name}) header`)
                .toEqual(pinned[0])
            }
          }
        }
      })
    })
  }

  describe('snapshot fixtures', () => {
    it('every scenario directory is registered (no orphans)', async () => {
      // toMatchFileSnapshot does not prune orphaned golden/fixture files, so a
      // renamed/removed scenario could leave a stale dir that nothing exercises.
      // Fail loud on any snapshots/<dir> not present in the scenario table.
      const entries = await readdir(snapshotsDir, { withFileTypes: true })
      const onDisk = entries.filter(e => e.isDirectory()).map(e => e.name).sort()
      const registered = scenarios.map(s => s.name).sort()
      expect(onDisk).toEqual(registered)
    })

    it('every registered scenario has its required fixture files', () => {
      // Every scenario has an input script and an stdout golden. EVERY scenario
      // also needs `session.jsonl`: the suite boots `llm-replay` with that path
      // as the replay source for ALL scenarios (the factory passes
      // `fixtureFile: <dir>/session.jsonl` unconditionally), and `loadReplayScript`
      // throws "fixture not found" when it is absent and no override replaces it.
      // A no-model scenario ships a header-only `session.jsonl` (it derives to an
      // empty script — no model call is made); a model scenario's fixture also
      // doubles as the expected-log artifact the run is diffed against. The
      // `replay.override.json` sidecar is matched BOTH ways against the table's
      // `overridden` flag: required when set, forbidden when not — the harness
      // forwards the file purely on existence, so an unregistered stray sidecar
      // would silently replace the derived script.
      for (const { name, overridden, childSessions } of scenarios) {
        const dir = join(snapshotsDir, name)
        expect(existsSync(join(dir, 'input.json')), `${name}/input.json`).toBe(true)
        expect(existsSync(join(dir, 'stdout.golden.jsonl')), `${name}/stdout.golden.jsonl`).toBe(true)
        expect(existsSync(join(dir, 'session.jsonl')), `${name}/session.jsonl`).toBe(true)
        expect(existsSync(join(dir, 'replay.override.json')), `${name}/replay.override.json presence must match \`overridden\``)
          .toBe(overridden === true)
        // A nested-agent scenario ships one child fixture per recorded subagent
        // session (`session.1.jsonl` …), the replay source for that child session.
        for (const childFixture of childFixturePaths(dir, childSessions ?? 0)) {
          expect(existsSync(childFixture), childFixture).toBe(true)
        }
      }
    })

    it('exactly one scenario pins the request-header content of each header class', () => {
      // Zero pins would drop a class's prompt/schema surface from the suite
      // entirely; two would split it. One pin per class is the design
      // (pinned-header RFC); WHICH scenario pins is the scenario table's
      // reviewable choice.
      const pins = new Map<string, string[]>()
      for (const scenario of scenarios.filter(s => s.pinsHeader === true)) {
        const cls = classOf(scenario)
        pins.set(cls, [...pins.get(cls) ?? [], scenario.name])
      }
      expect(Object.fromEntries([...pins].map(([cls, names]) => [cls, names.length]))).toEqual(
        Object.fromEntries([...pinningByClass.keys()].map(cls => [cls, 1])))
      for (const scenario of scenarios) {
        expect(pinningByClass.has(classOf(scenario)), `class "${classOf(scenario)}" (scenario ${scenario.name}) has a pin`).toBe(true)
      }
    })

    it('every pinning fixture carries exactly one request/header and no deltas', async () => {
      // The live uniformity guard runs only in NON-pinning scenarios, so a
      // class made of just its pinning scenario would otherwise accept a
      // re-recorded pin with several headers or a mid-run header-delta —
      // shapes the pin design cannot represent. Assert the committed pins
      // directly.
      for (const scenario of pinningByClass.values()) {
        const fixture = await readFile(join(snapshotsDir, scenario.name, 'session.jsonl'), 'utf8')
        const headers = normalizedHeaders(fixture, fixtureContext(fixture))
        expect(headers.length, `${scenario.name}: a pinning fixture must carry exactly one request/header`).toBe(1)
        expect(headerDeltaCount(fixture), `${scenario.name}: a pinning fixture must carry no request/header-delta`).toBe(0)
      }
    })

    it('committed fixtures carry request-header content ONLY in the pinning scenario', async () => {
      // The whole point of the pin: a system-prompt or tool-schema change must
      // churn exactly one committed line. A non-pinning fixture that carries the
      // full header (a hand-recorded file, or a header line hand-edited out of
      // its canonical JSON form) silently reopens the suite-wide churn, so fail
      // loud here: every non-pinning session*.jsonl must be a fixed point of
      // scrubRequestHeaders (apply the scrub to fix a violation), and the
      // pinning scenario's fixtures must NOT be (their content IS the pin).
      for (const scenario of scenarios) {
        const dir = join(snapshotsDir, scenario.name)
        const files = [
          'session.jsonl',
          ...Array.from({ length: scenario.childSessions ?? 0 }, (_, i) => `session.${i + 1}.jsonl`),
        ]
        for (const file of files) {
          const fixture = await readFile(join(dir, file), 'utf8')
          if (scenario.pinsHeader === true) {
            expect(scrubRequestHeaders(fixture), `${scenario.name}/${file} must PIN the full header content`)
              .not.toEqual(fixture)
          } else {
            expect(scrubRequestHeaders(fixture), `${scenario.name}/${file} carries unscrubbed header content`)
              .toEqual(fixture)
          }
        }
      }
    })
  })
}
