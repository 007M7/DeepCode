/**
 * Keyless-by-default ACP snapshot suite factory. Each scenario drives the real
 * subprocess and compares normalized stdout; comparable session fixtures are
 * both replay input and expected output. Record mode refreshes reproducible
 * model scenarios from the live API, while refresh mode replays committed
 * scripts and rewrites derived artifacts without a key.
 * Replay scenarios run concurrently because each subprocess owns unique temp
 * cwd and persistence roots and reads only committed fixtures. Record and
 * refresh stay serial while writing.
 *
 * Exactly one scenario per header-composition class pins the full prompt and
 * tool-schema sequences in dedicated sidecars. Every live header is checked
 * against that pin, so session-dependent composition must declare a separate
 * class instead of escaping coverage.
 * @module @deepseek-ai/dsh-acp-snapshot/suite
 */

import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AgentUnderTest, type HarvestedLog, type InputScript, runScenario } from './harness.ts'
import {
  type CwdPathMode,
  type NormalizeContext,
  normalizeSessionLog,
  normalizeStdout,
  scrubRequestHeaders,
  scrubSystemPrompts,
  scrubToolSchemas,
} from './normalize.ts'

/** The readable system-prompt snapshot beside each header-pinning fixture. */
const SYSTEM_PROMPT_SNAPSHOT = 'system-prompt.expected.md'

/** The structured tool-schema snapshot beside each header-pinning fixture. */
const TOOL_SCHEMAS_SNAPSHOT = 'tool-schemas.expected.json'

/** The optional full Windows-native stdout transcript. */
const WINDOWS_STDOUT_SNAPSHOT = 'stdout.expected.windows.jsonl'

/** Stable session-log token standing in for the sidecar's initial schemas. */
const TOOLS_TOKEN = '{{tools}}'

const PACKED_CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/** A snapshot scenario and how its fixtures are produced. */
export interface Scenario {
  name: string
  /** Whether the scenario drives at least one model turn (so a JSONL expected output applies). */
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
   * Whether this scenario is its header class's sole request-header pin. Dedicated sidecars own
   * the prompt and tool schemas, while every classmate is checked for equality.
   */
  pinsHeader?: boolean
  /**
   * How many changed `request/header` snapshots this PINNING scenario's primary
   * fixture legitimately carries (default 0). Their full prompt text is kept in
   * the readable Markdown pin; any other count fails. Meaningless off the pin.
   */
  expectedHeaderChanges?: number
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
  /**
   * Parent directory for the generated session cwd. Defaults to the platform
   * temp directory; set this when temp is itself part of the behavior under
   * test and the scenario needs an independent project location.
   */
  workspaceParent?: string
  /**
   * Whether Windows additionally compares stdout with native separators against
   * `stdout.expected.windows.jsonl`. The shared canonical stdout expected output is still
   * compared on every platform, and the fixture guard requires this sidecar
   * exactly when the option is set.
   */
  pinsNativeWindowsStdout?: boolean
  /**
   * Whether the driven behavior needs POSIX process semantics the harness
   * cannot exercise on Windows (e.g. cancelling a live bash tool call kills a
   * detached process group). The scenario's run test is skipped on Windows;
   * its fixtures stay guarded on every platform.
   */
  posixOnly?: boolean
}

/**
 * Whether a scenario's run test is skipped for this mode and host: record mode
 * skips authored (non-`recorded`) scenarios, and {@link Scenario.posixOnly}
 * scenarios skip on Windows.
 *
 * @param scenario The scenario whose run test is being registered.
 * @param recording Whether the suite runs in record mode.
 * @param platform The running Node platform, injectable for unit coverage.
 * @returns True when the scenario's run test must not execute.
 */
export function scenarioSkipped(
  scenario: Scenario,
  recording: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (recording && !scenario.recorded) return true
  return scenario.posixOnly === true && platform === 'win32'
}

/** One stdout expected output selected for a platform run. */
interface StdoutExpectedVariant {
  file: string
  cwdPathMode: CwdPathMode
}

/**
 * Select the shared stdout expected output plus any platform-native assertion declared by a scenario.
 *
 * @param scenario The scenario whose stdout contract is being selected.
 * @param platform The running Node platform, injectable for unit coverage.
 * @returns The ordered expected-output variants: shared canonical first, then optional Windows native.
 */
