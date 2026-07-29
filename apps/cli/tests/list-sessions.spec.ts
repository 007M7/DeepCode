/**
 * Tests for the `dsh list-sessions` presentation layer: uptime formatting, row building
 * (newest first, absent-title placeholder) and table alignment without trailing
 * padding. Every displayed field comes from the record, so there is no log
 * reading to cover here.
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BootId, type SessionRegistryRecord } from '@deepseek-ai/dsh-session-registry'
import { buildRows, formatUptime, renderTable } from '../src/list-sessions.ts'

function record(overrides: Partial<SessionRegistryRecord> = {}): SessionRegistryRecord {
  return {
    sessionId: SessionId('sess-1'),
    pid: 4242,
    cwd: '/work/project',
    startedAt: 1_000,
    bootId: BootId('boot-1'),
    ...overrides,
  }
}

describe('formatUptime', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [12_000, '12s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [3_540_000, '59m'],
    [3_600_000, '1h'],
    [8_040_000, '2h14m'],
    [86_400_000, '1d'],
    [90_000_000, '1d1h'],
  ])('renders %ims as %s', (ms, expected) => {
    expect(formatUptime(ms)).toBe(expected)
  })

  it('never renders a negative duration for a clock that moved backwards', () => {
    expect(formatUptime(-5_000)).toBe('0s')
  })
})

describe('buildRows', () => {
  it('orders newest first and marks a missing title', () => {
    const rows = buildRows([
      record({ sessionId: SessionId('older'), startedAt: 1_000 }),
      record({ sessionId: SessionId('newer'), startedAt: 5_000 }),
    ], 65_000)
    expect(rows.map(row => row[0])).toEqual(['newer', 'older'])
    expect(rows[0]).toEqual(['newer', '4242', '1m', '/work/project', '—'])
  })
})

describe('renderTable', () => {
  it('aligns columns and leaves no trailing whitespace', () => {
    const table = renderTable(buildRows([
      record({ sessionId: SessionId('short'), startedAt: 0, title: 'a title' }),
      record({ sessionId: SessionId('a-much-longer-session-id'), startedAt: 1, title: 'a title' }),
    ], 1_000))
    const lines = table.split('\n')
    expect(lines[0]).toMatch(/^SESSION {18}\s+PID/)
    for (const line of lines) expect(line).toBe(line.trimEnd())
    // The header and every row align on the same column starts.
    const pidColumn = (line: string): number => line.includes('4242') ? line.indexOf('4242') : line.indexOf('PID')
    expect(pidColumn(lines[1] ?? '')).toBe(pidColumn(lines[0] ?? ''))
    expect(pidColumn(lines[2] ?? '')).toBe(pidColumn(lines[0] ?? ''))
  })

  it('renders a header even with no rows, so the columns stay discoverable', () => {
    expect(renderTable([])).toBe('SESSION  PID  UPTIME  WORKSPACE  TITLE\n')
  })
})
