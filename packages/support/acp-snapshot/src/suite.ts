/**
 * Keyless-by-default ACP snapshot suite factory. Each scenario drives the real subprocess and
 * compares normalized stdout; comparable session fixtures are both replay input and expected
 * output. Record mode refreshes reproducible model scenarios from the live API, while refresh
 * mode replays committed scripts and rewrites derived artifacts without a key.
 * Replay scenarios run concurrently because each subprocess owns unique temp cwd and persistence
 * roots and only reads committed fixtures. Record and refresh scenarios stay serial while writing.
 *
 * Exactly one scenario per header-composition class pins the system prompt and tool schemas in
 * dedicated sidecars. Every live header is checked against that pin, so session-dependent
 * composition must declare a separate class instead of escaping coverage.
 * @module @deepseek-ai/dsh-acp-snapshot/suite
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AgentUnderTest, type HarvestedLog, type InputScript, runScenario } from './harness.ts'
import {
  type NormalizeContext,
  normalizeSessionLog,
  normalizeStdout,
  scrubRequestHeaders,
  scrubSystemPrompts,
  scrubToolSchemas,
} from './normalize.ts'

/** The readable system-prompt snapshot beside each header-pinning fixture. */
const SYSTEM_PROMPT_SNAPSHOT = 'system-prompt.golden.md'

/** The structured tool-schema snapshot beside each header-pinning fixture. */
const TOOL_SCHEMAS_SNAPSHOT = 'tool-schemas.golden.json'

/** Stable session-log token standing in for the sidecar's initial schemas. */
const TOOLS_TOKEN = '{{tools}}'

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
   * Whether this scenario is its header class's sole request-header pin. Dedicated sidecars own
   * the prompt and tool schemas, while every classmate is checked for equality.
   */
  pinsHeader?: boolean
  /**
   * How many `request/header-delta` events this PINNING scenario's fixture
   * legitimately carries (default 0). A recorded mid-run header change — a
   * config-option switch rewriting a prompt section — is part of the pinned
   * surface, with readable prompt text in Markdown; any OTHER count
   * still fails, so fixture rot stays caught. Meaningless off the pin (the
   * live uniformity guard keeps non-pinning scenarios delta-free).
   */
  expectedHeaderDeltas?: number
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
  /** The scenario table; exactly one entry per header class must set `pinsHeader`. */
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
 * Derive normalization values from a fixture's own session header. Recorded ids and cwd differ
 * from the live replay run; the non-empty sentinel for missing cwd avoids accidental empty-
 * string replacement.
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
 * The normalized string-valued system prompts carried by request headers in a
 * session JSONL, in log order. Headers without a string prompt are omitted so
 * callers can assert one prompt per header explicitly.
 *
 * @param rawLog The session `.jsonl` content to inspect.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized system prompts, in header order.
 */
export function normalizedSystemPrompts(rawLog: string, ctx: NormalizeContext): string[] {
  return normalizedHeaders(rawLog, ctx).flatMap((header) => {
    if (header === null || typeof header !== 'object') return []
    const system = (header as { system?: unknown }).system
    return typeof system === 'string' ? [system] : []
  })
}

/**
 * The normalized tool-schema arrays carried by request headers in a session
 * JSONL, in log order. Headers without an array-valued tools field are omitted
 * so callers can assert one schema set per header explicitly.
 *
 * @param rawLog The session `.jsonl` content to inspect.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized initial tool-schema arrays, in header order.
 */
export function normalizedToolSchemas(rawLog: string, ctx: NormalizeContext): unknown[][] {
  return normalizedHeaders(rawLog, ctx).flatMap((header) => {
    if (header === null || typeof header !== 'object') return []
    const tools = (header as { tools?: unknown }).tools
    return Array.isArray(tools) ? [tools] : []
  })
}

/**
 * Extract normalized tool-schema edits from request-header deltas in log order.
 * Deltas without an object-valued tools edit are omitted; their remaining
 * structure stays pinned in the session JSONL.
 *
 * @param rawLog The session `.jsonl` content to inspect.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized tool-schema edits, in event order.
 */
export function normalizedToolSchemaDeltas(rawLog: string, ctx: NormalizeContext): unknown[] {
  return normalizeSessionLog(rawLog, ctx)
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { type?: unknown; data?: { tools?: unknown } })
    .filter(record => record.type === 'request/header-delta')
    .flatMap((record) => {
      const tools = record.data?.tools
      return tools !== null && typeof tools === 'object' && !Array.isArray(tools) ? [tools] : []
    })
}

