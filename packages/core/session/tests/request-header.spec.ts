/** Request-header canonicalization, equality, snapshot folding, and format rejection. */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, canonicalHeader, foldRequestHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'

const CONFIG = { model: 'm' }

function tool(name: string, description = 'd'): ToolSchema {
  return { name, description, parameters: { type: 'object' } }
}

function msg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

describe('canonicalHeader', () => {
  it('normalizes empty optional fields to absence and preserves populated fields', () => {
    expect(canonicalHeader({ config: CONFIG, system: '', tools: [], messagePrefix: [] })).toEqual({ config: CONFIG })
    const full = canonicalHeader({ config: CONFIG, system: 's', tools: [tool('a')], messagePrefix: [msg('p')] })
    expect(full).toEqual({ config: CONFIG, system: 's', tools: [tool('a')], messagePrefix: [msg('p')] })
  })
})

describe('headerEquals', () => {
  const base = canonicalHeader({ config: CONFIG, system: 's', tools: [tool('a')], messagePrefix: [msg('p')] })

  it('compares every canonical field and preserves tool order', () => {
    expect(headerEquals(base, structuredClone(base))).toBe(true)
    expect(headerEquals(base, { ...base, config: { model: 'other' } })).toBe(false)
    expect(headerEquals(base, { ...base, system: 'other' })).toBe(false)
    expect(headerEquals(base, { ...base, messagePrefix: [msg('other')] })).toBe(false)
    expect(headerEquals(base, { ...base, tools: [] })).toBe(false)
    expect(headerEquals(base, { ...base, tools: [tool('a', 'changed')] })).toBe(false)
    expect(headerEquals({ config: CONFIG, tools: [tool('a'), tool('b')] }, { config: CONFIG, tools: [tool('b'), tool('a')] })).toBe(false)
  })

  it('treats absent and empty prefix/tool arrays as equivalent canonical absence', () => {
    expect(headerEquals({ config: CONFIG }, { config: CONFIG, tools: [], messagePrefix: [] })).toBe(true)
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
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { model: 'other' }, tools: [] }, reason: 'change' })
    expect(foldRequestHeader(session.events)).toEqual({ config: { model: 'other' } })
  })
})

describe('legacy request-header format', () => {
  it('rejects a v0 seed containing request/header-delta', () => {
    const legacy = [{
      type: 'request/header-delta', seq: 0, time: 1, data: { config: CONFIG },
    }] as unknown as SessionEvent[]
    expect(() => new Session(SessionId('legacy'), legacy)).toThrow(/unsupported legacy request\/header-delta/)
  })
})
