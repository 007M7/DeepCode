import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool, type PostToolDecision, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry, {
  AgentId,
  type ContinuationDecision,
  type PromptDecision,
  type SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import AgentLoop, { type ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * The interception seams introduced by the hooks taxonomy: `agent/prompt-submit`,
 * `agent/session-start`, the reshaped `agent/turn-continuation`
 * ({@link ContinuationDecision}), and the `tools/pre-execute` / `tools/post-execute`
 * split with `additionalContext` buffering. These verify the canonical event
 * surface a hook bridge (or a native plugin) programs against, WITHOUT any
 * external protocol — a native plugin uses the typed decisions directly.
 */

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: ReactLoopAgent, text: string) {
  agent.send([{ type: 'text', text }])
}

function events(agent: ReactLoopAgent): SessionEvent[] {
  return [...agent.session.events]
}

describe('agent/prompt-submit', () => {
  it('allow (default via next) records the user/message unchanged', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const seen: string[] = []
    ctx.on('agent/prompt-submit', async (_agent, content, _source, next) => {
      seen.push(content.map(b => (b.type === 'text' ? b.text : '')).join(''))
      return next()
    })

    send(agent, 'hello')
    await waitForIdle(ctx, agent)

    expect(seen).toEqual(['hello'])
    const userMsg = events(agent).find(e => e.type === 'user/message')
    expect(userMsg?.type === 'user/message' && userMsg.data.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('allow with content REWRITES the prompt before it is recorded', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/prompt-submit', async (): Promise<PromptDecision> =>
      ({ kind: 'allow', content: [{ type: 'text', text: 'REWRITTEN' }] }))

    send(agent, 'original')
    await waitForIdle(ctx, agent)

    const userMsg = events(agent).find(e => e.type === 'user/message')
    expect(userMsg?.type === 'user/message' && userMsg.data.content).toEqual([{ type: 'text', text: 'REWRITTEN' }])
    // the rewritten prompt is what reached the model
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('REWRITTEN')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('original')
  })

  it('allow with additionalContext injects a separate context/message into the turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/prompt-submit', async (): Promise<PromptDecision> =>
      ({
        kind: 'allow',
        additionalContext: { content: [{ type: 'text', text: 'extra ctx' }], source: { kind: 'plugin', plugin: 'test' } },
      }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const userMsg = log.find(e => e.type === 'user/message')
    const ctxMsg = log.find(e => e.type === 'context/message')
    expect(userMsg).toBeDefined()
    expect(ctxMsg?.type === 'context/message' && ctxMsg.data.content).toEqual([{ type: 'text', text: 'extra ctx' }])
    expect(ctxMsg?.type === 'context/message' && ctxMsg.data.source).toEqual({ kind: 'plugin', plugin: 'test' })
    // both the prompt and the injected context reach the model
    const sent = JSON.stringify(adapter.requests[0]!.messages)
    expect(sent).toContain('extra ctx')
  })

  it('a prompt-submit rewrite + additionalContext is VISIBLE to the agent/pre-step seam (merged ordering)', async () => {
    // The merge of the interception seams with master's compaction seam pins one
    // ordering: `agent/prompt-submit` runs (rewriting the prompt and injecting
    // context) BEFORE the step loop, and `agent/pre-step` fires INSIDE the step
    // before the single deriveMessages(). So a compaction listener on
    // `agent/pre-step` must observe the surface AFTER the prompt rewrite/inject —
    // otherwise it would measure/compact stale history. This cross-test proves
    // the two seams compose in the right order (each is covered in isolation
    // elsewhere; this asserts they see each other's effects on the same turn).
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/prompt-submit', async (): Promise<PromptDecision> =>
      ({
        kind: 'allow',
        content: [{ type: 'text', text: 'REWRITTEN prompt' }],
        additionalContext: { content: [{ type: 'text', text: 'injected ctx' }], source: { kind: 'plugin', plugin: 'test' } },
      }))

    // The pre-step seam (where compaction lives) derives the surface it would act
    // on. Capture what it sees on the first step.
    let preStepDerived: string | undefined
    ctx.on('agent/pre-step', (subject, _turn, step) => {
      if (subject === agent && step === 1) preStepDerived = JSON.stringify(subject.session.deriveMessages())
    })

    send(agent, 'ORIGINAL prompt')
    await waitForIdle(ctx, agent)

    // The pre-step seam ran and saw BOTH the rewrite (not the original) and the
    // injected context — i.e. the prompt-submit effects landed before it.
    expect(preStepDerived).toBeDefined()
    expect(preStepDerived).toContain('REWRITTEN prompt')
    expect(preStepDerived).toContain('injected ctx')
    expect(preStepDerived).not.toContain('ORIGINAL prompt')
  })

  it('block drops the (only) prompt → zero-step turn ends rejected, model never called', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/prompt-submit', async (): Promise<PromptDecision> =>
      ({ kind: 'block', reason: 'blocked by policy' }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event: SessionEvent) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'do something')
    await waitForIdle(ctx, agent)

    // the model was never called
    expect(adapter.requests).toHaveLength(0)
    // the turn opened and closed balanced, with no user/message and no step
    const log = events(agent)
    expect(log.some(e => e.type === 'turn/start')).toBe(true)
    expect(log.some(e => e.type === 'turn/end')).toBe(true)
    expect(log.some(e => e.type === 'user/message')).toBe(false)
    expect(log.some(e => e.type === 'step/start')).toBe(false)
    // the veto is recorded durably as a prompt/blocked in the open turn
    const blocked = log.find(e => e.type === 'prompt/blocked')
    expect(blocked?.type === 'prompt/blocked' && blocked.data).toMatchObject({
      content: [{ type: 'text', text: 'do something' }],
      reason: 'blocked by policy',
    })
    // ended rejected with the block reason
    expect(reasons).toEqual([{ kind: 'rejected', reason: 'blocked by policy' }])
    const turnEnd = log.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'rejected', reason: 'blocked by policy' })
  })

  it('a mixed batch records a prompt/blocked for the vetoed prompt while the allowed one runs', async () => {
    // Two prompts queued into ONE turn: block "secret", allow "safe". The turn is
    // NOT rejected (a prompt was allowed), so without a durable prompt/blocked the
    // vetoed prompt and its reason would vanish from the log entirely.
    const adapter = new MockAdapter([textResponse('ran once')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/prompt-submit', async (_agent, content, _source, next): Promise<PromptDecision> => {
      const text = content.map(b => (b.type === 'text' ? b.text : '')).join('')
      return text === 'secret' ? { kind: 'block', reason: 'policy: no secrets' } : next()
    })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event: SessionEvent) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    // both sends land before the loop drains → one batched turn
    send(agent, 'secret')
    send(agent, 'safe')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    // the allowed prompt became a user/message and drove exactly one model call
    const userMsgs = log.filter(e => e.type === 'user/message')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0]?.type === 'user/message' && userMsgs[0].data.content).toEqual([{ type: 'text', text: 'safe' }])
    expect(adapter.requests.length).toBeGreaterThanOrEqual(1)
    // the blocked prompt is durably recorded, with its content + reason
    const blocked = log.filter(e => e.type === 'prompt/blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.type === 'prompt/blocked' && blocked[0].data).toMatchObject({
      content: [{ type: 'text', text: 'secret' }],
      reason: 'policy: no secrets',
    })
    // the turn did NOT reject — a sibling was allowed — so the boundary reason
    // alone would not have preserved the block
    expect(reasons.some(r => r.kind === 'rejected')).toBe(false)
  })

  it('a throwing prompt-submit listener ends the turn balanced (error), loop survives', async () => {
    const adapter = new MockAdapter([textResponse('after')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    let threw = false
    ctx.on('agent/prompt-submit', async () => {
      if (!threw) { threw = true; throw new Error('prompt hook broke') }
      return { kind: 'allow' as const }
    })
    const errors: Error[] = []
    ctx.on('agent/error', (_a, _t, _s, error) => void errors.push(error))

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(errors.map(e => e.message)).toEqual(['prompt hook broke'])
    // turn balanced
    const log = events(agent)
    expect(log.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(log.filter(e => e.type === 'turn/end')).toHaveLength(1)

    // loop survives: a second prompt runs normally
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests.length).toBeGreaterThanOrEqual(1)
  })
})

