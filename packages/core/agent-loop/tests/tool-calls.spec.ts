/**
 * The per-step tool-call scheduler (`tool-calls.ts`): grouping by
 * `ctx.tools.executionMode`, the rolling pool for parallel groups, model-order
 * `tool/result` commit despite out-of-order settlement, interleaved `tool/call`
 * audit records, ordered `tools/pre-execute`/`tools/post-execute`,
 * model-ordered `additionalContext`, and abort behavior.
 *
 * Tools are mocked and deterministic — no real API, no snapshot here (the
 * transcript-facing live-order behavior is pinned by the ACP snapshot goldens).
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmService from '@deepseek-ai/dsh-llm'
import ToolRegistry, { defineTool, type PostToolDecision, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
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

/** An assistant message with N tool-call blocks named `name` (ids c1..cN, arg = index). */
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

/** A parallel-safe tool whose calls block until the test releases them by callId. */
function gatedParallelTool(name: string) {
  const gates = new Map<string, () => void>()
  const started: string[] = []
  const tool = defineTool({
    name,
    description: `gated ${name}`,
    parameters: { id: { type: 'string', required: true } },
    isConcurrencySafe: () => true,
    async execute(args) {
      started.push(args.id)
      await new Promise<void>((resolve) => { gates.set(args.id, resolve) })
      return [{ type: 'text', text: `done-${args.id}` }]
    },
  })
  return {
    tool,
    started,
    /** Release one in-flight call by its arg id (its `execute` resolves). */
    release(id: string) { gates.get(id)?.(); gates.delete(id) },
    pending() { return [...gates.keys()] },
  }
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    // All three start before any is released — proof of concurrency.
    await until(() => gated.started.length === 3)
    expect(gated.started).toEqual(['1', '2', '3'])
    gated.release('1'); gated.release('2'); gated.release('3')
    await waitForIdle(ctx, agent)
  })

  it('an exclusive call between two parallel-safe calls forms a barrier (3 groups)', async () => {
    // read A (safe), write A (exclusive), read A (safe) → the write must not
    // overlap either read. The exclusive tool records whether a read was still
    // in flight when it ran.
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)

    // The write ran strictly between the two reads (barrier ordering).
    expect(order).toEqual(['r-start-A1', 'r-end-A1', 'w-A2', 'r-start-A3', 'r-end-A3'])
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 2)
    // Release the SECOND call first; its result must NOT be committed until the
    // first commits (the commit cursor holds it in a slot).
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 2)
    gated.release('2'); gated.release('1')
    await waitForIdle(ctx, agent)

    // deriveMessages pairs the assistant tool-call blocks with tool-result
    // blocks by callId — model order, independent of log interleaving.
    const messages = agent.session.deriveMessages()
    const toolResults = messages.flatMap(m => m.content.filter(b => b.type === 'tool-result'))
    expect(toolResults.map(b => b.toolCallId)).toEqual([CallId('c1'), CallId('c2')])
  })
})