/** The structured contents of a tool-schema sidecar. */
export interface ToolSchemasSnapshot {
  /** The complete tool schemas from the pinned request header. */
  initial: unknown[]
  /** Complete tool-schema edits from subsequent request-header deltas. */
  deltas: unknown[]
}

/**
 * Render tool schemas and later schema edits as canonical, readable JSON.
 *
 * @param initial The pinned request header's complete tool schemas.
 * @param deltas Complete tool-schema edits from request-header deltas.
 * @returns A pretty-printed JSON snapshot ending in one newline.
 */
export function formatToolSchemasSnapshot(initial: readonly unknown[], deltas: readonly unknown[] = []): string {
  return `${JSON.stringify({ initial, deltas }, null, 2)}\n`
}

/**
 * Parse and validate the stable top-level shape of a tool-schema sidecar.
 *
 * @param snapshot The JSON sidecar text.
 * @returns Its initial schemas and schema deltas.
 */
export function parseToolSchemasSnapshot(snapshot: string): ToolSchemasSnapshot {
  const parsed = JSON.parse(snapshot) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('acp-snapshot: tool-schema snapshot must be an object')
  }
  const { initial, deltas } = parsed as { initial?: unknown; deltas?: unknown }
  if (!Array.isArray(initial) || !Array.isArray(deltas)) {
    throw new Error('acp-snapshot: tool-schema snapshot must carry array-valued initial and deltas fields')
  }
  return { initial, deltas }
}

/**
 * Restore a sidecar's initial schemas into a tokenized pinned header.
 *
 * @param header The parsed request header carrying `tools: "{{tools}}"`.
 * @param snapshot The parsed tool-schema sidecar.
 * @returns A copy of the header with its complete initial schemas restored.
 */
export function restorePinnedToolSchemas(header: unknown, snapshot: ToolSchemasSnapshot): unknown {
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('acp-snapshot: pinned request header must be an object')
  }
  if ((header as { tools?: unknown }).tools !== TOOLS_TOKEN) {
    throw new Error(`acp-snapshot: pinned request header tools must equal ${TOOLS_TOKEN}`)
  }
  return { ...header, tools: snapshot.initial }
}

/** One normalized system-prompt edit carried by a `request/header-delta`. */
export interface SystemPromptDeltaSnapshot {
  /** How many leading lines remain from the prior prompt. */
  keepStart: number
  /** How many trailing lines remain from the prior prompt. */
  keepEnd: number
  /** The normalized replacement lines inserted between the retained ranges. */
  insert: string[]
}

/**
 * Extract normalized system-prompt edits from request-header deltas in log
 * order. Deltas without a well-formed system edit are omitted; their non-prompt
 * structure remains pinned in JSONL.
 *
 * @param rawLog The session `.jsonl` content to inspect.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized system-prompt edits, in event order.
 */
export function normalizedSystemPromptDeltas(rawLog: string, ctx: NormalizeContext): SystemPromptDeltaSnapshot[] {
  return normalizeSessionLog(rawLog, ctx)
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { type?: unknown; data?: { system?: unknown } })
    .filter(record => record.type === 'request/header-delta')
    .flatMap((record) => {
      const system = record.data?.system
      if (system === null || typeof system !== 'object') return []
      const { keepStart, keepEnd, insert } = system as { keepStart?: unknown; keepEnd?: unknown; insert?: unknown }
      if (typeof keepStart !== 'number' || typeof keepEnd !== 'number' || !Array.isArray(insert)) return []
      if (!insert.every(line => typeof line === 'string')) return []
      return [{ keepStart, keepEnd, insert: insert }]
    })
}

/**
 * Render a normalized prompt as a repository-friendly Markdown snapshot.
 * Prompt text is unchanged except that a missing terminal newline is added so
 * the committed file follows the repository newline contract.
 *
 * @param prompt The normalized system prompt.
 * @param deltas Normalized prompt edits to append as readable sections.
 * @returns Markdown snapshot text ending in a newline.
 */
export function formatSystemPromptSnapshot(
  prompt: string,
  deltas: readonly SystemPromptDeltaSnapshot[] = [],
): string {
  let snapshot = prompt.endsWith('\n') ? prompt : `${prompt}\n`
  for (const [index, delta] of deltas.entries()) {
    snapshot += `\n<!-- request/header-delta ${index + 1}: keepStart=${delta.keepStart}, keepEnd=${delta.keepEnd} -->\n\n`
    const insert = delta.insert.join('\n')
    snapshot += insert.endsWith('\n') ? insert : `${insert}\n`
  }
  return snapshot
}

