/**
 * Exercises scheduler ordering and cancellation with deterministic gated tools.
 * ACP goldens own transcript-facing coverage.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmService from '@deepseek-ai/dsh-llm'
import ToolRegistry, { defineTool, type PostToolDecision, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter, maxParallelToolCalls?: number) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, {
    agents: [],
    ...maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls },
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function events(agent: ReactLoopAgent): SessionEvent[] {
  return [...agent.session.events]
}

/** Build one assistant response containing the supplied tool calls. */
function multiCall(calls: { id: string; name: string; args: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: CallId(call.id), name: call.name, arguments: JSON.stringify(call.args) } },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/** A tool whose calls block until the test releases them by callId. */
function gatedTool(name: string, parallel: boolean) {
  const gates = new Map<string, () => void>()
  const started: string[] = []
  const tool = defineTool({
    name,
    description: `gated ${name}`,
    parameters: { id: { type: 'string', required: true } },
    ...parallel ? { isConcurrencySafe: () => true } : {},
    async execute(args) {
      started.push(args.id)
      await new Promise<void>((resolve) => { gates.set(args.id, resolve) })
      return [{ type: 'text', text: `done-${args.id}` }]
    },
  })
  return {
    tool,
    started,
    release(id: string) { gates.get(id)?.(); gates.delete(id) },
    pending() { return [...gates.keys()] },
  }
}

function gatedParallelTool(name: string) {
  return gatedTool(name, true)
}

function gatedExclusiveTool(name: string) {
  return gatedTool(name, false)
}

