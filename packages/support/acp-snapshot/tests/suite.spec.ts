import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { defineAcpSnapshotSuite, type HarvestedLog, type Scenario } from '../src/index.ts'
import {
  fixtureContext,
  formatSystemPromptSnapshot,
  headerChangeCount,
  formatToolSchemasSnapshot,
  normalizedHeaders,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseToolSchemasSnapshot,
  refreshFixtureReplacements,
  sessionFixtureNames,
  restorePinnedToolSchemas,
  stabilizeRefreshLog,
  unknownToolCallIds,
} from '../src/suite.ts'

/**
 * Unit tests for the suite factory, by running it: two synthetic suites over the scripted fake
 * ACP bin (./fixtures/fake-acp-agent.ts) register real describe/it trees at collection time,
 * so every factory path — expected-output and log comparisons, the per-suite header pin and its uniformity
 * guard, record-mode fixture write-back, skip semantics, and the fixture guard block —
 * executes as an ordinary green test.
 *
 * Record tests use a temp copy. To intentionally rebuild their committed fixtures, run this
 * spec once with `ACP_SNAPSHOT_SPEC_BOOTSTRAP=1`, then review and commit the resulting tree.
 */

const fakeAgent = fileURLToPath(new URL('./fixtures/fake-acp-agent.ts', import.meta.url))
const AGENT = {
  binScript: fakeAgent,
  libBinScript: fakeAgent,
  configPath: fakeAgent,
  tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
}

const REPLAY_DIR = fileURLToPath(new URL('./fixtures/suite', import.meta.url))
const RECORD_SRC = fileURLToPath(new URL('./fixtures/record-suite', import.meta.url))

// Replay pins explicit header classes; recording covers the default fallback.
const REPLAY_SCENARIOS: Scenario[] = [
  { name: 'pin-turn', hasModelTurn: true, recorded: true, pinsHeader: true, expectedHeaderChanges: 1, headerClass: 'main' },
  { name: 'plain-turn', hasModelTurn: true, recorded: true, headerClass: 'main', configPath: AGENT.configPath },
  { name: 'no-model', hasModelTurn: false, recorded: false, headerClass: 'main' },
  { name: 'blocked-log', hasModelTurn: false, comparesLog: true, recorded: false, headerClass: 'main' },
  { name: 'authored-error', hasModelTurn: true, recorded: false, overridden: true, headerClass: 'main' },
]

const RECORD_SCENARIOS: Scenario[] = [
  { name: 'rec-pin', hasModelTurn: true, recorded: true, pinsHeader: true },
  { name: 'rec-child', hasModelTurn: true, recorded: true },
  // recorded:false in record mode → registered but skipped (never re-recorded).
  { name: 'rec-skip', hasModelTurn: true, recorded: false, overridden: true },
]

// Record/refresh modes mutate their snapshots dir, so run them on throwaway
// copies — except record's documented bootstrap knob, which regenerates the
// committed record fixtures and expected outputs in place.
const BOOTSTRAP = process.env.ACP_SNAPSHOT_SPEC_BOOTSTRAP === '1'
const recordDir = BOOTSTRAP ? RECORD_SRC : mkdtempSync(join(tmpdir(), 'acp-snap-record-suite-'))
if (!BOOTSTRAP) {
  cpSync(RECORD_SRC, recordDir, { recursive: true })
  // Record mode owns its output inventory: a new scenario has no primary yet,
  // while a changed child count can leave old numbered fixtures behind.
  rmSync(join(recordDir, 'rec-pin', 'session.jsonl'))
  writeFileSync(join(recordDir, 'rec-child', 'session.2.jsonl'), 'stale child\n')
}
const refreshDir = mkdtempSync(join(tmpdir(), 'acp-snap-refresh-suite-'))
cpSync(REPLAY_DIR, refreshDir, { recursive: true })
staleRefreshFixtures(refreshDir)
afterAll(async () => {
  if (!BOOTSTRAP) await rm(recordDir, { recursive: true, force: true })
  await rm(refreshDir, { recursive: true, force: true })
})

