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

  it('scrubs a header-delta prefix replacement to one token per message', () => {
    const delta = JSON.stringify({
      type: 'request/header-delta', seq: 8, time: 9,
      data: { messagePrefix: [{ role: 'user', content: [{ type: 'text', text: 'leaked opener' }] }] },
    })
    const out = scrubRequestHeaders(`${headerLine}\n${delta}\n`)
    expect(out).toContain('"messagePrefix":["{{messagePrefix}}"]')
    expect(out).not.toContain('leaked opener')
    // The empty-array transition-to-absence stays a structural fact.
    const toNone = JSON.stringify({ type: 'request/header-delta', seq: 9, time: 9, data: { messagePrefix: [] } })
    expect(scrubRequestHeaders(`${headerLine}\n${toNone}\n`)).toContain('"messagePrefix":[]')
  })

  it('leaves a delta with no scrubbable payload byte-identical (config-only, or non-array shapes)', () => {
    const configOnly = JSON.stringify({ type: 'request/header-delta', seq: 8, time: 9, data: { config: { model: 'm2' } } })
    const oddShapes = JSON.stringify({ type: 'request/header-delta', seq: 9, time: 9, data: { system: { insert: 'not-an-array' }, tools: null } })
    const headerless = JSON.stringify({ type: 'request/header', seq: 10, time: 9, data: { reason: 'initial' } })
    const nullData = JSON.stringify({ type: 'request/header', seq: 11, time: 9, data: null })
    const raw = `${headerLine}\n${configOnly}\n${oddShapes}\n${headerless}\n${nullData}\n`
    expect(scrubRequestHeaders(raw)).toBe(raw)
  })

  it('scrubs a one-sided tools delta and passes non-object schema entries through', () => {
    const addedOnly = JSON.stringify({
      type: 'request/header-delta', seq: 8, time: 9,
      data: { tools: { added: [null, 'weird', { name: 'x', description: 'D' }] } },
    })
    const out = scrubRequestHeaders(`${headerLine}\n${addedOnly}\n`)
    // Non-object entries survive untouched; the object entry keeps only name.
    expect(out).toContain('"added":[null,"weird",{"name":"x","description":"{{tools}}"}]')
    const changedOnly = JSON.stringify({
      type: 'request/header-delta', seq: 8, time: 9,
      data: { tools: { changed: [{ name: 'y', parameters: {} }] } },
    })
    expect(scrubRequestHeaders(`${headerLine}\n${changedOnly}\n`))
      .toContain('"changed":[{"name":"y","parameters":"{{tools}}"}]')
  })

  it('scrubs a header-delta system payload but keeps its line positions and arity', () => {
    const delta = JSON.stringify({
      type: 'request/header-delta', seq: 8, time: 9,
      data: { system: { keepStart: 1, keepEnd: 4, insert: ['leaked prompt line', 'second line'] }, config: { model: 'm2' } },
    })
    const out = scrubRequestHeaders(`${headerLine}\n${delta}\n`)
    // One token PER inserted line: the edit's position AND extent survive.
    expect(out).toContain('"insert":["{{system}}","{{system}}"]')
    expect(out).toContain('"keepStart":1')
    expect(out).toContain('"keepEnd":4')
    expect(out).toContain('"config":{"model":"m2"}')
    expect(out).not.toContain('leaked prompt line')
    expect(out).not.toContain('{{tools}}') // no tools delta → none invented
  })

  it('scrubs a header-delta tools payload but keeps the added/removed/changed names', () => {
    const delta = JSON.stringify({
      type: 'request/header-delta', seq: 8, time: 9,
      data: {
        tools: {
          added: [{ name: 'grep', description: 'Search files.', parameters: { type: 'object' } }],
          removed: ['bash_kill'],
          changed: [{ name: 'read', description: 'Read v2.', parameters: { type: 'object' } }],
        },
      },
    })
    const out = scrubRequestHeaders(`${headerLine}\n${delta}\n`)
    // WHICH tools changed is behavior and survives; their bulk does not.
    expect(out).toContain('"added":[{"name":"grep","description":"{{tools}}","parameters":"{{tools}}"}]')
    expect(out).toContain('"removed":["bash_kill"]')
    expect(out).toContain('"changed":[{"name":"read","description":"{{tools}}","parameters":"{{tools}}"}]')
    expect(out).not.toContain('Search files')
    expect(out).not.toContain('Read v2')
  })

  it('passes every other line through byte-for-byte and is idempotent', () => {
    const other = JSON.stringify({ type: 'assistant/chunk', seq: 4, time: 9, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } })
    const delta = JSON.stringify({
      type: 'request/header-delta', seq: 8, time: 9,
      data: { system: { keepStart: 0, keepEnd: 0, insert: ['x'] }, tools: { added: [{ name: 't', description: 'd', parameters: {} }], removed: [], changed: [] } },
    })
    const raw = `${headerLine}\n${headerEvent({ config: { model: 'm' }, system: 's', tools: [] })}\n${delta}\n${other}\n`
    const once = scrubRequestHeaders(raw)
    expect(once.split('\n')[0]).toBe(headerLine)
    expect(once.split('\n')[3]).toBe(other)
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
    const delta = JSON.stringify({
      type: 'request/header-delta', seq: 2, time: 3,
      data: {
        system: { keepStart: 1, keepEnd: 2, insert: ['new prompt line'] },
        tools: { changed: [{ name: 'read', description: 'changed schema' }] },
        messagePrefix: [{ role: 'user', content: [{ type: 'text', text: 'changed prefix' }] }],
      },
    })
    const toolsOnly = JSON.stringify({
      type: 'request/header', seq: 3, time: 4,
      data: { header: { tools: [{ name: 'read', description: 'schema only' }] }, reason: 'resume' },
    })

    const out = scrubSystemPrompts(`${header}\n${delta}\n${toolsOnly}\n`)
    expect(out).toContain('"system":"{{system}}"')
    expect(out).toContain('"insert":["{{system}}"]')
    expect(out).not.toContain('full prompt')
    expect(out).not.toContain('new prompt line')
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
    const delta = JSON.stringify({
      type: 'request/header-delta', seq: 2, time: 3,
      data: {
        system: { keepStart: 1, keepEnd: 2, insert: ['new prompt line'] },
        tools: { added: [{ name: 'grep', description: 'new schema' }], changed: [{ name: 'read', description: 'changed schema' }] },
        messagePrefix: [{ role: 'user', content: [{ type: 'text', text: 'changed prefix' }] }],
      },
    })
    const systemOnly = JSON.stringify({
      type: 'request/header', seq: 3, time: 4,
      data: { header: { system: 'prompt only' }, reason: 'resume' },
    })

    const out = scrubToolSchemas(`${header}\n${delta}\n${systemOnly}\n`)
    expect(out).toContain('"tools":"{{tools}}"')
    expect(out).toContain('"added":[{"name":"grep","description":"{{tools}}"}]')
    expect(out).toContain('"changed":[{"name":"read","description":"{{tools}}"}]')
    expect(out).not.toContain('full schema')
    expect(out).not.toContain('new schema')
    expect(out).not.toContain('changed schema')
    expect(out).toContain('full prompt')
    expect(out).toContain('new prompt line')
    expect(out).toContain('full prefix')
    expect(out).toContain('changed prefix')
    expect(out.split('\n')[2]).toBe(systemOnly)
    expect(scrubToolSchemas(out)).toBe(out)
  })
})