export function stdoutExpectedVariants(
  scenario: Scenario,
  platform: NodeJS.Platform = process.platform,
): StdoutExpectedVariant[] {
  const canonical: StdoutExpectedVariant = { file: 'stdout.expected.jsonl', cwdPathMode: 'canonical' }
  if (platform !== 'win32' || scenario.pinsNativeWindowsStdout !== true) return [canonical]
  return [canonical, { file: WINDOWS_STDOUT_SNAPSHOT, cwdPathMode: 'native' }]
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
   * `recorded` scenarios' fixtures and refreshes the Vitest expected outputs under
   * `--update`), or `refresh` (keyless replay that rewrites stdout expected outputs and
   * comparable session fixtures from the replay run). The caller derives this
   * from `$DSH_SNAPSHOT` — env reading stays outside this library.
   */
  mode: 'replay' | 'record' | 'refresh'
}

/**
 * Validate and order a scenario directory's session-fixture filenames.
 *
 * The primary fixture is always `session.jsonl`; child sessions are discovered
 * from contiguous `session.1.jsonl` … filenames. The directory is the source of
 * truth, so scenario tables do not duplicate a child count that can drift from
 * the files. A session-like JSONL with any other suffix fails loud.
 *
 * @param names File names in one scenario directory.
 * @returns The primary and child fixture names in replay/harvest order.
 */
export function sessionFixtureNames(names: readonly string[]): string[] {
  if (!names.includes('session.jsonl')) throw new Error('missing session.jsonl')
  const children: { name: string; index: number }[] = []
  for (const name of names) {
    if (name === 'session.jsonl') continue
    if (!name.startsWith('session.') || !name.endsWith('.jsonl')) continue
    const match = /^session\.([1-9]\d*)\.jsonl$/.exec(name)
    if (match === null) throw new Error(`invalid child session fixture name: ${name}`)
    children.push({ name, index: Number(match[1]) })
  }
  children.sort((a, b) => a.index - b.index)
  for (const [offset, child] of children.entries()) {
    const expected = offset + 1
    if (child.index !== expected) {
      throw new Error(`child session fixtures must be contiguous: expected session.${expected}.jsonl, found ${child.name}`)
    }
  }
  return ['session.jsonl', ...children.map(child => child.name)]
}

/** Read one scenario directory's validated session-fixture inventory. */
async function sessionFixtures(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return sessionFixtureNames(entries.filter(entry => entry.isFile()).map(entry => entry.name))
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
 * each embedding its own generated cwd in the composed prompt — compare on equal
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

/** The structured contents of a tool-schema sidecar. */
export interface ToolSchemasSnapshot {
  /** The complete tool schemas from the pinned request header. */
  initial: unknown[]
  /** Complete tool schemas from subsequent changed-header snapshots. */
  changes: unknown[][]
}

/**
 * Render the full tool-schema sequence as canonical, readable JSON.
 *
 * @param initial The pinned request header's complete tool schemas.
 * @param changes Complete tool schemas from later changed headers.
 * @returns A pretty-printed JSON snapshot ending in one newline.
 */
export function formatToolSchemasSnapshot(initial: readonly unknown[], changes: readonly unknown[][] = []): string {
  return `${JSON.stringify({ initial, changes }, null, 2)}\n`
}

/**
 * Parse and validate the stable top-level shape of a tool-schema sidecar.
 *
 * @param snapshot The JSON sidecar text.
 * @returns Its initial and changed-header schema sets.
 */
export function parseToolSchemasSnapshot(snapshot: string): ToolSchemasSnapshot {
  const parsed = JSON.parse(snapshot) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('acp-snapshot: tool-schema snapshot must be an object')
  }
  const { initial, changes } = parsed as { initial?: unknown; changes?: unknown }
  if (!Array.isArray(initial) || !Array.isArray(changes) || !changes.every(Array.isArray)) {
    throw new Error('acp-snapshot: tool-schema snapshot must carry array-valued initial and changes fields')
  }
  return { initial, changes }
}