function staleRefreshFixtures(dir: string): void {
  writeFileSync(join(dir, 'plain-turn', 'stdout.expected.jsonl'), 'stale stdout\n')
  writeFileSync(join(dir, 'pin-turn', 'system-prompt.expected.md'), 'STALE PROMPT\n')
  writeFileSync(join(dir, 'pin-turn', 'tool-schemas.expected.json'), '{"initial":[{"name":"stale"}],"changes":[]}\n')

  const plainBehaviorFile = join(dir, 'plain-turn', 'behavior.json')
  const plainBehavior = JSON.parse(readFileSync(plainBehaviorFile, 'utf8')) as Record<string, unknown>
  plainBehavior.echoEnv = true
  writeFileSync(plainBehaviorFile, `${JSON.stringify(plainBehavior, null, 2)}\n`)

  writeFileSync(join(dir, 'blocked-log', 'session.jsonl'), [
    '{"type":"session","id":"99999999-8888-4777-8666-555555555555","createdAt":13,"cwd":"/rec/blocked-cwd","delegationDepth":0}',
    '{"type":"hook/result","seq":1,"time":13,"data":{"decision":"stale","durationMs":99}}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'authored-error', 'session.jsonl'), [
    '{"type":"session","id":"77777777-8888-4777-8666-555555555555","createdAt":13,"cwd":"/rec/error-cwd","delegationDepth":0}',
    '{"type":"turn/end","seq":1,"time":9,"data":{"error":"stale"}}',
    '',
  ].join('\n'))
}

describe('defineAcpSnapshotSuite: replay mode', () => {
  defineAcpSnapshotSuite({ agent: AGENT, snapshotsDir: REPLAY_DIR, scenarios: REPLAY_SCENARIOS, mode: 'replay' })
})

// The record suite's tests run in registration order: rec-pin re-records the
// pinned fixture FIRST, so rec-child's uniformity guard reads the fresh pin.
describe('defineAcpSnapshotSuite: record mode', () => {
  defineAcpSnapshotSuite({ agent: AGENT, snapshotsDir: recordDir, scenarios: RECORD_SCENARIOS, mode: 'record' })
})

describe('defineAcpSnapshotSuite: refresh mode', () => {
  defineAcpSnapshotSuite({ agent: AGENT, snapshotsDir: refreshDir, scenarios: REPLAY_SCENARIOS, mode: 'refresh' })
})

describe('defineAcpSnapshotSuite: refresh write-back', () => {
  it('rewrites stdout and comparable logs from a replay-mode child run', () => {
    const stdout = readFileSync(join(refreshDir, 'plain-turn', 'stdout.expected.jsonl'), 'utf8')
    expect(stdout).not.toContain('stale stdout')
    expect(stdout).toContain('env:{\\"mode\\":\\"replay\\"')
    expect(stdout).not.toContain('\\"mode\\":\\"refresh\\"')

    const blocked = readFileSync(join(refreshDir, 'blocked-log', 'session.jsonl'), 'utf8')
    expect(blocked).toContain('"decision":"block"')
    expect(blocked).not.toContain('"decision":"stale"')

    const authored = readFileSync(join(refreshDir, 'authored-error', 'session.jsonl'), 'utf8')
    expect(authored).toContain('"error":"model exploded"')
    expect(authored).not.toContain('"error":"stale"')

    expect(readFileSync(join(refreshDir, 'pin-turn', 'system-prompt.expected.md'), 'utf8')).toBe([
      'SYS PROMPT',
      '',
      '<!-- request/header change 1 -->',
      '',
      'SYS PROMPT',
      '',
      'NEW PROMPT LINE',
      '',
    ].join('\n'))
    const schemas = readFileSync(join(refreshDir, 'pin-turn', 'tool-schemas.expected.json'), 'utf8')
    expect(schemas).toContain('"description": "D1"')
    expect(schemas).not.toContain('"name":"stale"')
  })
})

describe('defineAcpSnapshotSuite: record inventory write-back', () => {
  it('creates a missing primary fixture and prunes stale child fixtures', () => {
    expect(readFileSync(join(recordDir, 'rec-pin', 'session.jsonl'), 'utf8')).toContain('"type":"session"')
    expect(() => readFileSync(join(recordDir, 'rec-child', 'session.2.jsonl'), 'utf8')).toThrow()
  })
})

describe('defineAcpSnapshotSuite: registration contract', () => {
  it("throws when a scenario's header class has no pinning scenario", () => {
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [{ name: 'pinless', hasModelTurn: true, recorded: true }],
        mode: 'replay',
      })
    }).toThrow(/no scenario pins the request-header content of class "default"/)
    // A pinned class does not cover a DIFFERENT class's members.
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [
          { name: 'pinned', hasModelTurn: true, recorded: true, pinsHeader: true },
          { name: 'classless-orphan', hasModelTurn: true, recorded: true, headerClass: 'other' },
        ],
        mode: 'replay',
      })
    }).toThrow(/class "other" \(needed by classless-orphan\)/)
  })

  it('throws when two scenarios pin the same header class', () => {
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [
          { name: 'first-pin', hasModelTurn: true, recorded: true, pinsHeader: true },
          { name: 'second-pin', hasModelTurn: true, recorded: true, pinsHeader: true },
        ],
        mode: 'replay',
      })
    }).toThrow(/header class "default" pinned by both first-pin and second-pin/)
  })
})

