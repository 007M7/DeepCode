import { cpSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { defineAcpSnapshotSuite, type Scenario } from '../src/index.ts'
import { childFixturePaths, fixtureContext, headerDeltaCount, normalizedHeaders } from '../src/suite.ts'

/**
 * Unit tests for the suite factory, by running it: two synthetic suites over
 * the scripted fake ACP bin (./fixtures/fake-acp-agent.ts) register REAL
 * describe/it trees at collection time, so every factory path — golden and log
 * compares, the per-suite header pin and its uniformity guard, record-mode
 * fixture write-back, skip semantics, and the fixture guard block — executes
 * as an ordinary green test. The pure helpers get direct cases below.
 *
 * The replay suite runs against the committed fixtures in ./fixtures/suite.
 * The record suite runs against a TEMP COPY of ./fixtures/record-suite
 * (record mode writes session fixtures back into its snapshots dir; a run must
 * never touch the committed tree). To re-bootstrap the record tree's goldens
 * after changing the fake bin's output, run this spec once with
 * `ACP_SNAPSHOT_SPEC_BOOTSTRAP=1` (points the record suite at the committed
 * tree so vitest creates/updates the goldens and the write-back lands there),
 * then commit the result.
 */

const AGENT = {
  binScript: fileURLToPath(new URL('./fixtures/fake-acp-agent.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('./fixtures/fake-acp-agent.ts', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
}

const REPLAY_DIR = fileURLToPath(new URL('./fixtures/suite', import.meta.url))
const RECORD_SRC = fileURLToPath(new URL('./fixtures/record-suite', import.meta.url))

// The replay suite doubles as the header-CLASS coverage: every scenario names
// the same explicit class (the record suite exercises the 'default' fallback),
// and plain-turn boots through a per-scenario configPath override (the same
// dummy path the agent default carries — the plumbing, not the composition,
// is what this suite can exercise; the real overlay boot is the acp-agent
// example's code-mode scenarios).
const REPLAY_SCENARIOS: Scenario[] = [
  { name: 'pin-turn', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'main' },
  { name: 'plain-turn', hasModelTurn: true, recorded: true, childSessions: 1, headerClass: 'main', configPath: AGENT.configPath },
  { name: 'no-model', hasModelTurn: false, recorded: false, headerClass: 'main' },
  { name: 'blocked-log', hasModelTurn: false, comparesLog: true, recorded: false, headerClass: 'main' },
  { name: 'authored-error', hasModelTurn: true, recorded: false, overridden: true, headerClass: 'main' },
]

const RECORD_SCENARIOS: Scenario[] = [
  { name: 'rec-pin', hasModelTurn: true, recorded: true, pinsHeader: true },
  { name: 'rec-child', hasModelTurn: true, recorded: true, childSessions: 1 },
  // recorded:false in record mode → registered but skipped (never re-recorded).
  { name: 'rec-skip', hasModelTurn: true, recorded: false, overridden: true },
]

// Record mode mutates its snapshots dir, so run it on a throwaway copy —
// except under the documented bootstrap knob, which regenerates the committed
// fixtures/goldens in place.
const BOOTSTRAP = process.env.ACP_SNAPSHOT_SPEC_BOOTSTRAP === '1'
const recordDir = BOOTSTRAP ? RECORD_SRC : mkdtempSync(join(tmpdir(), 'acp-snap-record-suite-'))
if (!BOOTSTRAP) cpSync(RECORD_SRC, recordDir, { recursive: true })
afterAll(async () => {
  if (!BOOTSTRAP) await rm(recordDir, { recursive: true, force: true })
})

describe('defineAcpSnapshotSuite: replay mode', () => {
  defineAcpSnapshotSuite({ agent: AGENT, snapshotsDir: REPLAY_DIR, scenarios: REPLAY_SCENARIOS, mode: 'replay' })
})

// The record suite's tests run in registration order: rec-pin re-records the
// pinned fixture FIRST, so rec-child's uniformity guard reads the fresh pin.
describe('defineAcpSnapshotSuite: record mode', () => {
  defineAcpSnapshotSuite({ agent: AGENT, snapshotsDir: recordDir, scenarios: RECORD_SCENARIOS, mode: 'record' })
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

describe('childFixturePaths', () => {
  it('yields one sibling path per child, 1-based', () => {
    expect(childFixturePaths('/snap/s', 2)).toEqual(['/snap/s/session.1.jsonl', '/snap/s/session.2.jsonl'])
  })

  it('yields nothing for a single-session scenario', () => {
    expect(childFixturePaths('/snap/s', 0)).toEqual([])
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

describe('headerDeltaCount', () => {
  it('counts request/header-delta events, ignoring blanks and other lines', () => {
    const delta = JSON.stringify({ type: 'request/header-delta', seq: 2, time: 9, data: {} })
    const other = JSON.stringify({ type: 'request/header', seq: 0, time: 9, data: {} })
    expect(headerDeltaCount(`${other}\n\n${delta}\n${delta}\n`)).toBe(2)
    expect(headerDeltaCount(`${other}\n`)).toBe(0)
  })
})