describe('tool-call scheduler: rolling pool honors maxParallelToolCalls', () => {
  it('rejects invalid programmatic maxParallelToolCalls values before creating agents', async () => {
    const ctx = await harness(new MockAdapter([]))

    expect(() => ctx.agentLoop.create(AgentId('bad-zero'), { model: 'mock', maxParallelToolCalls: 0 }))
      .toThrow('maxParallelToolCalls must be a positive integer')
    await expect(ctx.agents.create({
      agentId: AgentId('bad-fractional'),
      sessionId: SessionId('bad-fractional-session'),
      agentOptions: { model: 'mock', maxParallelToolCalls: 1.5 },
    })).rejects.toThrow('maxParallelToolCalls must be a positive integer')
  })

  it('fails loud if maxParallelToolCalls is mutated invalid after agent creation', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }]),
      textResponse('must not run after unanswered tool calls'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock', maxParallelToolCalls: 2 })
    ;(agent.options as { maxParallelToolCalls: number }).maxParallelToolCalls = 0

    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)

    expect(gated.started).toEqual([])
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(e => e.type === 'assistant/message')).toBe(false)
    expect(events(agent).filter(e => e.type === 'tool/call' || e.type === 'tool/result')).toEqual([])
    const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind).toBe('error')
  })

  it('starts at most the cap, replenishing as calls settle', async () => {
    const adapter = new MockAdapter([
      multiCall([1, 2, 3, 4].map(n => ({ id: `c${n}`, name: 'p', args: { id: String(n) } }))),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock', maxParallelToolCalls: 2 })

    agent.send([{ type: 'text', text: 'go' }])
    // Only 2 start initially (the cap).
    await until(() => gated.started.length === 2)
    await new Promise(r => setTimeout(r, 5))
    expect(gated.started).toEqual(['1', '2'])
    // Releasing one starts the next in model order.
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
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock', maxParallelToolCalls: 1 })
    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 1)
    await new Promise(r => setTimeout(r, 5))
    expect(gated.started).toEqual(['1'])
    gated.release('1')
    await until(() => gated.started.length === 2)
    gated.release('2')
    await waitForIdle(ctx, agent)
  })

  it('applies the factory-wide Config default to agents that set no per-agent cap', async () => {
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
    // Factory default of 1 (no per-agent cap set below) must serialize.
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    ctx.llm.registerAdapter(['mock'], adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    expect(agent.options.maxParallelToolCalls).toBe(1)

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 1)
    await new Promise(r => setTimeout(r, 5))
    expect(gated.started).toEqual(['1'])
    gated.release('1')
    await until(() => gated.started.length === 2)
    gated.release('2')
    await waitForIdle(ctx, agent)
  })

  it('lets a per-agent cap override the factory-wide Config default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock', maxParallelToolCalls: 4 })
    expect(agent.options.maxParallelToolCalls).toBe(4)
  })
})

describe('tool-call scheduler: ordered middleware and additionalContext', () => {
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 3)
    // Settle in reverse; post-execute (ordered by the commit cursor) still fires
    // in model order because post runs on the commit path, not on dispatch.
    gated.release('3'); gated.release('2'); gated.release('1')
    await waitForIdle(ctx, agent)

    expect(pre).toEqual([CallId('c1'), CallId('c2'), CallId('c3')].map(String))
    expect(post).toEqual([CallId('c1'), CallId('c2'), CallId('c3')].map(String))
  })

  it('injects additionalContext in model call order, not settlement order', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'p', args: { id: '1' } }, { id: 'c2', name: 'p', args: { id: '2' } }]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    ctx.on('tools/post-execute', async (exec, _result): Promise<PostToolDecision> =>
      ({ kind: 'accept', additionalContext: { content: [{ type: 'text', text: `ctx-${exec.callId}` }], source: { kind: 'plugin', plugin: 'p' } } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    agent.send([{ type: 'text', text: 'go' }])
    await until(() => gated.started.length === 2)
    gated.release('2'); gated.release('1')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    // Both tool/results precede both context/messages, and context is model-ordered.
    const contextTexts = log.filter(e => e.type === 'context/message')
      .map(e => (e.data.content[0] as { text: string }).text)
    expect(contextTexts).toEqual(['ctx-c1', 'ctx-c2'])
    const lastResult = log.findLastIndex(e => e.type === 'tool/result')
    const firstContext = log.findIndex(e => e.type === 'context/message')
    expect(lastResult).toBeLessThan(firstContext)
  })

  it('keeps pre-produced deny/error results ordered without dispatching those calls', async () => {
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
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
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
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

  it('stops replenishing after abort, commits started results, and drops buffered additionalContext', async () => {
    const adapter = new MockAdapter([
      multiCall([1, 2, 3, 4].map(n => ({ id: `c${n}`, name: 'p', args: { id: String(n) } }))),
      textResponse('should never be requested'),
    ])
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    ctx.tools.register(gated.tool)
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => ({
      ...await next(),
      additionalContext: { content: [{ type: 'text', text: `ctx-${exec.callId}` }], source: { kind: 'plugin', plugin: 'p' } },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock', maxParallelToolCalls: 2 })

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
    expect(events(agent).filter(e => e.type === 'context/message')).toEqual([])
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
    const ctx = await harness(adapter)
    const gated = gatedParallelTool('p')
    const exclusive: string[] = []
    ctx.tools.register(gated.tool)
    ctx.tools.register(defineTool({
      name: 'x',
      description: 'exclusive',
      parameters: { id: { type: 'string', required: true } },
      async execute(args) { exclusive.push(args.id); return [{ type: 'text', text: 'x' }] },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock', maxParallelToolCalls: 2 })

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