/** Return the initial-prompt portion of a possibly delta-bearing snapshot. */
function initialSystemPromptSnapshot(snapshot: string): string {
  const marker = snapshot.indexOf('\n<!-- request/header-delta ')
  return marker < 0 ? snapshot : snapshot.slice(0, marker)
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
 * Find tool calls whose structured result reports `UNKNOWN_TOOL`.
 *
 * Snapshot refresh must not turn a missing registration into accepted behavior;
 * intentional unknown-tool behavior belongs in a focused unit or e2e test.
 *
 * @param rawLog The session JSONL to inspect.
 * @returns The failing call ids in log order, using a diagnostic placeholder when absent.
 */
export function unknownToolCallIds(rawLog: string): string[] {
  return parseJsonlRecords(rawLog).flatMap((record) => {
    if (record.type !== 'tool/result') return []
    const data = record.data
    if (data === null || typeof data !== 'object') return []
    const { callId, error } = data as { callId?: unknown; error?: unknown }
    if (error === null || typeof error !== 'object') return []
    if ((error as { code?: unknown }).code !== 'UNKNOWN_TOOL') return []
    return [typeof callId === 'string' ? callId : '<missing callId>']
  })
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
 * Register the suite: one test per scenario (the golden/log compares and
 * the header-uniformity guard) plus the fixture guard block (no orphan
 * scenario dirs, required files present, exactly one pin per header class,
 * pinning fixtures well-formed, every JSONL prompt-scrubbed, non-pinning
 * fixtures fully header-scrubbed). Must
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
  const scenarioSuite = mode === 'replay' ? describe.concurrent : describe

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

  scenarioSuite('snapshot scenarios', () => {
    for (const scenario of scenarios) {
      // In RECORD mode, only re-run the `recorded` (live-API) scenarios; the `authored` ones
      // (sidecar-driven errors/cancel) are never re-recorded.
      it.skipIf(RECORDING && !scenario.recorded)(`snapshot: ${scenario.name} matches the goldens`, async ({ expect }) => {
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

        for (const log of result.sessionLogs) {
          expect(unknownToolCallIds(log.content), `session ${log.id}: snapshot scenarios must not accept UNKNOWN_TOOL`)
            .toEqual([])
        }

        // Scrub every volatile id the run produced: the ACP server-issued session id plus every
        // harvested log's recorded id (a subagent child id never surfaces over ACP, but it
        // appears in the child's own log header).
        const ctx: NormalizeContext = {
          sessionIds: [
            ...result.sessionId !== undefined ? [result.sessionId] : [],
            ...result.sessionLogs.map(l => l.id),
          ],
          cwd: result.cwd,
        }

        // Record writes live model fixtures; keyless refresh writes every comparable replayed
        // fixture. Pinning JSONL keeps prefixes but moves prompts and schemas into sidecars.
        const scrub = scenario.pinsHeader === true
          ? (log: string): string => scrubToolSchemas(scrubSystemPrompts(log))
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
          if (scenario.pinsHeader === true) {
            const prompts = result.sessionLogs.flatMap(log => normalizedSystemPrompts(log.content, ctx))
            expect(prompts.length, `${mode} produced no system prompt to snapshot`).toBeGreaterThan(0)
            const initialSnapshot = formatSystemPromptSnapshot(prompts[0] as string)
            for (const prompt of prompts) {
              expect(formatSystemPromptSnapshot(prompt), 'the pinning run produced divergent system prompts')
                .toEqual(initialSnapshot)
            }
            const primary = result.sessionLogs[0] as HarvestedLog
            const snapshot = formatSystemPromptSnapshot(
              prompts[0] as string,
              normalizedSystemPromptDeltas(primary.content, ctx),
            )
            await writeFile(join(dir, SYSTEM_PROMPT_SNAPSHOT), snapshot)

            const schemaSets = result.sessionLogs.flatMap(log => normalizedToolSchemas(log.content, ctx))
            expect(schemaSets.length, `${mode} produced no tool schemas to snapshot`).toBeGreaterThan(0)
            const initialSchemaSnapshot = formatToolSchemasSnapshot(schemaSets[0] as unknown[])
            for (const schemas of schemaSets) {
              expect(formatToolSchemasSnapshot(schemas), 'the pinning run produced divergent tool schemas')
                .toEqual(initialSchemaSnapshot)
            }
            await writeFile(join(dir, TOOL_SCHEMAS_SNAPSHOT), formatToolSchemasSnapshot(
              schemaSets[0] as unknown[],
              normalizedToolSchemaDeltas(primary.content, ctx),
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
          // The harvested logs (primary-first) must match their committed fixtures 1:1.
          expect(result.sessionLogs.length, 'this scenario must persist a session log').toBe(childSessions + 1)
          for (let i = 0; i < fixtureFiles.length; i++) {
            const harvested = scrub((result.sessionLogs[i] as HarvestedLog).content)
            const fixture = scrub(await readFile(join(dir, fixtureFiles[i] as string), 'utf8'))
            expect(normalizeSessionLog(harvested, ctx), `${fixtureFiles[i]} mismatch`)
              .toEqual(normalizeSessionLog(fixture, fixtureContext(fixture)))
          }
        }

        // Header-uniformity guard: every live header in a class must equal the class pin split
        // across tokenized JSONL plus readable prompt and structured schema sidecars.
        /* v8 ignore next -- construction guarantees the pin exists; a miss would fail the one-header assertion loudly. */
        const pinningScenario = pinningByClass.get(classOf(scenario)) ?? scenario
        const pinningDir = join(snapshotsDir, pinningScenario.name)
        const pinnedFixture = await readFile(join(pinningDir, 'session.jsonl'), 'utf8')
        const pinned = normalizedHeaders(pinnedFixture, fixtureContext(pinnedFixture))
        const promptSnapshot = await readFile(join(pinningDir, SYSTEM_PROMPT_SNAPSHOT), 'utf8')
        const initialPromptSnapshot = initialSystemPromptSnapshot(promptSnapshot)
        const toolSchemasSnapshot = await readFile(join(pinningDir, TOOL_SCHEMAS_SNAPSHOT), 'utf8')
        const toolSchemas = parseToolSchemasSnapshot(toolSchemasSnapshot)
        expect(pinned.length, `the pinning fixture (${pinningScenario.name}) must carry exactly one request/header`)
          .toBe(1)
        const pinnedHeader = restorePinnedToolSchemas(pinned[0], toolSchemas)
        for (const [logIndex, log] of result.sessionLogs.entries()) {
          const expectedDeltas = scenario.pinsHeader === true && logIndex === 0
            ? scenario.expectedHeaderDeltas ?? 0
            : 0
          expect(headerDeltaCount(log.content), `session ${log.id}: request/header-delta count`)
            .toBe(expectedDeltas)
          const headers = normalizedHeaders(scrubSystemPrompts(log.content), ctx)
          const prompts = normalizedSystemPrompts(log.content, ctx)
          const schemaSets = normalizedToolSchemas(log.content, ctx)
          expect(prompts.length, `session ${log.id}: every request/header must carry a string system prompt`)
            .toBe(headers.length)
          expect(schemaSets.length, `session ${log.id}: every request/header must carry an array-valued tools field`)
            .toBe(headers.length)
          for (const [k, header] of headers.entries()) {
            expect(header, `session ${log.id}: request/header #${k + 1} diverged from the pinned (${pinningScenario.name}) header`)
              .toEqual(pinnedHeader)
            expect(formatSystemPromptSnapshot(prompts[k] as string), `session ${log.id}: initial system prompt #${k + 1} diverged from ${pinningScenario.name}/${SYSTEM_PROMPT_SNAPSHOT}`)
              .toEqual(initialPromptSnapshot)
          }
          if (scenario.pinsHeader === true && logIndex === 0) {
            expect(formatSystemPromptSnapshot(
              prompts[0] as string,
              normalizedSystemPromptDeltas(log.content, ctx),
            ), `session ${log.id}: system-prompt deltas diverged from ${pinningScenario.name}/${SYSTEM_PROMPT_SNAPSHOT}`)
              .toEqual(promptSnapshot)
            expect(formatToolSchemasSnapshot(
              schemaSets[0] as unknown[],
              normalizedToolSchemaDeltas(log.content, ctx),
            ), `session ${log.id}: tool-schema deltas diverged from ${pinningScenario.name}/${TOOL_SCHEMAS_SNAPSHOT}`)
              .toEqual(toolSchemasSnapshot)
          }
        }
      })
    }
  })

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
      // Every scenario has an input script and an stdout golden.
      for (const { name, overridden, childSessions, pinsHeader } of scenarios) {
        const dir = join(snapshotsDir, name)
        expect(existsSync(join(dir, 'input.json')), `${name}/input.json`).toBe(true)
        expect(existsSync(join(dir, 'stdout.golden.jsonl')), `${name}/stdout.golden.jsonl`).toBe(true)
        expect(existsSync(join(dir, 'session.jsonl')), `${name}/session.jsonl`).toBe(true)
        expect(existsSync(join(dir, 'replay.override.json')), `${name}/replay.override.json presence must match \`overridden\``)
          .toBe(overridden === true)
        expect(existsSync(join(dir, SYSTEM_PROMPT_SNAPSHOT)), `${name}/${SYSTEM_PROMPT_SNAPSHOT} presence must match \`pinsHeader\``)
          .toBe(pinsHeader === true)
        expect(existsSync(join(dir, TOOL_SCHEMAS_SNAPSHOT)), `${name}/${TOOL_SCHEMAS_SNAPSHOT} presence must match \`pinsHeader\``)
          .toBe(pinsHeader === true)
        // A nested-agent scenario ships one child fixture per recorded subagent
        // session (`session.1.jsonl` …), the replay source for that child session.
        for (const childFixture of childFixturePaths(dir, childSessions ?? 0)) {
          expect(existsSync(childFixture), childFixture).toBe(true)
        }
      }
    })

    it('exactly one scenario pins the request-header content of each header class', () => {
      // Zero pins would drop a class's prompt/schema surface from the suite entirely; two would
      // split it.
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

    it('every pinning fixture carries one tokenized request/header, two sidecars, and its declared deltas', async () => {
      // The live uniformity guard runs only in NON-pinning scenarios, so a class made of just
      // its pinning scenario would otherwise accept a re-recorded pin with several headers or
      // an undeclared mid-run header-delta — shapes the pin design cannot represent.
      for (const scenario of pinningByClass.values()) {
        const fixture = await readFile(join(snapshotsDir, scenario.name, 'session.jsonl'), 'utf8')
        const headers = normalizedHeaders(fixture, fixtureContext(fixture))
        const promptSnapshot = await readFile(join(snapshotsDir, scenario.name, SYSTEM_PROMPT_SNAPSHOT), 'utf8')
        const toolSchemasSnapshot = await readFile(join(snapshotsDir, scenario.name, TOOL_SCHEMAS_SNAPSHOT), 'utf8')
        const toolSchemas = parseToolSchemasSnapshot(toolSchemasSnapshot)
        expect(headers.length, `${scenario.name}: a pinning fixture must carry exactly one request/header`).toBe(1)
        expect(() => restorePinnedToolSchemas(headers[0], toolSchemas), `${scenario.name}: tools must use the sidecar token`)
          .not.toThrow()
        expect(promptSnapshot.length, `${scenario.name}/${SYSTEM_PROMPT_SNAPSHOT} must not be empty`).toBeGreaterThan(0)
        expect(promptSnapshot.endsWith('\n'), `${scenario.name}/${SYSTEM_PROMPT_SNAPSHOT} must end in a newline`).toBe(true)
        expect(toolSchemasSnapshot, `${scenario.name}/${TOOL_SCHEMAS_SNAPSHOT} must use canonical JSON formatting`)
          .toBe(formatToolSchemasSnapshot(toolSchemas.initial, toolSchemas.deltas))
        expect(headerDeltaCount(fixture), `${scenario.name}: a pinning fixture must carry exactly its declared request/header-deltas`)
          .toBe(scenario.expectedHeaderDeltas ?? 0)
      }
    })

    it('every committed JSONL has valid tool results and canonical header storage', async () => {
      // Prompts and schemas always leave JSONL. Header pins retain prefixes;
      // every other fixture tokenizes those too. Fixed-point checks make both
      // storage rules fail loud.
      for (const scenario of scenarios) {
        const dir = join(snapshotsDir, scenario.name)
        const files = [
          'session.jsonl',
          ...Array.from({ length: scenario.childSessions ?? 0 }, (_, i) => `session.${i + 1}.jsonl`),
        ]
        for (const file of files) {
          const fixture = await readFile(join(dir, file), 'utf8')
          expect(unknownToolCallIds(fixture), `${scenario.name}/${file} contains UNKNOWN_TOOL`)
            .toEqual([])
          expect(scrubSystemPrompts(fixture), `${scenario.name}/${file} carries an unscrubbed system prompt`)
            .toEqual(fixture)
          expect(scrubToolSchemas(fixture), `${scenario.name}/${file} carries unscrubbed tool schemas`)
            .toEqual(fixture)
          if (scenario.pinsHeader !== true) {
            expect(scrubRequestHeaders(fixture), `${scenario.name}/${file} carries unscrubbed header content`)
              .toEqual(fixture)
          }
        }
      }
    })
  })
}
