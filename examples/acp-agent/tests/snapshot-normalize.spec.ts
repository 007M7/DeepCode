import { describe, expect, it } from 'vitest'
import { type NormalizeContext, normalizeSessionLog, normalizeStdout } from '../tests/snapshot-normalize.ts'

/**
 * Unit tests for the pure snapshot normalizers. Live as a *.spec.ts (runs in
 * the default unit gate) and import the harness-side normalizers directly.
 */

const ctx: NormalizeContext = {
  sessionIds: ['11111111-2222-3333-4444-555555555555'],
  cwd: '/tmp/acp-snap-cwd-abc123',
}

describe('normalizeStdout', () => {
  it('rewrites JSON-RPC ids to a stable first-seen sequence', () => {
    const raw = [
      JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'initialize' }),
      JSON.stringify({ jsonrpc: '2.0', id: 42, result: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/new' }),
    ].join('\n')
    const out = normalizeStdout(raw, ctx)
    expect(out).toContain('"id":1')
    expect(out).toContain('"id":2')
    expect(out).not.toContain('42')
    expect(out).not.toContain('99')
  })

  it('scrubs the cwd and session id anywhere they appear', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: ctx.sessionIds[0], cwd: ctx.cwd, note: `at ${ctx.cwd}/x` },
    })
    const out = normalizeStdout(raw, ctx)
    expect(out).toContain('{{sessionId}}')
    expect(out).toContain('{{cwd}}')
    expect(out).not.toContain(ctx.cwd)
    expect(out).not.toContain(ctx.sessionIds[0] as string)
  })

  it('scrubs a stray UUID not in the known list', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } })
    expect(normalizeStdout(raw, ctx)).toContain('{{sessionId}}')
  })

  it('leaves notification frames without an id untouched in id-space', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} })
    const out = normalizeStdout(raw, ctx)
    expect(out).not.toContain('"id"')
  })

  it('throws on a non-JSON stdout line (the purity check)', () => {
    const raw = `${JSON.stringify({ jsonrpc: '2.0', id: 1 })}\noops a log leaked\n`
    expect(() => normalizeStdout(raw, ctx)).toThrow()
  })

  it('ignores blank lines', () => {
    const raw = `\n${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'm' })}\n\n`
    expect(() => normalizeStdout(raw, ctx)).not.toThrow()
  })
})

describe('normalizeSessionLog', () => {
  const header = (over: object) => JSON.stringify({ type: 'session', version: 1, id: 's', createdAt: 123, ...over })
  const event = (over: object) => JSON.stringify({ type: 'turn/start', seq: 1, time: 999, data: { turn: 1 }, ...over })

  it('zeroes the header createdAt', () => {
    const out = normalizeSessionLog(`${header({})}\n`, ctx)
    expect(out).toContain('"createdAt":0')
    expect(out).not.toContain('123')
  })

  it('zeroes each event time but keeps seq', () => {
    const out = normalizeSessionLog(`${header({})}\n${event({ seq: 7, time: 999 })}\n`, ctx)
    expect(out).toContain('"time":0')
    expect(out).toContain('"seq":7') // seq is deterministic — NOT scrubbed
    expect(out).not.toContain('999')
  })

  it('scrubs cwd and session id deep inside event data', () => {
    const ev = JSON.stringify({
      type: 'tool/result', seq: 2, time: 5,
      data: { content: [{ type: 'text', text: `wrote ${ctx.cwd}/proof.txt` }] },
    })
    const out = normalizeSessionLog(`${header({ cwd: ctx.cwd })}\n${ev}\n`, ctx)
    expect(out).toContain('{{cwd}}')
    expect(out).not.toContain(ctx.cwd)
  })

  it('scrubs the session id in the header', () => {
    const out = normalizeSessionLog(`${header({ id: ctx.sessionIds[0] })}\n`, ctx)
    expect(out).toContain('{{sessionId}}')
  })
})
