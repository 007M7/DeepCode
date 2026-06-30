import { describe, expect, it } from 'vitest'
import { parseHookOutput } from '@deepseek-ai/dsh-hook-protocol'

describe('parseHookOutput — exit code semantics', () => {
  it('exit 0 with no stdout is a neutral success', () => {
    const out = parseHookOutput(0, '', '')
    expect(out.exitCode).toBe(0)
    expect(out.decision).toBeUndefined()
    expect(out.continue).toBeUndefined()
  })

  it('exit 2 is a blocking error: stderr becomes the block decision + reason', () => {
    const out = parseHookOutput(2, '', 'this command is not allowed')
    expect(out.decision).toBe('block')
    expect(out.reason).toBe('this command is not allowed')
    expect(out.stderr).toBe('this command is not allowed')
  })

  it('exit 2 with empty stderr still blocks, with no reason', () => {
    const out = parseHookOutput(2, '', '   ')
    expect(out.decision).toBe('block')
    expect(out.reason).toBeUndefined()
  })

  it('other non-zero exit is a non-blocking error (no decision, stderr recorded)', () => {
    const out = parseHookOutput(1, '', 'some warning')
    expect(out.decision).toBeUndefined()
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toBe('some warning')
  })

  it('undefined exit (could not run) carries no decision', () => {
    const out = parseHookOutput(undefined, '', 'spawn failed: ENOENT')
    expect(out.exitCode).toBeUndefined()
    expect(out.decision).toBeUndefined()
    expect(out.stderr).toBe('spawn failed: ENOENT')
  })
})

describe('parseHookOutput — structured stdout (exit 0 only)', () => {
  it('parses top-level continue/stopReason/suppressOutput/systemMessage', () => {
    const out = parseHookOutput(0, JSON.stringify({
      continue: false, stopReason: 'budget exceeded', suppressOutput: true, systemMessage: 'heads up',
    }), '')
    expect(out.continue).toBe(false)
    expect(out.stopReason).toBe('budget exceeded')
    expect(out.suppressOutput).toBe(true)
    expect(out.systemMessage).toBe('heads up')
  })

  it('parses legacy top-level decision + reason (approve/block)', () => {
    expect(parseHookOutput(0, JSON.stringify({ decision: 'block', reason: 'nope' }), '').decision).toBe('block')
    expect(parseHookOutput(0, JSON.stringify({ decision: 'approve' }), '').decision).toBe('approve')
  })

  it('hookSpecificOutput.permissionDecision OVERRIDES the legacy top-level decision', () => {
    const out = parseHookOutput(0, JSON.stringify({
      decision: 'approve',
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'denied by policy' },
    }), '')
    expect(out.decision).toBe('deny')
    expect(out.reason).toBe('denied by policy')
  })

  it('parses allow/ask permissionDecision (the bridge decides whether to honor)', () => {
    expect(parseHookOutput(0, JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }), '').decision).toBe('allow')
    expect(parseHookOutput(0, JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } }), '').decision).toBe('ask')
  })

  it('parses additionalContext and updatedInput from hookSpecificOutput', () => {
    const out = parseHookOutput(0, JSON.stringify({
      hookSpecificOutput: { additionalContext: 'remember X', updatedInput: { command: 'safe' } },
    }), '')
    expect(out.additionalContext).toBe('remember X')
    expect(out.updatedInput).toEqual({ command: 'safe' })
  })

  it('an unknown decision string is ignored (not coerced)', () => {
    expect(parseHookOutput(0, JSON.stringify({ decision: 'maybe' }), '').decision).toBeUndefined()
  })

  it('malformed JSON on a clean exit is lenient (no structured output, no throw)', () => {
    const out = parseHookOutput(0, '{ not valid json', '')
    expect(out.decision).toBeUndefined()
    expect(out.continue).toBeUndefined()
  })

  it('non-object stdout (plain text) on exit 0 is left for the bridge (no JSON attempt)', () => {
    const out = parseHookOutput(0, 'just some text output', '')
    expect(out.decision).toBeUndefined()
    expect(out.continue).toBeUndefined()
  })

  it('a JSON array stdout parses but yields no fields (not an object)', () => {
    // Starts with '{'? No — '[' — so it is not even attempted. Neutral.
    const out = parseHookOutput(0, '[1,2,3]', '')
    expect(out.decision).toBeUndefined()
  })

  it('structured stdout is IGNORED on a blocking (exit 2) run — stderr is authoritative', () => {
    const out = parseHookOutput(2, JSON.stringify({ decision: 'approve' }), 'blocked')
    // exit 2 forces block regardless of what stdout claims
    expect(out.decision).toBe('block')
    expect(out.reason).toBe('blocked')
  })
})
