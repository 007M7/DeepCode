/**
 * Request-header utility tests: canonical form, the system line-diff
 * (prefix/suffix trim), the name-keyed tools delta, config replacement, the
 * round-trip contract (including the reorder case the encoding cannot
 * express), and the log fold. These pin the reconstruction algebra: for every
 * logged delta, apply(prev, delta) === next, and folding a log prefix yields
 * the header its next request was built under.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, applyHeaderDelta, canonicalHeader, diffHeader, foldRequestHeader } from '@deepseek-ai/dsh-session'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const CONFIG = { model: 'm' }

function tool(name: string, description = 'd'): ToolSchema {
  return { name, description, parameters: { type: 'object' } }
}

/** Round-trip helper: diff must reproduce `next` from `prev` exactly. */
function roundTrip(prev: EpochHeader, next: EpochHeader): ReturnType<typeof diffHeader> {
  const delta = diffHeader(prev, next)
  if (delta !== undefined) {
    expect(applyHeaderDelta(prev, delta)).toEqual(canonicalHeader(next))
  }
  return delta
}

describe('canonicalHeader', () => {
  it('normalizes empty system and empty tools to absent fields', () => {
    expect(canonicalHeader({ config: CONFIG, system: '', tools: [] })).toEqual({ config: CONFIG })
    const full = canonicalHeader({ config: CONFIG, system: 's', tools: [tool('a')] })
    expect(full.system).toBe('s')
    expect(full.tools).toHaveLength(1)
  })
})

describe('diffHeader / applyHeaderDelta', () => {
  it('returns undefined for equal headers', () => {
    const header = canonicalHeader({ config: CONFIG, system: 'a\nb', tools: [tool('t')] })
    expect(diffHeader(header, header)).toBeUndefined()
  })

  it('encodes a mid-prompt line change as a prefix/suffix trim', () => {
    const prev = canonicalHeader({ config: CONFIG, system: 'keep1\nold\nkeep2\nkeep3' })
    const next = canonicalHeader({ config: CONFIG, system: 'keep1\nnew A\nnew B\nkeep2\nkeep3' })
    const delta = roundTrip(prev, next)
    expect(delta?.system).toEqual({ keepStart: 1, keepEnd: 2, insert: ['new A', 'new B'] })
    expect(delta?.tools).toBeUndefined()
    expect(delta?.config).toBeUndefined()
  })

  it('degenerates to a full replacement when nothing is shared, and round-trips absence transitions', () => {
    const none = canonicalHeader({ config: CONFIG })
    const some = canonicalHeader({ config: CONFIG, system: 'x\ny' })
    const gained = roundTrip(none, some)
    expect(gained?.system).toEqual({ keepStart: 0, keepEnd: 0, insert: ['x', 'y'] })
    const lost = roundTrip(some, none)
    expect(lost?.system).toEqual({ keepStart: 0, keepEnd: 0, insert: [] })
  })

  it('does not double-count overlapping prefix and suffix (repeated lines)', () => {
    const prev = canonicalHeader({ config: CONFIG, system: 'a\na' })
    const next = canonicalHeader({ config: CONFIG, system: 'a\na\na' })
    roundTrip(prev, next)
  })

  it('encodes tool addition, removal, and in-place schema change by name', () => {
    const prev = canonicalHeader({ config: CONFIG, tools: [tool('keep'), tool('drop'), tool('edit', 'before')] })
    const next = canonicalHeader({ config: CONFIG, tools: [tool('keep'), tool('edit', 'after'), tool('new')] })
    const delta = roundTrip(prev, next)
    expect(delta?.tools?.added.map(t => t.name)).toEqual(['new'])
    expect(delta?.tools?.removed).toEqual(['drop'])
    expect(delta?.tools?.changed.map(t => t.name)).toEqual(['edit'])
  })

  it('round-trips a tool set gained from a tool-less header and lost back to one', () => {
    const none = canonicalHeader({ config: CONFIG })
    const some = canonicalHeader({ config: CONFIG, tools: [tool('t')] })
    const gained = roundTrip(none, some)
    expect(gained?.tools?.added.map(t => t.name)).toEqual(['t'])
    const lost = roundTrip(some, none)
    expect(lost?.tools?.removed).toEqual(['t'])
  })

  it('cannot express a pure reordering — the writer detects it via the round-trip check', () => {
    const prev = canonicalHeader({ config: CONFIG, tools: [tool('a'), tool('b')] })
    const next = canonicalHeader({ config: CONFIG, tools: [tool('b'), tool('a')] })
    const delta = diffHeader(prev, next)
    // A delta IS produced (the lists differ)…
    expect(delta).toBeDefined()
    // …but applying it cannot reproduce the new order — exactly the case the
    // writer's guard turns into a 'fallback' snapshot.
    expect(applyHeaderDelta(prev, delta!)).not.toEqual(next)
  })

  it('replaces the config whole and leaves untouched parts alone', () => {
    const prev = canonicalHeader({ config: { model: 'm' }, system: 's', tools: [tool('t')] })
    const next = canonicalHeader({ config: { model: 'm2', temperature: 0.1 }, system: 's', tools: [tool('t')] })
    const delta = roundTrip(prev, next)
    expect(delta).toEqual({ config: { model: 'm2', temperature: 0.1 } })
  })
})

describe('foldRequestHeader', () => {
  function headerEvents(session: Session): readonly SessionEvent[] {
    return session.events
  }

  it('returns undefined on a log with no header events', () => {
    const session = new Session(SessionId('fold-none'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(foldRequestHeader(headerEvents(session))).toBeUndefined()
  })

  it('folds snapshot then deltas into the header in force, skipping unrelated events', () => {
    const session = new Session(SessionId('fold'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const first = canonicalHeader({ config: { model: 'm' }, system: 'a\nb', tools: [tool('t')] })
    session.append('request/header', { header: first, reason: 'initial' })
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })

    const second = canonicalHeader({ config: { model: 'm' }, system: 'a\nc', tools: [tool('t')] })
    session.append('request/header-delta', diffHeader(first, second)!)
    expect(foldRequestHeader(headerEvents(session))).toEqual(second)

    // A later snapshot replaces the state wholesale (the 'resume'/'fallback' anchor).
    const third = canonicalHeader({ config: { model: 'other' } })
    session.append('request/header', { header: third, reason: 'resume' })
    expect(foldRequestHeader(headerEvents(session))).toEqual(third)
  })

  it('throws on a delta before any snapshot (corrupt log)', () => {
    const session = new Session(SessionId('fold-corrupt'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('request/header-delta', { config: { model: 'x' } })
    expect(() => foldRequestHeader(headerEvents(session))).toThrow(/before any request\/header snapshot/)
  })
})