describe('sessionFixtureNames', () => {
  it('orders the primary and contiguous child fixtures while ignoring other files', () => {
    expect(sessionFixtureNames([
      'stdout.expected.jsonl',
      'session.2.jsonl',
      'session.jsonl',
      'session.1.jsonl',
      'input.json',
    ])).toEqual(['session.jsonl', 'session.1.jsonl', 'session.2.jsonl'])
  })

  it('accepts a primary-only scenario', () => {
    expect(sessionFixtureNames(['session.jsonl'])).toEqual(['session.jsonl'])
  })

  it('rejects a directory without the primary fixture', () => {
    expect(() => sessionFixtureNames(['session.1.jsonl'])).toThrow('missing session.jsonl')
  })

  it('rejects gapped child fixtures', () => {
    expect(() => sessionFixtureNames(['session.jsonl', 'session.2.jsonl']))
      .toThrow('expected session.1.jsonl, found session.2.jsonl')
  })

  it.each(['session.0.jsonl', 'session.child.jsonl', 'session.01.jsonl'])(
    'rejects invalid child fixture name %s',
    (name) => {
      expect(() => sessionFixtureNames(['session.jsonl', name]))
        .toThrow(`invalid child session fixture name: ${name}`)
    },
  )

  it('rejects duplicate child indexes', () => {
    expect(() => sessionFixtureNames(['session.jsonl', 'session.1.jsonl', 'session.1.jsonl']))
      .toThrow('expected session.2.jsonl, found session.1.jsonl')
  })
})

describe('fixtureContext', () => {
  it('reads the fixture header id and cwd', () => {
    const ctx = fixtureContext('{"type":"session","id":"abc","cwd":"/rec"}\n{"type":"turn/start"}\n')
    expect(ctx).toEqual({ sessionIds: ['abc'], cwd: '/rec' })
  })

  it('yields no session ids for a header without a string id', () => {
    expect(fixtureContext('{"type":"session","cwd":"/rec"}\n').sessionIds).toEqual([])
  })

  it('falls back to an impossible sentinel cwd (never the empty string)', () => {
    const ctx = fixtureContext('{"type":"session","id":"abc"}\n')
    expect(ctx.cwd).toBe('\0no-cwd\0')
    expect(ctx.cwd).not.toBe('')
  })

  it('treats an empty fixture as an empty header', () => {
    expect(fixtureContext('')).toEqual({ sessionIds: [], cwd: '\0no-cwd\0' })
  })
})

describe('normalizedHeaders', () => {
  const header = (system: string): string => JSON.stringify({
    type: 'request/header', seq: 0, time: 9, data: { header: { config: { model: 'm' }, system }, reason: 'initial' },
  })

  it('extracts every request/header payload in log order, normalized', () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const log = `${JSON.stringify({ type: 'session', id, createdAt: 5, cwd: '/w' })}\n${header('one')}\n`
      + `${JSON.stringify({ type: 'turn/start', seq: 1, time: 9, data: { turn: 1 } })}\n${header('two')}\n`
    const headers = normalizedHeaders(log, { sessionIds: [id], cwd: '/w' })
    expect(headers).toEqual([
      { config: { model: 'm' }, system: 'one' },
      { config: { model: 'm' }, system: 'two' },
    ])
  })

  it('yields nothing for a log without header events', () => {
    const log = `${JSON.stringify({ type: 'session', id: 'a', createdAt: 5 })}\n`
    expect(normalizedHeaders(log, { sessionIds: [], cwd: '/w' })).toEqual([])
  })
})

