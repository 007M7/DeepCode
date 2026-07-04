import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendHookInvoked, appendHookResult, type HookOutput } from '@deepseek-ai/dsh-hook-protocol'

/** A {@link HookOutput} with the required stream fields defaulted. */
function output(over: Partial<HookOutput> = {}): HookOutput {
  return { exitCode: 0, stderr: '', stdout: '', ...over }
}

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
    appendHookInvoked(session, { turn: 2, point: 'Stop', dialect: 'codex', handlerId: 'h2' })

    const ev = [...session.events].find(e => e.type === 'hook/invoked')
    if (ev?.type === 'hook/invoked') {
      expect('matcher' in ev.data).toBe(false)
    }
  })

  it('appendHookResult derives decision/exitCode/stderrSummary from the output', () => {
    const session = new Session(SessionId('s'))
    appendHookResult(session, {
      turn: 1, point: 'PreToolUse', handlerId: 'h1',
      output: output({ exitCode: 2, stderr: 'blocked', decision: 'deny' }),
    })
    const full = [...session.events].find(e => e.type === 'hook/result')
    if (full?.type === 'hook/result') {
      expect(full.data).toEqual({ turn: 1, point: 'PreToolUse', handlerId: 'h1', decision: 'deny', exitCode: 2, stderrSummary: 'blocked' })
    }

    // A result with no exit code / no stderr (e.g. a hook that could not run) omits both keys.
    const session2 = new Session(SessionId('s2'))
    appendHookResult(session2, {
      turn: 1, point: 'Stop', handlerId: 'h3',
      output: output({ exitCode: undefined, decision: 'allow' }),
    })
    const sparse = [...session2.events].find(e => e.type === 'hook/result')
    if (sparse?.type === 'hook/result') {
      expect('exitCode' in sparse.data).toBe(false)
      expect('stderrSummary' in sparse.data).toBe(false)
      expect(sparse.data.decision).toBe('allow')
    }
  })

  it('the decision falls back to stop on continue:false, else pass', () => {
    const session = new Session(SessionId('s'))
    appendHookResult(session, { turn: 1, point: 'Stop', handlerId: 'halt', output: output({ continue: false }) })
    appendHookResult(session, { turn: 1, point: 'Stop', handlerId: 'noop', output: output() })
    // An explicit decision wins over the continue:false fallback.
    appendHookResult(session, { turn: 1, point: 'Stop', handlerId: 'both', output: output({ continue: false, decision: 'block' }) })

    const decisions = [...session.events]
      .filter(e => e.type === 'hook/result')
      .map(e => e.type === 'hook/result' ? [e.data.handlerId, e.data.decision] : [])
    expect(decisions).toEqual([['halt', 'stop'], ['noop', 'pass'], ['both', 'block']])
  })

  it('stderrSummary is trimmed and truncated to 500 characters with an ellipsis', () => {
    const session = new Session(SessionId('s'))
    appendHookResult(session, {
      turn: 1, point: 'PreToolUse', handlerId: 'long',
      output: output({ exitCode: 2, stderr: `  ${'x'.repeat(600)}  ` }),
    })
    const ev = [...session.events].find(e => e.type === 'hook/result')
    if (ev?.type === 'hook/result') {
      expect(ev.data.stderrSummary).toBe('x'.repeat(500) + '…')
    }
  })

  it('a 500-character stderr is kept verbatim (the cap is exclusive)', () => {
    const session = new Session(SessionId('s'))
    appendHookResult(session, {
      turn: 1, point: 'PreToolUse', handlerId: 'edge',
      output: output({ exitCode: 2, stderr: 'y'.repeat(500) }),
    })
    const ev = [...session.events].find(e => e.type === 'hook/result')
    if (ev?.type === 'hook/result') {
      expect(ev.data.stderrSummary).toBe('y'.repeat(500))
    }
  })

  it('an invoked/result pair correlates by handlerId', () => {
    const session = new Session(SessionId('s'))
    appendHookInvoked(session, { turn: 1, point: 'PreToolUse', dialect: 'claude', handlerId: 'pair-1' })
    appendHookResult(session, { turn: 1, point: 'PreToolUse', handlerId: 'pair-1', output: output({ decision: 'allow' }) })

    const invoked = [...session.events].find(e => e.type === 'hook/invoked')
    const result = [...session.events].find(e => e.type === 'hook/result')
    expect(invoked?.type === 'hook/invoked' && invoked.data.handlerId).toBe('pair-1')
    expect(result?.type === 'hook/result' && result.data.handlerId).toBe('pair-1')
  })
})
