import { describe, expect, it } from 'vitest'
import {
  type NormalizeContext,
  normalizeSessionLog,
  normalizeStdout,
  scrubRequestHeaders,
  scrubSystemPrompts,
  scrubToolSchemas,
} from '../src/normalize.ts'

/**
 * Unit tests for the pure snapshot normalizers. Live as a *.spec.ts (runs in
 * the default unit gate) and import the normalizers directly.
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
  const header = (over: object) => JSON.stringify({ type: 'session', version: 0, id: 's', createdAt: 123, ...over })
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

  it('scrubs random local spill paths under the snapshot cwd', () => {
    const ev = JSON.stringify({
      type: 'tool/result', seq: 2, time: 5,
      data: {
        content: [{
          type: 'text',
          text: `Full formatted result stored at: ${ctx.cwd}/.spill/session-c22bc3f1d2af/8a7b6c5d4e3f-bash.txt. Use read with offset/limit, or grep this path to search within it.`,
        }],
      },
    })
    const out = normalizeSessionLog(`${header({ cwd: ctx.cwd })}\n${ev}\n`, ctx)
    expect(out).toContain('{{spillLocator:bash.txt}}')
    expect(out).not.toContain('session-c22bc3f1d2af')
    expect(out).not.toContain('8a7b6c5d4e3f')
  })

  it('scrubs macOS /private aliases for local spill paths', () => {
    const ev = JSON.stringify({
      type: 'tool/result', seq: 2, time: 5,
      data: {
        content: [{
          type: 'text',
          text: `Full formatted result stored at: /private${ctx.cwd}/.spill/session-c22bc3f1d2af/8a7b6c5d4e3f-bash.txt. Use read with offset/limit, or grep this path to search within it.`,
        }],
      },
    })
    const out = normalizeSessionLog(`${header({ cwd: ctx.cwd })}\n${ev}\n`, ctx)
    expect(out).toContain('{{spillLocator:bash.txt}}')
    expect(out).not.toContain('/private{{spillLocator')
  })

  it('scrubs fixed snapshot spill paths', () => {
    const ev = JSON.stringify({
      type: 'tool/result', seq: 2, time: 5,
      data: {
        content: [{
          type: 'text',
          text: 'Full formatted result stored at: /tmp/dsh-acp-snapshot-spill/session-c22bc3f1d2af/8a7b6c5d4e3f-bash.txt. Use read with offset/limit, or grep this path to search within it.',
        }],
      },
    })
    const out = normalizeSessionLog(`${header({ cwd: ctx.cwd })}\n${ev}\n`, ctx)
    expect(out).toContain('{{spillLocator:bash.txt}}')
    expect(out).not.toContain('/tmp/dsh-acp-snapshot-spill')
  })

  it('scrubs the session id in the header', () => {
    const out = normalizeSessionLog(`${header({ id: ctx.sessionIds[0] })}\n`, ctx)
    expect(out).toContain('{{sessionId}}')
  })

  it('zeroes a hook/result durationMs (run-to-run noise) but keeps its decision', () => {
    const ev = JSON.stringify({
      type: 'hook/result', seq: 2, time: 5,
      data: { turn: 1, point: 'UserPromptSubmit', handlerId: 'h', decision: 'block', exitCode: 2, durationMs: 37 },
    })
    const out = normalizeSessionLog(`${header({})}\n${ev}\n`, ctx)
    expect(out).toContain('"durationMs":0')
    expect(out).not.toContain('37')
    expect(out).toContain('"decision":"block"') // the decision is the behavior — kept
  })

  it('leaves a non-hook event durationMs untouched (only hook/result is scrubbed)', () => {
    const ev = JSON.stringify({ type: 'tool/result', seq: 2, time: 5, data: { durationMs: 88 } })
    const out = normalizeSessionLog(`${header({})}\n${ev}\n`, ctx)
    expect(out).toContain('"durationMs":88')
  })

  it('tolerates records missing the volatile fields it would zero', () => {
    const bareHeader = JSON.stringify({ type: 'session', id: 's' })
    const timeless = JSON.stringify({ type: 'note', seq: 1 })
    const bareHook = JSON.stringify({ type: 'hook/result', seq: 2, time: 5, data: { decision: 'allow' } })
    const nullDataHook = JSON.stringify({ type: 'hook/result', seq: 3, time: 6, data: null })
    const out = normalizeSessionLog(`${bareHeader}\n${timeless}\n${bareHook}\n${nullDataHook}\n`, ctx)
    expect(out).toContain('"type":"note","seq":1')
    expect(out).toContain('"decision":"allow"')
    expect(out).not.toContain('durationMs')
  })
})

describe('scrubRequestHeaders', () => {
  const headerLine = JSON.stringify({ type: 'session', version: 0, id: 's', createdAt: 1, cwd: '/w' })
  const headerEvent = (header: object) =>
    JSON.stringify({ type: 'request/header', seq: 3, time: 9, data: { header, reason: 'initial' } })

  it('replaces header system and tools with tokens, keeping config and reason', () => {
    const ev = headerEvent({
      config: { model: 'm' },
      system: 'You are an agent.\nBe brief.',
      tools: [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }],
    })
    const out = scrubRequestHeaders(`${headerLine}\n${ev}\n`)
    expect(out).toContain('"system":"{{system}}"')
    expect(out).toContain('"tools":"{{tools}}"')
    expect(out).toContain('"config":{"model":"m"}')
    expect(out).toContain('"reason":"initial"')
    expect(out).not.toContain('You are an agent')
    expect(out).not.toContain('Read a file')
  })

  it('keeps an absent system/tools absent (presence is behavior)', () => {
    const out = scrubRequestHeaders(`${headerLine}\n${headerEvent({ config: { model: 'm' } })}\n`)
    expect(out).not.toContain('{{system}}')
    expect(out).not.toContain('{{tools}}')
  })

  it('scrubs a header carrying only one of system/tools, leaving the other absent', () => {
    const systemOnly = scrubRequestHeaders(`${headerLine}\n${headerEvent({ system: 'secret prompt' })}\n`)
    expect(systemOnly).toContain('"system":"{{system}}"')
    expect(systemOnly).not.toContain('{{tools}}')
    const toolsOnly = scrubRequestHeaders(`${headerLine}\n${headerEvent({ tools: [{ name: 't' }] })}\n`)
    expect(toolsOnly).toContain('"tools":"{{tools}}"')
    expect(toolsOnly).not.toContain('{{system}}')
  })

  it('scrubs the header session prefix to one token per message, keeping the count', () => {
    const ev = headerEvent({
      config: { model: 'm' },
      messagePrefix: [
        { role: 'user', content: [{ type: 'text', text: 'workspace AGENTS digest' }] },
        { role: 'user', content: [{ type: 'text', text: 'skills catalog' }] },
      ],
    })
    const out = scrubRequestHeaders(`${headerLine}\n${ev}\n`)
    expect(out).toContain('"messagePrefix":["{{messagePrefix}}","{{messagePrefix}}"]')
    expect(out).not.toContain('AGENTS digest')
    expect(out).not.toContain('skills catalog')
    // Absence stays absent — a prefix-less header gains no token…
    expect(scrubRequestHeaders(`${headerLine}\n${headerEvent({ system: 's' })}\n`)).not.toContain('{{messagePrefix}}')
    // …and a non-array shape passes through untouched.
    const odd = JSON.stringify({ type: 'request/header', seq: 4, time: 9, data: { header: { config: { model: 'm' }, messagePrefix: 'weird' }, reason: 'initial' } })
    expect(scrubRequestHeaders(`${headerLine}\n${odd}\n`)).toContain('"messagePrefix":"weird"')
  })

  it('leaves malformed headers with no scrubbable payload byte-identical', () => {
    const headerless = JSON.stringify({ type: 'request/header', seq: 10, time: 9, data: { reason: 'initial' } })
    const nullData = JSON.stringify({ type: 'request/header', seq: 11, time: 9, data: null })
    const raw = `${headerLine}\n${headerless}\n${nullData}\n`
    expect(scrubRequestHeaders(raw)).toBe(raw)
  })

  it('passes every other line through byte-for-byte and is idempotent', () => {
    const other = JSON.stringify({ type: 'assistant/chunk', seq: 4, time: 9, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } })
    const raw = `${headerLine}\n${headerEvent({ config: { model: 'm' }, system: 's', tools: [] })}\n${other}\n`
    const once = scrubRequestHeaders(raw)
    expect(once.split('\n')[0]).toBe(headerLine)
    expect(once.split('\n')[2]).toBe(other)
    expect(scrubRequestHeaders(once)).toBe(once)
  })
})

describe('scrubSystemPrompts', () => {
  it('scrubs only system prompt payloads while keeping tools and prefixes verbatim', () => {
    const header = JSON.stringify({
      type: 'request/header', seq: 1, time: 2,
      data: {
        header: {
          system: 'full prompt',
          tools: [{ name: 'read', description: 'full schema' }],
          messagePrefix: [{ role: 'user', content: [{ type: 'text', text: 'full prefix' }] }],
        },
        reason: 'initial',
      },
    })
    const changed = JSON.stringify({
      type: 'request/header', seq: 2, time: 3,
      data: {
        header: {
          system: 'new prompt',
          tools: [{ name: 'read', description: 'changed schema' }],
          messagePrefix: [{ role: 'user', content: [{ type: 'text', text: 'changed prefix' }] }],
        },
        reason: 'change',
      },
    })
    const toolsOnly = JSON.stringify({
      type: 'request/header', seq: 3, time: 4,
      data: { header: { tools: [{ name: 'read', description: 'schema only' }] }, reason: 'resume' },
    })

    const out = scrubSystemPrompts(`${header}\n${changed}\n${toolsOnly}\n`)
    expect(out).toContain('"system":"{{system}}"')
    expect(out).not.toContain('full prompt')
    expect(out).not.toContain('new prompt')
    expect(out).toContain('full schema')
    expect(out).toContain('full prefix')
    expect(out).toContain('changed schema')
    expect(out).toContain('changed prefix')
    expect(out.split('\n')[2]).toBe(toolsOnly)
    expect(scrubSystemPrompts(out)).toBe(out)
  })
})

describe('scrubToolSchemas', () => {
  it('scrubs only tool-schema payloads while keeping prompts and prefixes verbatim', () => {
    const header = JSON.stringify({
      type: 'request/header', seq: 1, time: 2,
      data: {
        header: {
          system: 'full prompt',
          tools: [{ name: 'read', description: 'full schema', parameters: { type: 'object' } }],
          messagePrefix: [{ role: 'user', content: [{ type: 'text', text: 'full prefix' }] }],
        },
        reason: 'initial',
      },
    })
    const changed = JSON.stringify({
      type: 'request/header', seq: 2, time: 3,
      data: {
        header: {
          system: 'new prompt',
          tools: [{ name: 'grep', description: 'new schema' }],
          messagePrefix: [{ role: 'user', content: [{ type: 'text', text: 'changed prefix' }] }],
        },
        reason: 'change',
      },
    })
    const systemOnly = JSON.stringify({
      type: 'request/header', seq: 3, time: 4,
      data: { header: { system: 'prompt only' }, reason: 'resume' },
    })

    const out = scrubToolSchemas(`${header}\n${changed}\n${systemOnly}\n`)
    expect(out.match(/"tools":"{{tools}}"/g)).toHaveLength(2)
    expect(out).not.toContain('full schema')
    expect(out).not.toContain('new schema')
    expect(out).toContain('full prompt')
    expect(out).toContain('new prompt')
    expect(out).toContain('full prefix')
    expect(out).toContain('changed prefix')
    expect(out.split('\n')[2]).toBe(systemOnly)
    expect(scrubToolSchemas(out)).toBe(out)
  })
})