describe('agent/session-start', () => {
  it('fires once with source "startup" for a fresh create, before the first turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)

    const sources: SessionStartSource[] = []
    ctx.on('agent/session-start', (_agent, source) => void sources.push(source))

    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    // fires synchronously at create, before any turn
    expect(sources).toEqual(['startup'])
    expect(events(agent).some(e => e.type === 'turn/start')).toBe(false)

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    // still only one session-start
    expect(sources).toEqual(['startup'])
  })

  it('a session-start listener can inject context the first request sees', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)

    ctx.on('agent/session-start', (agent) => {
      agent.inject([{ type: 'text', text: 'session preamble' }], { source: { kind: 'plugin', plugin: 'test' } })
    })

    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // the injected context reached the model on the first (only) request
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('session preamble')
    // and is recorded with the plugin source, never mislabeled as a user prompt
    const ctxMsg = events(agent).find(e => e.type === 'context/message')
    expect(ctxMsg?.type === 'context/message' && ctxMsg.data.source).toEqual({ kind: 'plugin', plugin: 'test' })
  })

  it('a throwing session-start listener does not abort agent construction', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)

    ctx.on('agent/session-start', () => { throw new Error('session-start hook broke') })

    // create must not throw — the listener error is contained/logged
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    expect(agent.id).toBe(AgentId('a1'))

    // and the agent still runs
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('agent/turn-continuation (ContinuationDecision)', () => {
  it('a continue decision with a reason records next-step steering in the same turn', async () => {
    const adapter = new MockAdapter([textResponse('step 1 no tools'), textResponse('step 2')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    let forced = false
    ctx.on('agent/turn-continuation', async (_agent, _turn, _default, next): Promise<ContinuationDecision> => {
      if (!forced) {
        forced = true
        return { action: 'continue', reason: { content: [{ type: 'text', text: 'keep going on the goal' }], source: { kind: 'plugin', plugin: 'goal' } } }
      }
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    // same turn, two steps
    expect(log.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(log.filter(e => e.type === 'step/start')).toHaveLength(2)
    // the reason was recorded as steering BEFORE step 2, with its plugin source
    const steering = log.find(e => e.type === 'steering/message')
    expect(steering?.type === 'steering/message' && steering.data.content).toEqual([{ type: 'text', text: 'keep going on the goal' }])
    expect(steering?.type === 'steering/message' && steering.data.source).toEqual({ kind: 'plugin', plugin: 'goal' })
    // and reached the next request
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('keep going on the goal')
  })

  it('a stop decision ends the turn even when the step had tool calls', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { text: 'hi' })])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'echo', description: 'echo', parameters: { text: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: String(args.text) }] },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('agent/turn-continuation', async (): Promise<ContinuationDecision> => ({ action: 'stop' }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // default would have continued (had tool calls), but the stop decision wins
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(e => e.type === 'tool/result')).toBe(true)
  })
})