/**
 * Restore one sidecar schema set into a tokenized pinned header.
 *
 * @param header The parsed request header carrying `tools: "{{tools}}"`.
 * @param schemas The complete schemas for this full header snapshot.
 * @returns A copy of the header with its complete schemas restored.
 */
export function restorePinnedToolSchemas(header: unknown, schemas: readonly unknown[]): unknown {
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('acp-snapshot: pinned request header must be an object')
  }
  if ((header as { tools?: unknown }).tools !== TOOLS_TOKEN) {
    throw new Error(`acp-snapshot: pinned request header tools must equal ${TOOLS_TOKEN}`)
  }
  return { ...header, tools: schemas }
}

/**
 * Render a normalized prompt as a repository-friendly Markdown snapshot.
 * Prompt text is unchanged except that a missing terminal newline is added so
 * the committed file follows the repository newline contract.
 *
 * @param prompt The normalized system prompt.
 * @param changes Full normalized prompts from later changed-header snapshots.
 * @returns Markdown snapshot text ending in a newline.
 */
export function formatSystemPromptSnapshot(
  prompt: string,
  changes: readonly string[] = [],
): string {
  let snapshot = prompt.endsWith('\n') ? prompt : `${prompt}\n`
  for (const [index, change] of changes.entries()) {
    snapshot += `\n<!-- request/header change ${index + 1} -->\n\n`
    snapshot += change.endsWith('\n') ? change : `${change}\n`
  }
  return snapshot
}

/** Return the initial-prompt portion of a possibly multi-header snapshot. */
function initialSystemPromptSnapshot(snapshot: string): string {
  const marker = snapshot.indexOf('\n<!-- request/header change ')
  return marker < 0 ? snapshot : snapshot.slice(0, marker)
}

/**
 * Count changed `request/header` snapshots in a session JSONL.
 *
 * @param rawLog The session `.jsonl` content.
 * @returns How many headers carry reason `change`.
 */