/** Poll until `predicate` holds, letting microtasks/timers drain between checks. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(r => setTimeout(r, 0))
  if (!predicate()) throw new Error('until: condition never held')
}

describe('tool-call scheduler: grouping and barriers', () => {
  it('runs parallel-safe siblings concurrently (all start before any completes)', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }, { id: 'c3', name: 'p', args: { id: '3' } }]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 3)
    expect(gated.started).toEqual(['1', '2', '3'])
    gated.release('1'); gated.release('2'); gated.release('3')
    await waitForIdle(ctx, agent)
  })

  it('an exclusive call between two parallel-safe calls forms a barrier (3 groups)', async () => {
    const order: string[] = []
    const adapter = new MockAdapter([
      multiCall([
        { id: 'c1', name: 'r', args: { id: 'A1' } },
        { id: 'c2', name: 'w', args: { id: 'A2' } },
        { id: 'c3', name: 'r', args: { id: 'A3' } },
      ]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'r', description: 'read', parameters: { id: { type: 'string', required: true } },
      isConcurrencySafe: () => true,
      async execute(args) { order.push(`r-start-${args.id}`); order.push(`r-end-${args.id}`); return [{ type: 'text', text: 'r' }] },
    }))
    ctx.tools.register(defineTool({
      name: 'w', description: 'write', parameters: { id: { type: 'string', required: true } },
      async execute(args) { order.push(`w-${args.id}`); return [{ type: 'text', text: 'w' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)

    expect(order).toEqual(['r-start-A1', 'r-end-A1', 'w-A2', 'r-start-A3', 'r-end-A3'])
  })

  it('reclassifies pending calls after an exclusive barrier replaces their tool', async () => {
    const adapter = new MockAdapter([
      multiCall([
        { id: 'c1', name: 'replace', args: { id: '0' } },
        { id: 'c2', name: 'x', args: { id: '1' } },
        { id: 'c3', name: 'x', args: { id: '2' } },
      ]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const replacement = gatedExclusiveTool('x')
    const disposeSafe = ctx.tools.register(defineTool({
      name: 'x',
      description: 'initially safe',
      parameters: { id: { type: 'string', required: true } },
      isConcurrencySafe: () => true,
      async execute(args) { return [{ type: 'text', text: `old-${args.id}` }] },
    }))
    ctx.tools.register(defineTool({
      name: 'replace',
      description: 'replace x',
      parameters: { id: { type: 'string', required: true } },
      async execute() {
        disposeSafe()
        ctx.tools.register(replacement.tool)
        return [{ type: 'text', text: 'replaced' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => replacement.started.length === 1)
    await new Promise(r => setTimeout(r, 5))
    expect(replacement.started).toEqual(['1'])
    replacement.release('1')
    await until(() => replacement.started.length === 2)
    expect(replacement.started).toEqual(['1', '2'])
    replacement.release('2')
    await waitForIdle(ctx, agent)
  })

  it('stops replenishing when a result observer makes the next call exclusive', async () => {
    const adapter = new MockAdapter([
      multiCall([
        { id: 'c1', name: 'x', args: { id: '1' } },
        { id: 'c2', name: 'x', args: { id: '2' } },
        { id: 'c3', name: 'x', args: { id: '3' } },
      ]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, 2)
    const initial = gatedParallelTool('x')
    const replacement = gatedExclusiveTool('x')
    const disposeInitial = ctx.tools.register(initial.tool)
    ctx.on('tools/result', (exec) => {
      if (exec.callId !== CallId('c1')) return
      disposeInitial()
      ctx.tools.register(replacement.tool)
    })
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => initial.started.length === 2)
    initial.release('1')
    await until(() => events(agent).some(event =>
      event.type === 'tool/result' && event.data.callId === CallId('c1')))
    await new Promise(r => setTimeout(r, 5))
    expect(replacement.started).toEqual([])
    initial.release('2')
    await until(() => replacement.started.length === 1)
    expect(replacement.started).toEqual(['3'])
    replacement.release('3')
    await waitForIdle(ctx, agent)
  })
})

describe('tool-call scheduler: model-order results despite out-of-order settlement', () => {
  it('commits tool/result in model order even when a later call settles first', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 2)
    gated.release('2')
    await new Promise(r => setTimeout(r, 5))
    const beforeFirst = events(agent).filter(e => e.type === 'tool/result')
    expect(beforeFirst).toEqual([])
    gated.release('1')
    await waitForIdle(ctx, agent)

    const results = events(agent).filter(e => e.type === 'tool/result')
    expect(results.map(e => e.data.callId)).toEqual([CallId('c1'), CallId('c2')])
  })

  it('derived history pairs calls in model order regardless of tool/call log interleaving', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 2)
    gated.release('2'); gated.release('1')
    await waitForIdle(ctx, agent)

    const messages = agent.session.deriveMessages()
    const toolResults = messages.flatMap(m => m.content.filter(b => b.type === 'tool-result'))
    expect(toolResults.map(b => b.toolCallId)).toEqual([CallId('c1'), CallId('c2')])
  })
})

describe('tool-call scheduler: rolling pool honors maxParallelToolCalls', () => {
  it('rejects invalid global maxParallelToolCalls config at plugin load', async () => {
    await expect(harness(new MockAdapter([]), 0)).rejects.toThrow()
    await expect(harness(new MockAdapter([]), 1.5)).rejects.toThrow()
  })

  it('defensively rejects invalid caps when direct construction bypasses the config schema', () => {
    expect(() => new AgentLoop(new Context(), { agents: [], maxParallelToolCalls: 0 }))
      .toThrow('maxParallelToolCalls must be a positive integer')
    expect(() => new AgentLoop(new Context(), { agents: [], maxParallelToolCalls: 1.5 }))
      .toThrow('maxParallelToolCalls must be a positive integer')
  })

  it('defaults the cap when direct construction bypasses the config schema', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)

    expect(() => new AgentLoop(ctx, { agents: [] })).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('starts at most the cap, replenishing as calls settle', async () => {
    const adapter = new MockAdapter([
      multiCall([1, 2, 3, 4].map(n => ({ id: `c${n}`, name: 'p', args: { id: String(n) } }))),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, 2)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 2)
    await new Promise(r => setTimeout(r, 5))
    expect(gated.started).toEqual(['1', '2'])
    gated.release('1')
    await until(() => gated.started.length === 3)
    expect(gated.started).toEqual(['1', '2', '3'])
    expect(events(agent)
      .filter(e => e.type === 'tool/call' || e.type === 'tool/result')
      .map(e => `${e.type}:${String(e.data.callId)}`)
      .slice(0, 4))
      .toEqual(['tool/call:c1', 'tool/call:c2', 'tool/result:c1', 'tool/call:c3'])
    gated.release('2'); gated.release('3')
    await until(() => gated.started.length === 4)
    gated.release('4')
    await waitForIdle(ctx, agent)
    expect(events(agent).filter(e => e.type === 'tool/result').map(e => e.data.callId))
      .toEqual([CallId('c1'), CallId('c2'), CallId('c3'), CallId('c4')])
  })

  it('maxParallelToolCalls: 1 is fully serial (no second start before the first settles)', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, 1)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 1)
    await new Promise(r => setTimeout(r, 5))
    expect(gated.started).toEqual(['1'])
    gated.release('1')
    await until(() => gated.started.length === 2)
    gated.release('2')
    await waitForIdle(ctx, agent)
  })

  it('applies the configured cap to every factory-created agent', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }]),
      textResponse('done'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    ctx.llm.registerAdapter(['mock'], adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 1)
    await new Promise(r => setTimeout(r, 5))
    expect(gated.started).toEqual(['1'])
    gated.release('1')
    await until(() => gated.started.length === 2)
    gated.release('2')
    await waitForIdle(ctx, agent)
  })

})

describe('tool-call scheduler: ordered middleware and additional contexts', () => {
  it('tools/pre-execute and tools/post-execute observe model call order', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }, { id: 'c3', name: 'p', args: { id: '3' } }]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const pre: string[] = []
    const post: string[] = []
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => { pre.push(String(exec.callId)); return next() })
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => { post.push(String(exec.callId)); return next() })
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 3)
    gated.release('3'); gated.release('2'); gated.release('1')
    await waitForIdle(ctx, agent)

    expect(pre).toEqual([CallId('c1'), CallId('c2'), CallId('c3')].map(String))
    expect(post).toEqual([CallId('c1'), CallId('c2'), CallId('c3')].map(String))
  })

  it('injects additional contexts in model call order, not settlement order', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, 2)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    ctx.on('tools/post-execute', async (exec, _result): Promise<PostToolDecision> =>
      ({ kind: 'accept', additionalContexts: [{ content: [{ type: 'text', text: `ctx-${exec.callId}` }], source: { kind: 'plugin', plugin: 'p' } }] }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 2)
    gated.release('2'); gated.release('1')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const contextTexts = log.filter(e => e.type === 'context/message')
      .map(e => (e.data.content[0] as { text: string }).text)
    expect(contextTexts).toEqual(['ctx-c1', 'ctx-c2'])
    const lastResult = log.findLastIndex(e => e.type === 'tool/result')
    const firstContext = log.findIndex(e => e.type === 'context/message')
    expect(lastResult).toBeLessThan(firstContext)
  })

  it('orders pre-execute denials and errors without dispatching them', async () => {
    const adapter = new MockAdapter([
      multiCall([
        { id: 'c1', name: 'p', args: { id: '1' } },
        { id: 'c2', name: 'p', args: { id: '2' } },
        { id: 'c3', name: 'p', args: { id: '3' } },
      ]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const post: string[] = []
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.callId === CallId('c2')) return { kind: 'deny', reason: 'blocked by policy' }
      if (exec.callId === CallId('c3')) throw new Error('pre exploded')
      return next()
    })
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
      post.push(String(exec.callId))
      return next()
    })
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 1)
    gated.release('1')
    await waitForIdle(ctx, agent)

    expect(gated.started).toEqual(['1'])
    expect(post).toEqual(['c1', 'c2'])
    const results = events(agent).filter(e => e.type === 'tool/result')
    expect(results.map(e => e.data.callId)).toEqual([CallId('c1'), CallId('c2'), CallId('c3')])
    expect((results[1]!.data.content[0] as { text: string }).text).toContain('blocked by policy')
    expect((results[2]!.data.content[0] as { text: string }).text).toContain('pre exploded')
  })
})

describe('tool-call scheduler: abort handling', () => {
  it('starts no calls when the signal is already aborted before a parallel group', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }]),
      textResponse('should never be requested'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'assistant/message') {
        ;(agent as unknown as { currentAbort?: AbortController }).currentAbort?.abort('already aborted')
      }
    })

    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)

    expect(gated.started).toEqual([])
    expect(events(agent).filter(e => e.type === 'tool/call')).toEqual([])
    expect(events(agent).filter(e => e.type === 'tool/result')).toEqual([])
  })

  it('stops starting siblings when abort fires during ordered pre-execute', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }]),
      textResponse('should never be requested'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.callId === CallId('c1')) {
        ;(agent as unknown as { currentAbort?: AbortController }).currentAbort?.abort('pre cancelled')
      }
      return next()
    })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 1)
    await new Promise(r => setTimeout(r, 5))
    expect(gated.started).toEqual(['1'])
    gated.release('1')
    await waitForIdle(ctx, agent)

    expect(events(agent).filter(e => e.type === 'tool/call').map(e => e.data.callId))
      .toEqual([CallId('c1')])
    expect(events(agent).filter(e => e.type === 'tool/result').map(e => e.data.callId))
      .toEqual([CallId('c1')])
  })

  it('stops replenishing after abort, commits started results, and drains accepted additional contexts', async () => {
    const adapter = new MockAdapter([
      multiCall([1, 2, 3, 4].map(n => ({ id: `c${n}`, name: 'p', args: { id: String(n) } }))),
      textResponse('should never be requested'),
    ])
    const ctx = await harness(adapter, 2)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => ({
      ...await next(),
      additionalContexts: [{ content: [{ type: 'text', text: `ctx-${exec.callId}` }], source: { kind: 'plugin', plugin: 'p' } }],
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 2)
    ;(agent as unknown as { currentAbort?: AbortController }).currentAbort?.abort('stop now')
    gated.release('1')
    gated.release('2')
    await waitForIdle(ctx, agent)

    expect(gated.started).toEqual(['1', '2'])
    expect(events(agent).filter(e => e.type === 'tool/call').map(e => e.data.callId))
      .toEqual([CallId('c1'), CallId('c2')])
    expect(events(agent).filter(e => e.type === 'tool/result').map(e => e.data.callId))
      .toEqual([CallId('c1'), CallId('c2')])
    const settled = events(agent).filter(e => e.type === 'tool/result' || e.type === 'context/message')
    expect(settled.map(e => e.type))
      .toEqual(['tool/result', 'tool/result', 'context/message', 'context/message'])
    expect(settled.filter(e => e.type === 'context/message')
      .map(e => (e.data.content[0] as { text: string }).text))
      .toEqual(['ctx-c1', 'ctx-c2'])
  })

  it('does not run an exclusive barrier after a parallel group aborts', async () => {
    const adapter = new MockAdapter([
      multiCall([
        { id: 'c1', name: 'p', args: { id: '1' } },
        { id: 'c2', name: 'p', args: { id: '2' } },
        { id: 'c3', name: 'x', args: { id: '3' } },
      ]),
      textResponse('should never be requested'),
    ])
    const ctx = await harness(adapter, 2)
    const gated = gatedParallelTool('p')
    const exclusive: string[] = []
    ctx.tools.register(gated.tool)
    ctx.tools.register(defineTool({
      name: 'x',
      description: 'exclusive',
      parameters: { id: { type: 'string', required: true } },
      async execute(args) { exclusive.push(args.id); return [{ type: 'text', text: 'x' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 2)
    ;(agent as unknown as { currentAbort?: AbortController }).currentAbort?.abort('stop before barrier')
    gated.release('1')
    gated.release('2')
    await waitForIdle(ctx, agent)

    expect(exclusive).toEqual([])
    expect(events(agent).filter(e => e.type === 'tool/call').map(e => e.data.callId))
      .toEqual([CallId('c1'), CallId('c2')])
  })
})