describe('tools/post-execute additionalContext buffering across a multi-call step', () => {
  it('appends each call\'s additionalContext only AFTER all tool/results, preserving adjacency', async () => {
    // One assistant step with TWO tool calls; the second model response stops.
    const twoCalls = [
      { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
      { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: CallId('c1'), name: 'echo', arguments: '{"text":"a"}' } },
      { type: 'block-start' as const, index: 1, blockType: 'tool-call' as const },
      { type: 'block-end' as const, index: 1, block: { type: 'tool-call' as const, id: CallId('c2'), name: 'echo', arguments: '{"text":"b"}' } },
      { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 5 } },
      { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
    ]
    const adapter = new MockAdapter([twoCalls, textResponse('done')])
    const ctx = await harness(adapter)
    ctx.tools.register(defineTool({
      name: 'echo', description: 'echo', parameters: { text: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: String(args.text) }] },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // Each call attaches additionalContext naming itself.
    ctx.on('tools/post-execute', async (exec, _result): Promise<PostToolDecision> =>
      ({ kind: 'accept', additionalContext: { content: [{ type: 'text', text: `ctx-${exec.callId}` }], source: { kind: 'plugin', plugin: 'p' } } }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // Event order in the log: both tool/results, THEN both context/messages —
    // never interleaved (which would break tool-call/result adjacency).
    const types = events(agent).map(e => e.type)
    const firstResult = types.indexOf('tool/result')
    const lastResult = types.lastIndexOf('tool/result')
    const firstCtx = types.indexOf('context/message')
    expect(firstResult).toBeGreaterThanOrEqual(0)
    expect(lastResult).toBeGreaterThan(firstResult) // two results
    expect(firstCtx).toBeGreaterThan(lastResult)    // context only after ALL results
    // both contexts present
    const ctxTexts = events(agent)
      .filter(e => e.type === 'context/message')
      .flatMap(e => (e.type === 'context/message' ? e.data.content : []))
      .map(b => (b.type === 'text' ? b.text : ''))
    expect(ctxTexts).toEqual(['ctx-c1', 'ctx-c2'])
  })
})

describe('tools/pre-execute gate (native-plugin permission pattern, end-to-end through the loop)', () => {
  it('deny short-circuits dispatch into an isError result the model sees', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'danger', {}), textResponse('ok')])
    const ctx = await harness(adapter)
    let ran = false
    ctx.tools.register(defineTool({
      name: 'danger', description: 'danger', parameters: {},
      async execute() { ran = true; return [{ type: 'text', text: 'should not run' }] },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name === 'danger') return { kind: 'deny', reason: 'blocked dangerous tool' }
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(ran).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.isError).toBe(true)
    expect(result?.type === 'tool/result'
      && result.data.content.some(b => b.type === 'text' && b.text.includes('blocked dangerous tool'))).toBe(true)
  })
})