describe('normalizedSystemPrompts', () => {
  it('extracts normalized string prompts and omits absent or non-string fields', () => {
    const log = [
      '{"type":"session","id":"a","createdAt":5,"cwd":"/w"}',
      '{"type":"request/header","seq":0,"time":9,"data":{"header":{"system":"work in /w"}}}',
      '{"type":"request/header","seq":1,"time":9,"data":{"header":{}}}',
      '{"type":"request/header","seq":2,"time":9,"data":{"header":{"system":null}}}',
      '{"type":"request/header","seq":3,"time":9,"data":{"header":null}}',
      '{"type":"request/header","seq":4,"time":9,"data":{"header":"invalid"}}',
      '',
    ].join('\n')
    expect(normalizedSystemPrompts(log, { sessionIds: [], cwd: '/w' })).toEqual(['work in {{cwd}}'])
  })
})

describe('normalizedToolSchemas', () => {
  it('extracts normalized schema arrays and omits absent or non-array fields', () => {
    const log = [
      '{"type":"session","id":"a","createdAt":5,"cwd":"/w"}',
      '{"type":"request/header","seq":0,"time":9,"data":{"header":{"tools":[{"name":"read","description":"work in /w"}]}}}',
      '{"type":"request/header","seq":1,"time":9,"data":{"header":{}}}',
      '{"type":"request/header","seq":2,"time":9,"data":{"header":{"tools":null}}}',
      '{"type":"request/header","seq":3,"time":9,"data":{"header":null}}',
      '{"type":"request/header","seq":4,"time":9,"data":{"header":"invalid"}}',
      '',
    ].join('\n')
    expect(normalizedToolSchemas(log, { sessionIds: [], cwd: '/w' })).toEqual([
      [{ name: 'read', description: 'work in {{cwd}}' }],
    ])
  })
})

describe('formatSystemPromptSnapshot', () => {
  it('adds a missing terminal newline without changing an existing one', () => {
    expect(formatSystemPromptSnapshot('prompt')).toBe('prompt\n')
    expect(formatSystemPromptSnapshot('prompt\n')).toBe('prompt\n')
  })

  it('renders readable changed-prompt sections', () => {
    expect(formatSystemPromptSnapshot('prompt', ['new\nlines']))
      .toBe('prompt\n\n<!-- request/header change 1 -->\n\nnew\nlines\n')
  })

  it('does not double the newline of a changed prompt', () => {
    expect(formatSystemPromptSnapshot('prompt\n', ['changed\n']))
      .toBe('prompt\n\n<!-- request/header change 1 -->\n\nchanged\n')
  })
})

describe('headerChangeCount', () => {
  it('counts changed request headers, ignoring anchors, blanks, and other lines', () => {
    const change = JSON.stringify({ type: 'request/header', seq: 2, time: 9, data: { reason: 'change' } })
    const anchor = JSON.stringify({ type: 'request/header', seq: 0, time: 9, data: { reason: 'initial' } })
    const other = JSON.stringify({ type: 'turn/start', seq: 1, time: 9, data: {} })
    expect(headerChangeCount(`${anchor}\n${other}\n\n${change}\n${change}\n`)).toBe(2)
    expect(headerChangeCount(`${anchor}\n`)).toBe(0)
  })
})

describe('tool-schema snapshots', () => {
  const snapshot = {
    initial: [{ name: 'read', description: 'Read a file.' }],
    changes: [[{ name: 'grep', description: 'Search files.' }]],
  }

  it('formats and parses canonical structured JSON', () => {
    const formatted = formatToolSchemasSnapshot(snapshot.initial, snapshot.changes)
    expect(formatted).toBe(`${JSON.stringify(snapshot, null, 2)}\n`)
    expect(parseToolSchemasSnapshot(formatted)).toEqual(snapshot)
  })

  it('rejects invalid top-level and field shapes', () => {
    expect(() => parseToolSchemasSnapshot('null')).toThrow(/must be an object/)
    expect(() => parseToolSchemasSnapshot('"invalid"')).toThrow(/must be an object/)
    expect(() => parseToolSchemasSnapshot('[]')).toThrow(/must be an object/)
    expect(() => parseToolSchemasSnapshot('{"initial":{},"changes":[]}')).toThrow(/array-valued/)
    expect(() => parseToolSchemasSnapshot('{"initial":[],"changes":{}}')).toThrow(/array-valued/)
    expect(() => parseToolSchemasSnapshot('{"initial":[],"changes":[{}]}')).toThrow(/array-valued/)
  })

  it('restores initial schemas into the pinned header token', () => {
    expect(restorePinnedToolSchemas({ system: '{{system}}', tools: '{{tools}}' }, snapshot.initial))
      .toEqual({ system: '{{system}}', tools: snapshot.initial })
  })

  it('rejects invalid headers and a missing tool token', () => {
    expect(() => restorePinnedToolSchemas(null, snapshot.initial)).toThrow(/must be an object/)
    expect(() => restorePinnedToolSchemas('invalid', snapshot.initial)).toThrow(/must be an object/)
    expect(() => restorePinnedToolSchemas([], snapshot.initial)).toThrow(/must be an object/)
    expect(() => restorePinnedToolSchemas({ tools: [] }, snapshot.initial)).toThrow(/must equal/)
  })
})