export function headerChangeCount(rawLog: string): number {
  return rawLog.split('\n')
    .filter(line => line.trim().length > 0)
    .filter((line) => {
      const record = JSON.parse(line) as { type?: unknown; data?: { reason?: unknown } }
      return record.type === 'request/header' && record.data?.reason === 'change'
    })
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

/** One packed row's member times, or `undefined` for an ordinary record. */
function packedTimes(record: Record<string, unknown>): number[] | undefined {
  if (!PACKED_CHUNK_ROW_TYPES.has(record.type as string)) return undefined
  const row = record as unknown as { time0: number; data: { dt: number[] } }
  const times = [row.time0]
  for (const gap of row.data.dt) times.push((times[times.length - 1] as number) + gap)
  return times
}

/** Expand packed timing envelopes so refresh alignment follows logical events, not physical lines. */
function logicalRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.flatMap((record) => {
    const times = packedTimes(record)
    return times === undefined ? [record] : times.map(time => ({ type: 'assistant/chunk', time }))
  })
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

/** Carry logical member times into a fresh packed row while leaving its fragment arrays untouched. */
function preservePackedMemberTimes(
  record: Record<string, unknown>,
  existingMembers: Record<string, unknown>[],
): void {
  if (!PACKED_CHUNK_ROW_TYPES.has(record.type as string)) return
  const row = record as unknown as { time0: number; data: { dt: number[] } }
  const firstTime = existingMembers[0]?.time
  if (!Number.isSafeInteger(firstTime)) return
  row.time0 = firstTime as number
  if (existingMembers.length !== row.data.dt.length + 1) return
  const times = existingMembers.map(member => Number.isSafeInteger(member.time) ? member.time as number : undefined)
  if (times.some(time => time === undefined)) return
  const memberTimes = times as number[]
  const gaps = memberTimes.slice(1).map((time, index) => time - (memberTimes[index] as number))
  if (gaps.some(gap => !Number.isSafeInteger(gap))) return
  row.data.dt = gaps
}

/**
 * Rewrite a fresh replay-produced log so repeated refreshes do not churn
 * volatile fixture fields. Meaningful event payloads come from `fresh`; the
 * existing fixture lends session ids, cwd, creation times, logical event
 * times, and hook durations where the record shape still matches. Packed
 * timing envelopes expand for alignment, so packing does not shift later
 * records; fresh fragment arrays remain authoritative.
 *
 * @param fresh The newly harvested session JSONL.
 * @param existing The committed fixture JSONL being refreshed.
 * @param replacements Cross-log literal replacements from {@link refreshFixtureReplacements}.
 * @returns The stabilized JSONL content to write back.
 */
export function stabilizeRefreshLog(fresh: string, existing: string, replacements: FixtureReplacement[]): string {
  let stable = fresh
  for (const { from, to } of replacements) stable = stable.split(from).join(to)
  const existingRecords = logicalRecords(parseJsonlRecords(existing))
  const records = parseJsonlRecords(stable)
  let existingIndex = 0
  let previousEventTime: unknown
  for (let i = 0; i < records.length; i++) {
    const record = records[i] as Record<string, unknown>
    const existingRecord = existingRecords[existingIndex]
    const memberCount = packedTimes(record)?.length ?? 1
    const insertedTitle = record.type === 'session/title' && existingRecord?.type !== 'session/title'
    if (insertedTitle) {
      /* v8 ignore next -- a title is turn-enclosed, so a preceding event time exists in every valid fixture. */
      if (typeof previousEventTime !== 'number') throw new Error('acp-snapshot: inserted title has no preceding event time')
      record.time = previousEventTime
    } else {
      preservePackedMemberTimes(record, existingRecords.slice(existingIndex, existingIndex + memberCount))
      preserveFixtureVolatiles(record, existingRecord)
      existingIndex += memberCount
    }
    if (typeof record.time === 'number') previousEventTime = record.time
  }
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

/**
 * Register the suite: one test per scenario (the expected-output and log comparisons and
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
      // (sidecar-driven errors/cancel) are never re-recorded. `posixOnly` scenarios skip on
      // Windows, where their process semantics cannot be driven.
      it.skipIf(scenarioSkipped(scenario, RECORDING))(`snapshot: ${scenario.name} matches the expected outputs`, async ({ expect }) => {
        const dir = join(snapshotsDir, scenario.name)
        const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')) as InputScript
        const overrideFile = join(dir, 'replay.override.json')
        const workspaceDir = join(dir, 'workspace')
        // Replay/refresh need the committed inventory up front because those
        // files drive the model scripts. Record mode creates that inventory
        // from the harvested live logs, so it must also work for a brand-new
        // scenario with no session.jsonl yet.
        let fixtureFiles = RECORDING ? [] : await sessionFixtures(dir)
        const childFixtureFiles = fixtureFiles.slice(1)
        const comparesLog = scenario.comparesLog ?? scenario.hasModelTurn
        const result = await runScenario(input, {
          agent,
          mode: childMode,
          fixtureFile: join(dir, 'session.jsonl'),
          ...existsSync(overrideFile) ? { overrideFile } : {},
          // In REPLAY, forward the recorded child fixtures so each subagent session
          // replays from its own script. In RECORD they are harvested, not read.
          ...!RECORDING && childFixtureFiles.length > 0 ? { childFiles: childFixtureFiles.map(file => join(dir, file)) } : {},
          ...existsSync(workspaceDir) ? { workspaceDir } : {},
          ...scenario.workspaceParent !== undefined ? { workspaceParent: scenario.workspaceParent } : {},
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
          cwdAliases: result.cwdAliases,
        }

        // Record writes live model fixtures; keyless refresh writes every comparable replayed
        // fixture. Pinning JSONL keeps prefixes but moves prompts and schemas into sidecars.
        const scrub = scenario.pinsHeader === true
          ? (log: string): string => scrubToolSchemas(scrubSystemPrompts(log))
          : scrubRequestHeaders
        const existingFixtures = REFRESHING
          ? await Promise.all(fixtureFiles.map(file => readFile(join(dir, file), 'utf8')))
          : []
        const replacements = REFRESHING ? refreshFixtureReplacements(result.sessionLogs, existingFixtures) : []
        const writesSessionFixtures = (RECORDING && scenario.recorded && scenario.hasModelTurn)
          || (REFRESHING && comparesLog)
        if (writesSessionFixtures) {
          expect(result.sessionLogs.length, `${mode} produced no session log to harvest`).toBeGreaterThan(0)
          if (REFRESHING) {
            expect(result.sessionLogs.length, `expected ${fixtureFiles.length} session logs (parent + children)`)
              .toBe(fixtureFiles.length)
          }
          const outputFixtureFiles = [
            'session.jsonl',
            ...Array.from({ length: result.sessionLogs.length - 1 }, (_, i) => `session.${i + 1}.jsonl`),
          ]
          const primary = (result.sessionLogs[0] as HarvestedLog).content
          await writeFile(join(dir, outputFixtureFiles[0] as string), scrub(
            REFRESHING ? stabilizeRefreshLog(primary, existingFixtures[0] as string, replacements) : primary,
          ))
          for (let i = 1; i < result.sessionLogs.length; i++) {
            const child = (result.sessionLogs[i] as HarvestedLog).content
            await writeFile(join(dir, outputFixtureFiles[i] as string), scrub(
              REFRESHING ? stabilizeRefreshLog(child, existingFixtures[i] as string, replacements) : child,
            ))
          }
          if (RECORDING) {
            const outputNames = new Set(outputFixtureFiles)
            const entries = await readdir(dir, { withFileTypes: true })
            await Promise.all(entries
              .filter(entry => entry.isFile()
                // Only valid numbered children are record-owned stale output.
                // Malformed session-like names stay for the inventory guard to
                // reject instead of being silently deleted during mutation.
                && /^session\.[1-9]\d*\.jsonl$/.test(entry.name)
                && !outputNames.has(entry.name))
              .map(entry => rm(join(dir, entry.name))))
            fixtureFiles = outputFixtureFiles
          }
          if (scenario.pinsHeader === true) {
            const primary = result.sessionLogs[0] as HarvestedLog
            const prompts = normalizedSystemPrompts(primary.content, ctx)
            expect(prompts.length, `${mode} produced no system prompt to snapshot`).toBeGreaterThan(0)
            const snapshot = formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1))
            await writeFile(join(dir, SYSTEM_PROMPT_SNAPSHOT), snapshot)

            const schemaSets = normalizedToolSchemas(primary.content, ctx)
            expect(schemaSets.length, `${mode} produced no tool schemas to snapshot`).toBeGreaterThan(0)
            expect(schemaSets.length, `${mode} produced a tool-schema sequence that differs from its prompt sequence`)
              .toBe(prompts.length)
            await writeFile(join(dir, TOOL_SCHEMAS_SNAPSHOT), formatToolSchemasSnapshot(
              schemaSets[0] as unknown[],
              schemaSets.slice(1),
            ))
          }
        }

        for (const expected of stdoutExpectedVariants(scenario)) {
          const stdout = normalizeStdout(result.rawStdout, ctx, { cwdPathMode: expected.cwdPathMode })
          if (REFRESHING) {
            await writeFile(join(dir, expected.file), stdout)
          }
          await expect(stdout, `${expected.file} mismatch`).toMatchFileSnapshot(join(dir, expected.file))
        }

        // A model turn always produces a log worth comparing; a hook scenario can
        // produce one without a model turn (a `rejected` turn carrying `hook/*`).
        if (comparesLog) {
          // The harvested logs (primary-first) must match their committed fixtures 1:1.
          expect(result.sessionLogs.length, 'this scenario must persist one log per session fixture').toBe(fixtureFiles.length)
          for (let i = 0; i < fixtureFiles.length; i++) {
            const harvested = scrub((result.sessionLogs[i] as HarvestedLog).content)
            const fixture = scrub(await readFile(join(dir, fixtureFiles[i] as string), 'utf8'))
            expect(normalizeSessionLog(harvested, ctx), `${fixtureFiles[i]} mismatch`)
              .toEqual(normalizeSessionLog(fixture, fixtureContext(fixture)))
          }
        }

        // Every live full header must equal its class pin reconstructed from
        // tokenized JSONL plus readable prompt and structured schema sidecars.
        /* v8 ignore next -- construction guarantees the pin exists; a miss would fail the one-header assertion loudly. */
        const pinningScenario = pinningByClass.get(classOf(scenario)) ?? scenario
        const pinningDir = join(snapshotsDir, pinningScenario.name)
        const pinnedFixture = await readFile(join(pinningDir, 'session.jsonl'), 'utf8')
        const pinned = normalizedHeaders(pinnedFixture, fixtureContext(pinnedFixture))
        const promptSnapshot = await readFile(join(pinningDir, SYSTEM_PROMPT_SNAPSHOT), 'utf8')
        const initialPromptSnapshot = initialSystemPromptSnapshot(promptSnapshot)
        expect(pinned.length, `the pinning fixture (${pinningScenario.name}) has an unexpected request/header count`)
          .toBe(1 + (pinningScenario.expectedHeaderChanges ?? 0))
        const toolSchemasSnapshot = await readFile(join(pinningDir, TOOL_SCHEMAS_SNAPSHOT), 'utf8')
        const toolSchemas = parseToolSchemasSnapshot(toolSchemasSnapshot)
        const pinnedSchemaSets = [toolSchemas.initial, ...toolSchemas.changes]
        expect(pinnedSchemaSets.length, `the pinning fixture (${pinningScenario.name}) has an unexpected tool-schema count`)
          .toBe(pinned.length)
        const pinnedHeaders = pinned.map((header, index) => restorePinnedToolSchemas(
          header,
          pinnedSchemaSets[index] as unknown[],
        ))
        for (const [logIndex, log] of result.sessionLogs.entries()) {
          const expectedChanges = scenario.pinsHeader === true && logIndex === 0
            ? scenario.expectedHeaderChanges ?? 0
            : 0
          expect(headerChangeCount(log.content), `session ${log.id}: changed request/header count`)
            .toBe(expectedChanges)
          const headers = normalizedHeaders(scrubSystemPrompts(log.content), ctx)
          const prompts = normalizedSystemPrompts(log.content, ctx)
          const schemaSets = normalizedToolSchemas(log.content, ctx)
          expect(prompts.length, `session ${log.id}: every request/header must carry a string system prompt`)
            .toBe(headers.length)
          expect(schemaSets.length, `session ${log.id}: every request/header must carry an array-valued tools field`)
            .toBe(headers.length)
          for (const [k, header] of headers.entries()) {
            const expected = expectedChanges > 0 ? pinnedHeaders[k] : pinnedHeaders[0]
            expect(header, `session ${log.id}: request/header #${k + 1} diverged from the pinned (${pinningScenario.name}) header`)
              .toEqual(expected)
            if (expectedChanges === 0) {
              expect(formatSystemPromptSnapshot(prompts[k] as string), `session ${log.id}: initial system prompt #${k + 1} diverged from ${pinningScenario.name}/${SYSTEM_PROMPT_SNAPSHOT}`)
                .toEqual(initialPromptSnapshot)
            }
          }
          if (scenario.pinsHeader === true && logIndex === 0) {
            expect(formatSystemPromptSnapshot(
              prompts[0] as string,
              prompts.slice(1),
            ), `session ${log.id}: changed system prompts diverged from ${pinningScenario.name}/${SYSTEM_PROMPT_SNAPSHOT}`)
              .toEqual(promptSnapshot)
            expect(formatToolSchemasSnapshot(
              schemaSets[0] as unknown[],
              schemaSets.slice(1),
            ), `session ${log.id}: changed tool schemas diverged from ${pinningScenario.name}/${TOOL_SCHEMAS_SNAPSHOT}`)
              .toEqual(toolSchemasSnapshot)
          }
        }
      })
    }
  })

  describe('snapshot fixtures', () => {
    it('every scenario directory is registered (no orphans)', async () => {
      // toMatchFileSnapshot does not prune orphaned expected-output or fixture files, so a
      // renamed/removed scenario could leave a stale dir that nothing exercises.
      // Fail loud on any snapshots/<dir> not present in the scenario table.
      const entries = await readdir(snapshotsDir, { withFileTypes: true })
      const onDisk = entries.filter(e => e.isDirectory()).map(e => e.name).sort()
      const registered = scenarios.map(s => s.name).sort()
      expect(onDisk).toEqual(registered)
    })

    it('every registered scenario has its required fixture files', async () => {
      // Every scenario needs input, stdout, a primary session fixture, and matching optional sidecars.
      for (const { name, overridden, pinsHeader, pinsNativeWindowsStdout } of scenarios) {
        const dir = join(snapshotsDir, name)
        expect(existsSync(join(dir, 'input.json')), `${name}/input.json`).toBe(true)
        expect(existsSync(join(dir, 'stdout.expected.jsonl')), `${name}/stdout.expected.jsonl`).toBe(true)
        expect(
          existsSync(join(dir, WINDOWS_STDOUT_SNAPSHOT)),
          `${name}/${WINDOWS_STDOUT_SNAPSHOT} presence must match \`pinsNativeWindowsStdout\``,
        ).toBe(pinsNativeWindowsStdout === true)
        expect(existsSync(join(dir, 'session.jsonl')), `${name}/session.jsonl`).toBe(true)
        expect(existsSync(join(dir, 'replay.override.json')), `${name}/replay.override.json presence must match \`overridden\``)
          .toBe(overridden === true)
        expect(existsSync(join(dir, SYSTEM_PROMPT_SNAPSHOT)), `${name}/${SYSTEM_PROMPT_SNAPSHOT} presence must match \`pinsHeader\``)
          .toBe(pinsHeader === true)
        expect(existsSync(join(dir, TOOL_SCHEMAS_SNAPSHOT)), `${name}/${TOOL_SCHEMAS_SNAPSHOT} presence must match \`pinsHeader\``)
          .toBe(pinsHeader === true)
        await expect(sessionFixtures(dir), `${name}: session fixture inventory`).resolves.toBeDefined()
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

    it('every pinning fixture carries one tokenized header sequence and two sidecars', async () => {
      // Assert the committed pin directly because a class containing only its
      // pinning scenario has no non-pinning live run to catch undeclared changes.
      for (const scenario of pinningByClass.values()) {
        const fixture = await readFile(join(snapshotsDir, scenario.name, 'session.jsonl'), 'utf8')
        const headers = normalizedHeaders(fixture, fixtureContext(fixture))
        const promptSnapshot = await readFile(join(snapshotsDir, scenario.name, SYSTEM_PROMPT_SNAPSHOT), 'utf8')
        expect(headers.length, `${scenario.name}: unexpected request/header count`)
          .toBe(1 + (scenario.expectedHeaderChanges ?? 0))
        const toolSchemasSnapshot = await readFile(join(snapshotsDir, scenario.name, TOOL_SCHEMAS_SNAPSHOT), 'utf8')
        const toolSchemas = parseToolSchemasSnapshot(toolSchemasSnapshot)
        const schemaSets = [toolSchemas.initial, ...toolSchemas.changes]
        expect(schemaSets.length, `${scenario.name}: tool-schema sequence must match the header sequence`)
          .toBe(headers.length)
        for (const [index, header] of headers.entries()) {
          expect(() => restorePinnedToolSchemas(header, schemaSets[index] as unknown[]), `${scenario.name}: tools must use the sidecar token`)
            .not.toThrow()
        }
        expect(promptSnapshot.length, `${scenario.name}/${SYSTEM_PROMPT_SNAPSHOT} must not be empty`).toBeGreaterThan(0)
        expect(promptSnapshot.endsWith('\n'), `${scenario.name}/${SYSTEM_PROMPT_SNAPSHOT} must end in a newline`).toBe(true)
        expect(toolSchemasSnapshot, `${scenario.name}/${TOOL_SCHEMAS_SNAPSHOT} must use canonical JSON formatting`)
          .toBe(formatToolSchemasSnapshot(toolSchemas.initial, toolSchemas.changes))
        expect(headerChangeCount(fixture), `${scenario.name}: a pinning fixture must carry exactly its declared changed headers`)
          .toBe(scenario.expectedHeaderChanges ?? 0)
      }
    })

    it('every committed JSONL has valid tool results and canonical header storage', async () => {
      // Prompts and schemas always leave JSONL. Header pins retain prefixes;
      // every other fixture tokenizes those too. Fixed-point checks make both
      // storage rules fail loud.
      for (const scenario of scenarios) {
        const dir = join(snapshotsDir, scenario.name)
        const files = await sessionFixtures(dir)
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