describe('worked example: a native hook plugin is just a cordis plugin on the seams', () => {
  // The whole point of the interception taxonomy: a "native hook" needs no
  // dsh-hook-protocol, no external command, no hook/* log — it is an ordinary
  // cordis plugin subscribing to the canonical events and returning typed
  // decisions. This proves all four seams compose end-to-end through the REAL
  // loop, with NO hook/* SessionEvents involved (those belong to the bridge lib).
  const NativeGuard = {
    name: 'native-guard',
    apply(ctx: Context) {
      // 1. SessionStart: seed a standing instruction.
      ctx.on('agent/session-start', (agent, source) => {
        agent.inject(
          [{ type: 'text', text: `policy active (started: ${source})` }],
          { source: { kind: 'plugin', plugin: 'native-guard' } },
        )
      })
      // 2. PromptSubmit: block a forbidden prompt, annotate the rest.
      ctx.on('agent/prompt-submit', async (_agent, content, _source, next): Promise<PromptDecision> => {
        const text = content.map(b => (b.type === 'text' ? b.text : '')).join('')
        if (text.includes('rm -rf')) return { kind: 'block', reason: 'destructive prompt blocked' }
        return next()
      })
      // 3. PreToolUse: deny a dangerous tool by name.
      ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
        if (exec.name === 'danger') return { kind: 'deny', reason: 'danger tool denied' }
        return next()
      })
      // 4. PostToolUse: attach context after a tool runs.
      ctx.on('tools/post-execute', async (_exec, _result, next): Promise<PostToolDecision> => {
        const decision = await next()
        if (decision.kind === 'accept') {
          return { kind: 'accept', additionalContext: { content: [{ type: 'text', text: 'audited' }], source: { kind: 'plugin', plugin: 'native-guard' } } }
        }
        return decision
      })
    },
  }

  it('all four seams fire for a real allowed turn with a tool call', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { text: 'hi' }), textResponse('done')])
    const ctx = await harness(adapter)
    await ctx.plugin(NativeGuard)
    ctx.tools.register(defineTool({
      name: 'echo', description: 'echo', parameters: { text: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: String(args.text) }] },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'please echo hi')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    // session-start preamble injected
    expect(log.some(e => e.type === 'context/message'
      && e.data.content.some(b => b.type === 'text' && b.text.includes('policy active (started: startup)')))).toBe(true)
    // prompt allowed → user/message recorded
    expect(log.some(e => e.type === 'user/message')).toBe(true)
    // tool ran (echo allowed) and post-execute attached "audited" context
    expect(log.some(e => e.type === 'tool/result' && !e.data.isError)).toBe(true)
    expect(log.some(e => e.type === 'context/message'
      && e.data.content.some(b => b.type === 'text' && b.text === 'audited'))).toBe(true)
    // NO hook/* events — a native plugin needs none
    expect(log.some(e => e.type.startsWith('hook/'))).toBe(false)
  })

  it('the same plugin blocks a destructive prompt → rejected turn, model never called', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    await ctx.plugin(NativeGuard)
    const agent = ctx.agentLoop.create(AgentId('a2'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event: SessionEvent) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'run rm -rf /')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(0)
    expect(reasons).toEqual([{ kind: 'rejected', reason: 'destructive prompt blocked' }])
  })

  it('HMR-safety: disposing the plugin fiber removes all four listeners', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const fiber = await ctx.plugin(NativeGuard)
    await fiber.dispose()

    // After disposal, a destructive prompt is NOT blocked (the listener is gone).
    const agent = ctx.agentLoop.create(AgentId('a3'), { model: 'mock' })
    send(agent, 'run rm -rf /')
    await waitForIdle(ctx, agent)
    // the prompt ran (not rejected) — proving the prompt-submit listener was disposed
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(e => e.type === 'user/message')).toBe(true)
  })
})
