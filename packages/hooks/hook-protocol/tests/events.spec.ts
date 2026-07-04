import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendHookInvoked, appendHookResult, summarizeStderr } from '@deepseek-ai/dsh-hook-protocol'

describe('hook/* session events', () => {
  it('appendHookInvoked records a log-only hook/invoked (with matcher when present)', () => {
    const session = new Session(SessionId('s'))
    appendHookInvoked(session, { turn: 1, point: 'PreToolUse', dialect: 'claude', handlerId: 'h1', matcher: 'Bash' })

    const ev = [...session.events].find(e => e.type === 'hook/invoked')
    expect(ev?.type).toBe('hook/invoked')
    if (ev?.type === 'hook/invoked') {
      expect(ev.data).toMatchObject({ turn: 1, point: 'PreToolUse', dialect: 'claude', handlerId: 'h1', matcher: 'Bash' })
    }
    // Log-only: no surfaceOp on the event.
    expect((ev as unknown as { surfaceOp?: unknown }).surfaceOp).toBeUndefined()
  })

  it('omits matcher when absent (match-all hook)', () => {
    const session = new Session(SessionId('s'))
    appendHookInvoked(session, { turn: 2, point: 'Stop', dialect: 'native', handlerId: 'h2' })

    const ev = [...session.events].find(e => e.type === 'hook/invoked')
    if (ev?.type === 'hook/invoked') {
      expect('matcher' in ev.data).toBe(false)
    }
  })

  it('appendHookResult records the decided outcome, omitting absent optionals', () => {
    const session = new Session(SessionId('s'))
    appendHookResult(session, {
      turn: 1, point: 'PreToolUse', handlerId: 'h1', decision: 'deny',
      exitCode: 2, stderrSummary: 'blocked', durationMs: 12,
    })
    const full = [...session.events].find(e => e.type === 'hook/result')
    if (full?.type === 'hook/result') {
      expect(full.data).toMatchObject({ turn: 1, point: 'PreToolUse', handlerId: 'h1', decision: 'deny', exitCode: 2, stderrSummary: 'blocked', durationMs: 12 })
    }

    // A result with no exit code / no stderr (e.g. a hook that could not run) omits both keys.
    const session2 = new Session(SessionId('s2'))
    appendHookResult(session2, { turn: 1, point: 'Stop', handlerId: 'h3', decision: 'allow', durationMs: 3 })
    const sparse = [...session2.events].find(e => e.type === 'hook/result')
    if (sparse?.type === 'hook/result') {
      expect('exitCode' in sparse.data).toBe(false)
      expect('stderrSummary' in sparse.data).toBe(false)
      expect(sparse.data.durationMs).toBe(3)
    }
  })

  it('an invoked/result pair correlates by handlerId', () => {
    const session = new Session(SessionId('s'))
    appendHookInvoked(session, { turn: 1, point: 'PreToolUse', dialect: 'claude', handlerId: 'pair-1' })
    appendHookResult(session, { turn: 1, point: 'PreToolUse', handlerId: 'pair-1', decision: 'allow', exitCode: 0, durationMs: 7 })

    const invoked = [...session.events].find(e => e.type === 'hook/invoked')
    const result = [...session.events].find(e => e.type === 'hook/result')
    expect(invoked?.type === 'hook/invoked' && invoked.data.handlerId).toBe('pair-1')
    expect(result?.type === 'hook/result' && result.data.handlerId).toBe('pair-1')
  })
})

describe('summarizeStderr', () => {
  it('returns undefined for empty/whitespace stderr', () => {
    expect(summarizeStderr('', 500)).toBeUndefined()
    expect(summarizeStderr('  \n\t ', 500)).toBeUndefined()
  })

  it('passes through a summary at or under the cap, trimmed', () => {
    expect(summarizeStderr('  blocked: bad tool  ', 500)).toBe('blocked: bad tool')
    expect(summarizeStderr('abc', 3)).toBe('abc')
  })

  it('truncates past the cap with an ellipsis', () => {
    expect(summarizeStderr('abcdef', 4)).toBe('abcd…')
    expect(summarizeStderr('x'.repeat(600), 500)).toBe('x'.repeat(500) + '…')
  })
})
