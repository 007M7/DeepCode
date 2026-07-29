/** Request-header canonicalization, equality, snapshot folding, and format rejection. */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, canonicalHeader, foldRequestHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const CONFIG = { provider: 'mock', model: 'm' }

function tool(name: string, description = 'd'): ToolSchema {
  return { name, description, parameters: { type: 'object' } }
}

describe('canonicalHeader', () => {
  it('normalizes empty optional fields to absence and preserves populated fields', () => {
    expect(canonicalHeader({ config: CONFIG, system: '', tools: [] })).toEqual({ config: CONFIG })
    const full = canonicalHeader({ config: CONFIG, system: 's', tools: [tool('a')] })
    expect(full).toEqual({ config: CONFIG, system: 's', tools: [tool('a')] })
  })
})

describe('headerEquals', () => {
  const base = canonicalHeader({ config: CONFIG, system: 's', tools: [tool('a')] })

  it('compares every canonical field and preserves tool order', () => {
    expect(headerEquals(base, structuredClone(base))).toBe(true)
    expect(headerEquals(base, { ...base, config: { provider: 'mock', model: 'other' } })).toBe(false)
    expect(headerEquals(base, {
      ...base,
      config: { ...base.config, reasoningEffort: ReasoningEffortId('high') },
    })).toBe(false)
    expect(headerEquals(base, { ...base, system: 'other' })).toBe(false)
    expect(headerEquals(base, { ...base, tools: [] })).toBe(false)
    expect(headerEquals(base, { ...base, tools: [tool('a', 'changed')] })).toBe(false)
    expect(headerEquals({ config: CONFIG, tools: [tool('a'), tool('b')] }, { config: CONFIG, tools: [tool('b'), tool('a')] })).toBe(false)
  })

  it('treats absent and empty tool arrays as equivalent canonical absence', () => {
    expect(headerEquals({ config: CONFIG }, { config: CONFIG, tools: [] })).toBe(true)
  })
})

describe('foldRequestHeader', () => {
  it('returns the supplied baseline when no snapshot follows', () => {
    const from: EpochHeader = { config: CONFIG, system: 'baseline' }
    const unrelated: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    ]
    expect(foldRequestHeader(unrelated)).toBeUndefined()
    expect(foldRequestHeader(unrelated, from)).toBe(from)
  })

  it('takes the latest full snapshot and skips unrelated events', () => {
    const session = new Session(SessionId('fold'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('request/header', { header: { config: CONFIG, system: 'first' }, reason: 'initial' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'other' }, tools: [] }, reason: 'change' })
    expect(foldRequestHeader(session.events)).toEqual({ config: { provider: 'mock', model: 'other' } })
  })
})

describe('legacy request-header format', () => {
  it('rejects request/header-delta in seeds and untyped appends', () => {
    const legacy = [{
      type: 'request/header-delta', seq: 0, time: 1, data: { config: CONFIG },
    }] as unknown as SessionEvent[]
    expect(() => new Session(SessionId('legacy'), legacy)).toThrow(/unsupported legacy request\/header-delta/)

    const session = new Session(SessionId('legacy-append-delta'))
    const appendLegacy = session.append.bind(session) as (type: string, data: unknown) => SessionEvent
    expect(() => appendLegacy('request/header-delta', { config: CONFIG }))
      .toThrow(/unsupported legacy request\/header-delta/)
    expect(session.events).toHaveLength(0)
  })

  it('rejects the removed fallback reason in seeds and untyped appends', () => {
    const legacy = [{
      type: 'request/header', seq: 0, time: 1, data: { header: { config: CONFIG }, reason: 'fallback' },
    }] as unknown as SessionEvent[]
    expect(() => new Session(SessionId('legacy-seed-reason'), legacy))
      .toThrow('unsupported legacy request/header reason "fallback"')

    const session = new Session(SessionId('legacy-append-reason'))
    const appendLegacy = session.append.bind(session) as (type: string, data: unknown) => SessionEvent
    expect(() => appendLegacy('request/header', { header: { config: CONFIG }, reason: 'fallback' }))
      .toThrow('unsupported legacy request/header reason "fallback"')
    expect(session.events).toHaveLength(0)
  })
})