describe('unknownToolCallIds', () => {
  it('returns structured UNKNOWN_TOOL call ids and ignores other results', () => {
    const log = [
      '{"type":"tool/result","data":{"callId":"missing","error":{"code":"UNKNOWN_TOOL"}}}',
      '{"type":"tool/result","data":{"callId":"failed","error":{"code":"EXECUTION_FAILED"}}}',
      '{"type":"tool/result","data":null}',
      '{"type":"tool/result","data":"invalid"}',
      '{"type":"tool/result","data":{"error":null}}',
      '{"type":"tool/result","data":{"error":"invalid"}}',
      '{"type":"assistant/message","data":{"error":{"code":"UNKNOWN_TOOL"}}}',
      '{"type":"tool/result","data":{"error":{"code":"UNKNOWN_TOOL"}}}',
      '',
    ].join('\n')
    expect(unknownToolCallIds(log)).toEqual(['missing', '<missing callId>'])
  })

  it('returns no failures for ordinary tool results', () => {
    expect(unknownToolCallIds('{"type":"tool/result","data":{"callId":"ok"}}\n')).toEqual([])
  })
})

describe('refreshFixtureReplacements', () => {
  it('maps fresh ids and cwd values to the existing fixture values, skipping non-replacements', () => {
    const log = (content: string): HarvestedLog => ({ id: 'diagnostic', createdAt: 1, content })
    const logs = [
      log('{"type":"session","id":"","cwd":"/same"}\n'),
      log('{"type":"session","id":"new-parent","cwd":"/new"}\n'),
      log('{"type":"session","id":"new-child","cwd":"/new"}\n'),
    ]
    const fixtures = [
      '{"type":"session","id":"","cwd":"/same"}\n',
      '{"type":"session","id":"old-parent","cwd":"/old"}\n',
    ]
    expect(refreshFixtureReplacements(logs, fixtures)).toEqual([
      { from: 'new-parent', to: 'old-parent' },
      { from: '/new', to: '/old' },
    ])
  })
})

describe('stabilizeRefreshLog', () => {
  it('keeps volatile fixture fields while preserving fresh meaningful payloads', () => {
    const fresh = [
      '{"type":"session","id":"new-child","createdAt":200,"cwd":"/new","parentSession":"new-parent","seedLength":1}',
      '{"type":"hook/result","seq":1,"time":22,"data":{"decision":"block","durationMs":37}}',
      '{"type":"turn/end","seq":2,"time":33,"data":{"error":"fresh error"}}',
      '{"type":"tool/result","seq":3,"time":44,"data":{"text":"new-parent in /new"}}',
      '{"type":"hook/result","seq":4,"time":55,"data":{"decision":"allow","durationMs":5}}',
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"old-child","createdAt":100,"cwd":"/old","parentSession":"old-parent","seedLength":5}',
      '{"type":"hook/result","seq":1,"time":11,"data":{"decision":"stale","durationMs":99}}',
      '{"type":"turn/end","seq":2,"data":{"error":"stale"}}',
      '{"type":"assistant/message","seq":3,"time":12,"data":{"text":"different type"}}',
      '{"type":"hook/result","seq":4,"time":13,"data":{"decision":"stale"}}',
      '',
    ].join('\n')

    expect(stabilizeRefreshLog(fresh, existing, [
      { from: 'new-parent', to: 'old-parent' },
      { from: 'new-child', to: 'old-child' },
      { from: '/new', to: '/old' },
    ])).toBe([
      '{"type":"session","id":"old-child","createdAt":100,"cwd":"/old","parentSession":"old-parent","seedLength":1}',
      '{"type":"hook/result","seq":1,"time":11,"data":{"decision":"block","durationMs":99}}',
      '{"type":"turn/end","seq":2,"time":33,"data":{"error":"fresh error"}}',
      '{"type":"tool/result","seq":3,"time":44,"data":{"text":"old-parent in /old"}}',
      '{"type":"hook/result","seq":4,"time":13,"data":{"decision":"allow","durationMs":5}}',
      '',
    ].join('\n'))
  })
})
