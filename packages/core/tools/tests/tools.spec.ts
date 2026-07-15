import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from 'cordis'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import ToolRegistry, {
  defineTool, schemaSpecToJsonSchema, validateArgs, ToolArgsError, ToolNotFoundError,
  type InferArgs, type SchemaSpec, type PreToolDecision, type PostToolDecision,
  type ToolExecution, type ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  return ctx
}

const echoTool = defineTool({
  name: 'echo',
  description: 'echo arguments back',
  parameters: { text: { type: 'string' } },
  async execute(args) {
    return [{ type: 'text' as const, text: args.text ?? '' }]
  },
})

describe('ToolRegistry', () => {
  it('registers tools, exposes schemas, and feeds the system-prompt assembly', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    expect(ctx.tools.schemas()).toEqual([{
      name: 'echo',
      description: 'echo arguments back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    }])
    // schemas() result must not leak execute — ToolSchema deliberately has no
    // 'execute' key, so widen through unknown to probe for the absent property
    expect((ctx.tools.schemas()[0] as unknown as Record<string, unknown>).execute).toBeUndefined()

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(t => t.name)).toEqual(['echo'])
  })

  it('schemas() drops the UI presentation callbacks — they must never reach the model', async () => {
    const ctx = await setup()
    // A tool that declares presentCall/presentResult (functions). schemas() feeds
    // the system-prompt assembly → the model request, so those callbacks (and
    // `execute`) must be stripped: a function in the JSON tool schema would
    // corrupt the request. schemas() is an explicit allowlist, so it can't leak.
    ctx.tools.register(defineTool({
      name: 'present',
      description: 'has presenters',
      parameters: { x: { type: 'string', required: true } },
      async execute() { return [] },
      presentCall: args => ({ card: 'generic', title: args.x }),
      presentResult: (args, result) => ({ card: 'generic', title: args.x, content: result.content }),
    }))
    const schema = ctx.tools.schemas()[0] as unknown as Record<string, unknown>
    expect(Object.keys(schema).sort()).toEqual(['description', 'name', 'parameters'])
    expect(schema.presentCall).toBeUndefined()
    expect(schema.presentResult).toBeUndefined()
    expect(schema.execute).toBeUndefined()
  })

  it('schemas() excludes timeoutMs — the budget must never reach the model', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'budgeted', description: 'has a budget', parameters: {}, timeoutMs: 5_000,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    }))
    const schema = ctx.tools.schemas().find(s => s.name === 'budgeted')
    expect(schema).toBeDefined()
    expect('timeoutMs' in (schema as object)).toBe(false)
  })

  it('executes a tool and returns its content', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }], isError: false })
  })

  it('threads a tool-attached meta (object return form) onto the result', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'meta-tool',
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], meta: { diffs: [{ path: 'a', oldText: null, newText: 'x' }] } }
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'meta-tool', arguments: {} })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      meta: { diffs: [{ path: 'a', oldText: null, newText: 'x' }] },
    })
  })

  it('omits meta when the object return form supplies none', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'no-meta-tool',
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'no-meta-tool', arguments: {} })
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false })
    expect('meta' in result).toBe(false)
  })

  it('normalizes a contract-violating non-cloneable result before final notification', async () => {
    const ctx = await setup()
    let observedError: boolean | undefined
    ctx.on('tools/result', (_exec, result) => { observedError = result.isError })
    ctx.tools.register({
      ...echoTool,
      name: 'bad-meta',
      async execute() {
        return { content: [], meta: () => undefined }
      },
    })

    const result = await ctx.tools.execute({
      callId: CallId('bad-meta'), name: 'bad-meta', arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('Error:')
    expect(observedError).toBe(true)
  })

  it('returns isError results for unknown tools and throwing tools', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'boom',
      async execute() {
        throw new Error('exploded')
      },
    })

    const unknown = await ctx.tools.execute({ callId: CallId('c1'), name: 'nope', arguments: {} })
    expect(unknown.isError).toBe(true)
    expect(unknown.content[0]).toMatchObject({ text: 'Error: unknown tool "nope"' })
    // An unknown tool is a routable failure class, same as a tool-thrown one.
    expect(unknown.error).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })

    const thrown = await ctx.tools.execute({ callId: CallId('c2'), name: 'boom', arguments: {} })
    expect(thrown.isError).toBe(true)
    expect(thrown.content[0]).toMatchObject({ text: 'Error: exploded' })
  })

  it('normalizes a hostile thrown value whose inspection and coercion both throw', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'hostile-throw',
      async execute() {
        throw new Proxy({}, {
          getPrototypeOf: () => { throw new Error('prototype trap') },
          has: () => { throw new Error('has trap') },
          get: () => { throw new Error('get trap') },
        })
      },
    })

    await expect(ctx.tools.execute({
      callId: CallId('hostile'), name: 'hostile-throw', arguments: {},
    })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: <unprintable thrown value>' }],
    })
  })

  it('ToolNotFoundError carries a stable message and code', async () => {
    const { HarnessError } = await import('@deepseek-ai/dsh-llm')
    const err = new ToolNotFoundError('ghost')
    expect(err).toBeInstanceOf(HarnessError)
    expect(err.name).toBe('ToolNotFoundError')
    expect(err.code).toBe('UNKNOWN_TOOL')
    expect(err.message).toBe('unknown tool "ghost"')
  })

  it('lets a tools/pre-execute listener deny a call (permission pattern)', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name === 'echo') return { kind: 'deny', reason: 'denied by policy' }
      return next()
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: denied by policy' })
  })

  it('an ask decision degrades to deny when no approval seam is mounted', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> =>
      ({ kind: 'ask', reason: 'needs approval' }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: needs approval' })
  })

  it('an ask decision with no reason degrades to deny with a default message', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'ask' }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: tool "echo" requires approval (not yet supported)' })
  })

  describe('ask routing through ctx.approval', () => {
    /**
     * A minimal Agent stand-in — the approval seam reaches
     * `agent.session.append` and folds `.events`; the seeded open turn
     * satisfies request()'s enclosure precondition.
     */
    function fakeAgent(): Agent {
      return {
        session: { events: [{ type: 'turn/start' }], append: () => ({}) },
      } as unknown as Agent
    }

    async function approvalSetup() {
      const ctx = await setup()
      await ctx.plugin(ApprovalService)
      ctx.tools.register(echoTool)
      return ctx
    }

    it('dispatches the tool when the answerer grants allowed-once, forwarding the ask fields', async () => {
      const ctx = await approvalSetup()
      const agent = fakeAgent()
      const controller = new AbortController()
      const seen: ApprovalRequest[] = []
      ctx.on('approval/request', (req) => {
        seen.push(req)
        return Promise.resolve<ApprovalOutcome>('allowed-once')
      })
      ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> =>
        ({ kind: 'ask', reason: 'hook wants a human' }))

      const result = await ctx.tools.execute({
        callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' }, agent, signal: controller.signal,
      })

      expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'hi' }] })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ agent, toolName: 'echo', callId: 'c1', reason: 'hook wants a human' })
      expect(seen[0]?.signal).toBe(controller.signal)
    })

    it('denies with the user-rejection reason on rejected', async () => {
      const ctx = await approvalSetup()
      ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'))
      ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'ask' }))

      const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: {}, agent: fakeAgent() })
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({ text: 'Error: the user rejected tool "echo"' })
    })

    it('denies with the cancellation reason on cancelled', async () => {
      const ctx = await approvalSetup()
      ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('cancelled'))
      ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'ask' }))

      const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: {}, agent: fakeAgent() })
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({ text: 'Error: approval for tool "echo" was cancelled' })
    })

    it('denies with the no-channel reason when the seam is mounted but nobody answers', async () => {
      const ctx = await approvalSetup()
      ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'ask' }))

      const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: {}, agent: fakeAgent() })
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({ text: 'Error: tool "echo" requires approval, but no approval channel is available' })
    })

    it('denies an agent-less execution without asking — nothing to route or audit through', async () => {
      const ctx = await approvalSetup()
      let asked = false
      ctx.on('approval/request', () => {
        asked = true
        return Promise.resolve<ApprovalOutcome>('allowed-once')
      })
      ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'ask' }))

      const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: {} })
      expect(asked).toBe(false)
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({ text: 'Error: tool "echo" requires approval, but the call has no agent to route it through' })
    })

    it('turns a rogue outcome from a NON-conforming approval stand-in into an isError result', async () => {
      // ApprovalService normalizes rogue answers itself; this pins the
      // registry's own exhaustiveness backstop by shadowing the service with a
      // stand-in that violates the outcome contract.
      const ctx = await setup()
      ctx.tools.register(echoTool)
      ctx.provide('approval', { request: () => Promise.resolve('yolo') } as unknown as ApprovalService)
      ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'ask' }))

      const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: {}, agent: fakeAgent() })
      expect(result.isError).toBe(true)
      const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
      expect(text).toContain('unreachable')
    })
  })

  it('a tools/post-execute listener can replace the result content (accept) ', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    ctx.on('tools/post-execute', async (_exec, _result, _next): Promise<PostToolDecision> =>
      ({ kind: 'accept', content: [{ type: 'text', text: 'rewritten' }] }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toMatchObject({ text: 'rewritten' })
  })

  it('a tools/post-execute block turns the call into an isError with corrective feedback', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    ctx.on('tools/post-execute', async (_exec, _result, _next): Promise<PostToolDecision> =>
      ({ kind: 'block', feedback: [{ type: 'text', text: 'output rejected: try again' }] }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'output rejected: try again' })
  })

  it('a block decision can ALSO attach additionalContext', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    ctx.on('tools/post-execute', async (_exec, _result, _next): Promise<PostToolDecision> =>
      ({
        kind: 'block',
        feedback: [{ type: 'text', text: 'rejected' }],
        additionalContext: { content: [{ type: 'text', text: 'why it was rejected' }], source: { kind: 'plugin', plugin: 'test' } },
      }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'rejected' })
    expect(result.additionalContext).toMatchObject({ content: [{ text: 'why it was rejected' }], source: { kind: 'plugin', plugin: 'test' } })
  })

  it('a post-execute additionalContext rides on the result for the loop to buffer', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    ctx.on('tools/post-execute', async (_exec, _result, _next): Promise<PostToolDecision> =>
      ({ kind: 'accept', additionalContext: { content: [{ type: 'text', text: 'fyi' }], source: { kind: 'plugin', plugin: 'test' } } }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.additionalContext).toMatchObject({ content: [{ text: 'fyi' }], source: { kind: 'plugin', plugin: 'test' } })
  })

  it('composes pre + post waterfalls around dispatch (sandbox-wrap pattern)', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    const order: string[] = []
    ctx.on('tools/pre-execute', async (_exec, next) => {
      order.push('pre:before')
      const decision = await next()
      order.push('pre:after')
      return decision
    })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      order.push('post:before')
      const decision = await next()
      order.push('post:after')
      return decision
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'x' } })
    expect(result.isError).toBe(false)
    // pre runs fully (gate) before dispatch, then post runs over the result.
    expect(order).toEqual(['pre:before', 'pre:after', 'post:before', 'post:after'])
  })

  it('runs tools/execute after an allowed pre-execute, around dispatch, and before post-execute', async () => {
    const ctx = await setup()
    const order: string[] = []
    ctx.tools.register(defineTool({
      name: 'traced',
      description: 'echo',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        order.push('dispatch')
        return [{ type: 'text' as const, text: args.text ?? '' }]
      },
    }))

    ctx.on('tools/pre-execute', async (_exec, next) => { order.push('pre'); return next() })
    ctx.on('tools/execute', async (_exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
      order.push('execute:before')
      const result = await next()
      order.push('execute:after')
      return result
    })
    ctx.on('tools/post-execute', async (_exec, _result, next) => { order.push('post'); return next() })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'traced', arguments: { text: 'hi' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }], isError: false })
    // The around seam wraps dispatch; pre gates before it, post runs over its result.
    expect(order).toEqual(['pre', 'execute:before', 'dispatch', 'execute:after', 'post'])
  })

  it('a pre-execute deny short-circuits before tools/execute (the seam never runs)', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    let entered = false
    ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'deny', reason: 'nope' }))
    ctx.on('tools/execute', async (_exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
      entered = true
      return next()
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: nope' })
    expect(entered).toBe(false) // a denied call never enters the around-dispatch seam
  })

  it('a thrown tool is normalized to an isError result BEFORE a tools/execute listener sees next()', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'boom',
      async execute() { throw new HarnessError('kaboom', 'BOOM') },
    })

    let seen: { isError: boolean; error?: unknown } | undefined
    ctx.on('tools/execute', async (_exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
      const result = await next()
      // The base next() IS dispatch-with-normalization: the wrapper sees the
      // normalized isError result, never a raw throw from the tool body.
      seen = { isError: result.isError, error: result.error }
      return result
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'boom', arguments: {} })
    expect(seen).toEqual({ isError: true, error: { name: 'HarnessError', code: 'BOOM' } })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: kaboom' })
  })

  it('a thrown tool normalized inside tools/execute still reaches post-execute', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'boom',
      async execute() { throw new Error('exploded') },
    })

    let postSaw: boolean | undefined
    ctx.on('tools/execute', async (_exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => next())
    ctx.on('tools/post-execute', async (_exec, result, next) => {
      postSaw = result.isError
      return next()
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'boom', arguments: {} })
    expect(postSaw).toBe(true) // the normalized isError still flows through post-execute
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: exploded' })
  })

  it('a tools/execute listener can replace exec.signal for the dispatched tool (deadline pattern)', async () => {
    const ctx = await setup()
    let seenSignal: AbortSignal | undefined
    ctx.tools.register({
      ...echoTool,
      name: 'signal-probe',
      async execute(_args, exec) {
        seenSignal = exec.signal
        return [{ type: 'text' as const, text: 'ok' }]
      },
    })

    const upstream = new AbortController().signal
    const replacement = new AbortController().signal
    ctx.on('tools/execute', async (exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
      expect(exec.signal).toBe(upstream)
      // Cordis next() ignores passed arguments, so a wrapper mutates exec in
      // place (the documented "mutate the shared object, then delegate" idiom).
      exec.signal = replacement
      return next()
    })

    await ctx.tools.execute({ callId: CallId('c1'), name: 'signal-probe', arguments: {}, signal: upstream })
    expect(seenSignal).toBe(replacement) // dispatch saw the wrapper's replacement, not the upstream
  })

  it('a tools/execute listener can short-circuit dispatch by returning a result without next()', async () => {
    const ctx = await setup()
    let dispatched = false
    ctx.tools.register({
      ...echoTool,
      name: 'never-runs',
      async execute() { dispatched = true; return [] },
    })

    ctx.on('tools/execute', async (_exec: ToolExecution, _next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> =>
      ({ content: [{ type: 'text', text: 'short-circuited' }], isError: false }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'never-runs', arguments: {} })
    expect(dispatched).toBe(false) // returning without next() skips core dispatch
    expect(result.content[0]).toMatchObject({ text: 'short-circuited' })
  })

  it('preserves additionalContext supplied by an around-dispatch result', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/execute', async () => ({
      content: [{ type: 'text', text: 'short-circuited with context' }],
      isError: false,
      additionalContext: {
        content: [{ type: 'text', text: 'from around dispatch' }],
        source: { kind: 'plugin', plugin: 'test' },
      },
    }))

    const result = await ctx.tools.execute({
      callId: CallId('around-context'), name: 'echo', arguments: {},
    })
    expect(result.additionalContext).toEqual({
      content: [{ type: 'text', text: 'from around dispatch' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
  })

  it('returns an isError result when a tools/execute listener throws', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/execute', async () => { throw new Error('wrapper broke') })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: wrapper broke' }],
      isError: true,
    })
  })

  it('returns an isError result when a tools/pre-execute listener throws', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/pre-execute', async () => {
      throw new Error('permission hook broke')
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: permission hook broke' }],
      isError: true,
    })
  })

  it('returns an isError result when a tools/post-execute listener throws', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/post-execute', async () => {
      throw new Error('post hook broke')
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: post hook broke' }],
      isError: true,
    })
  })

  it('preserves structured error info when a tools/pre-execute listener throws HarnessError', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/pre-execute', async () => {
      throw new HarnessError('denied', 'DENIED')
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })

    expect(result).toMatchObject({
      isError: true,
      error: { name: 'HarnessError', code: 'DENIED' },
    })
  })

  it('schemas() snapshots tool schemas instead of exposing registry objects', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    const first = ctx.tools.schemas()
    const firstParameters = first[0]!.parameters as { properties: Record<string, unknown> }
    firstParameters.properties['mutated'] = { type: 'string' }
    first[0]!.description = 'mutated'

    expect(ctx.tools.schemas()).toEqual([{
      name: 'echo',
      description: 'echo arguments back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    }])
  })

  it('rejects a non-positive or non-finite registration timeout', async () => {
    const ctx = await setup()
    expect(() => ctx.tools.register({ ...echoTool, name: 'zero-timeout', timeoutMs: 0 }))
      .toThrow('timeoutMs must be a positive finite number')
    expect(() => ctx.tools.register({ ...echoTool, name: 'infinite-timeout', timeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow('timeoutMs must be a positive finite number')
  })

  it('rejects duplicate names and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    expect(() => ctx.tools.register(echoTool)).toThrow('already registered')

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.tools.register({ ...echoTool, name: 'scoped' })
    }, { inject: ['tools'] }))
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo', 'scoped'])

    await fiber.dispose()
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo'])
  })

  it('returns a callable disposer from register() that unregisters the tool', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)

    // Register a second tool and call its returned disposer directly
    const dispose = ctx.tools.register({ ...echoTool, name: 'disposable' })
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo', 'disposable'])

    dispose()
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo'])
  })

  it('rolls back the tool entry when a tools/change listener throws (P1-1)', async () => {
    const ctx = await setup()

    let threw = false
    ctx.on('tools/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    // The throwing emit must roll the entry back, not leak it.
    expect(() => ctx.tools.register(echoTool)).toThrow('boom change listener')
    expect(ctx.tools.get('echo')).toBeUndefined() // rolled back, not leaked
    expect(ctx.tools.schemas()).toHaveLength(0)

    // A subsequent listener-free register of the SAME name succeeds and is
    // exposed exactly once (the duplicate-name check is not wedged).
    const dispose = ctx.tools.register(echoTool)
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo'])
    dispose()
    expect(ctx.tools.get('echo')).toBeUndefined()
  })

  it('register() returns the EXACT effect disposer: a composite yield nests the teardown in order', async () => {
    // Registry methods return the exact Cordis effect disposer so a composite yield places
    // unregistration at its LIFO position. A wrapper would create a concurrent sibling; this async
    // probe yields during earlier teardown and would then observe the tool already removed.
    const ctx = await setup()
    const order: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.effect(function* () {
        yield () => { order.push('disposed-last') }
        yield inner.tools.register({ ...echoTool, name: 'nested' })
        order.push('registered')
        yield async () => {
          await new Promise(resolve => setTimeout(resolve, 0))
          order.push(inner.tools.get('nested') ? 'first: still registered' : 'first: already gone')
        }
      })
    }, { inject: ['tools'] }))
    await fiber.dispose()
    expect(order).toEqual(['registered', 'first: still registered', 'disposed-last'])
    expect(ctx.tools.get('nested')).toBeUndefined()
  })
})

describe('defineTool / schema DSL', () => {
  it('converts SchemaSpec to standard JSON Schema with required array', () => {
    const spec = {
      path: { type: 'string', required: true, description: 'Absolute path' },
      offset: { type: 'number' },
      limit: { type: 'number', description: 'Max lines' },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path' },
        offset: { type: 'number' },
        limit: { type: 'number', description: 'Max lines' },
      },
      required: ['path'],
    })
  })

  it('handles empty spec (no properties, no required)', () => {
    expect(schemaSpecToJsonSchema({})).toEqual({
      type: 'object',
      properties: {},
    })
  })

  it('handles nested object spec', () => {
    const spec = {
      config: {
        type: 'object',
        required: true,
        properties: {
          host: { type: 'string', required: true },
          port: { type: 'number' },
        },
      },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema).toEqual({
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            port: { type: 'number' },
          },
          required: ['host'],
        },
      },
      required: ['config'],
    })
  })

  it('defineTool returns a valid ToolDefinition with typed execute', async () => {
    const ctx = await setup()
    const tool = defineTool({
      name: 'typed-echo',
      description: 'A typed echo tool',
      parameters: {
        text: { type: 'string', required: true },
        uppercase: { type: 'boolean' },
      },
      async execute(args) {
        // args is typed: { text: string; uppercase?: boolean }
        const result = args.uppercase ? args.text.toUpperCase() : args.text
        return [{ type: 'text', text: result }]
      },
    })

    ctx.tools.register(tool)
    expect(ctx.tools.schemas()).toEqual([{
      name: 'typed-echo',
      description: 'A typed echo tool',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          uppercase: { type: 'boolean' },
        },
        required: ['text'],
      },
    }])

    const result = await ctx.tools.execute({
      callId: CallId('c1'),
      name: 'typed-echo',
      arguments: { text: 'hello', uppercase: true },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'HELLO' }])
  })

  it('type-level: InferArgs maps required properties to non-optional', () => {
    // Compile-time check: if this compiles, InferArgs is correct.
    // args.a is string (required), args.b is number|undefined (optional).
    const tool = defineTool({
      name: 'type-check',
      description: '',
      parameters: { a: { type: 'string' as const, required: true as const }, b: { type: 'number' as const } },
      async execute(args) {
        // Verify types at runtime via typeof
        expect(typeof args.a).toBe('string')
        // args.b should be undefined when not provided
        void args
        return [{ type: 'text', text: args.a }]
      },
    })
    void tool
  })

  it('registry round-trips a defineTool definition (register→schemas→execute)', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'roundtrip',
      description: 'Round-trip test',
      parameters: {
        req: { type: 'string', required: true },
        opt: { type: 'number', description: 'Optional number' },
      },
      async execute(args) {
        return [{ type: 'text', text: `${args.req}:${args.opt ?? 'none'}` }]
      },
    }))

    // Schema round-trip: schemas() returns standard JSON Schema
    const schemas = ctx.tools.schemas()
    expect(schemas).toHaveLength(1)
    expect(schemas[0]!.parameters).toEqual({
      type: 'object',
      properties: {
        req: { type: 'string' },
        opt: { type: 'number', description: 'Optional number' },
      },
      required: ['req'],
    })

    // Execution round-trip
    const result = await ctx.tools.execute({
      callId: CallId('c1'),
      name: 'roundtrip',
      arguments: { req: 'hello' },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'hello:none' }])
  })

  it('still accepts raw JSON-Schema ToolDefinition directly (MCP interop)', async () => {
    const ctx = await setup()
    ctx.tools.register({
      name: 'raw-tool',
      description: 'Raw JSON Schema tool (like an MCP adapter would register)',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      async execute(args: unknown) {
        const p = args as { path: string }
        return [{ type: 'text', text: p.path }]
      },
    })

    const schemas = ctx.tools.schemas()
    expect(schemas[0]!.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })

    const result = await ctx.tools.execute({
      callId: CallId('c1'),
      name: 'raw-tool',
      arguments: { path: '/tmp' },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '/tmp' }])
  })
})

describe('schema DSL edge cases', () => {
  it('emits enum values in JSON Schema property', () => {
    const spec = {
      color: { type: 'string', enum: ['red', 'green', 'blue'], description: 'Color choice' },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['color']).toMatchObject({
      type: 'string',
      enum: ['red', 'green', 'blue'],
      description: 'Color choice',
    })
  })

  it('emits default value in JSON Schema property', () => {
    const spec = {
      limit: { type: 'number', default: 25 },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['limit']).toMatchObject({
      type: 'number',
      default: 25,
    })
  })

  it('handles array items without nested properties (plain type array)', () => {
    const spec = {
      tags: { type: 'array', items: { type: 'string' } },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['tags']).toEqual({
      type: 'array',
      items: { type: 'string' },
    })
  })

  it('handles enum and default together in one property', () => {
    const spec = {
      level: { type: 'string', enum: ['low', 'high'], default: 'low' },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['level']).toMatchObject({
      type: 'string',
      enum: ['low', 'high'],
      default: 'low',
    })
  })

  it('omits description, enum, default keys when not specified', () => {
    const spec = {
      bare: { type: 'string' },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    const prop = jsonSchema.properties['bare'] as Record<string, unknown>
    expect(prop).toEqual({ type: 'string' })
    expect('description' in prop).toBe(false)
    expect('enum' in prop).toBe(false)
    expect('default' in prop).toBe(false)
  })

  it('handles array with no items (items omitted)', () => {
    const spec = {
      raw: { type: 'array' },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['raw']).toEqual({
      type: 'array',
    })
  })

  it('handles nested object with all-optional properties (no required array)', () => {
    const spec = {
      config: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          port: { type: 'number' },
        },
      },
    } satisfies SchemaSpec
    const jsonSchema = schemaSpecToJsonSchema(spec)
    expect(jsonSchema.properties['config']).toMatchObject({
      type: 'object',
      properties: {
        host: { type: 'string' },
        port: { type: 'number' },
      },
    })
    const config = jsonSchema.properties['config'] as Record<string, unknown>
    expect('required' in config).toBe(false)
  })
})

describe('schema DSL optional and nested contracts', () => {
  it('InferArgs makes non-required keys genuinely optional (omittable)', () => {
    type Args = InferArgs<{
      path: { type: 'string'; required: true }
      limit: { type: 'number' }
    }>
    expectTypeOf<Args>().toEqualTypeOf<{ path: string; limit?: number }>()
    const omitted: Args = { path: '/tmp' }
    expect(omitted.limit).toBeUndefined()
  })

  it('InferArgs recurses into array items, including arrays of objects', () => {
    type Args = InferArgs<{
      names: { type: 'array'; required: true; items: { type: 'string' } }
      servers: {
        type: 'array'
        items: {
          type: 'object'
          properties: {
            host: { type: 'string'; required: true }
            port: { type: 'number' }
          }
        }
      }
    }>
    expectTypeOf<Args>().toEqualTypeOf<{
      names: string[]
      servers?: { host: string; port?: number }[]
    }>()
  })

  it('runtime JSON Schema matches the array-of-objects inference', () => {
    const spec = {
      servers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            host: { type: 'string', required: true },
            port: { type: 'number' },
          },
        },
      },
    } satisfies SchemaSpec
    expect(schemaSpecToJsonSchema(spec)).toEqual({
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              host: { type: 'string' },
              port: { type: 'number' },
            },
            required: ['host'],
          },
        },
      },
    })
  })

  it('reports messages from non-Error throws (throw { message })', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'object-thrower',
      async execute() {
        // testing non-Error throws on purpose
        throw { message: 'denied by object' }
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'object-thrower', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: denied by object' })
  })

  it('reports messages from throws of non-objects (throw "string")', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'string-thrower',
      async execute() {
        // testing primitive throws on purpose
        throw 'kaboom'
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'string-thrower', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: kaboom' })
  })

  it('reports messages from throws of objects without message property', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'object-no-message',
      async execute() {
        // testing object throw without .message
        throw { code: 500 }
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'object-no-message', arguments: {} })
    expect(result.isError).toBe(true)
    const firstContent = result.content[0]!
    expect(firstContent.type).toBe('text')
    if (firstContent.type === 'text') {
      expect(firstContent.text).toBe('Error: [object Object]')
    }
  })
})

describe('ToolRegistry.get', () => {
  it('get() returns the registered tool definition', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    const tool = ctx.tools.get('echo')
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('echo')
  })

  it('get() returns undefined for unknown tool names', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('nope')).toBeUndefined()
  })
})

describe('validateArgs (the runtime-validation RFC, part 1)', () => {
  it('returns [] for valid args and is total over malformed input', () => {
    const spec = {
      path: { type: 'string', required: true },
      limit: { type: 'number' },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { path: '/tmp' })).toEqual([])
    expect(validateArgs(spec, { path: '/tmp', limit: 5 })).toEqual([])
    // never throws regardless of shape
    expect(validateArgs(spec, null)).toHaveLength(1)
    expect(validateArgs(spec, 'nope')).toHaveLength(1)
    expect(validateArgs(spec, [])).toHaveLength(1)
  })

  it('flags a missing required key and a required key present as undefined', () => {
    const spec = { path: { type: 'string', required: true } } satisfies SchemaSpec
    expect(validateArgs(spec, {})).toEqual(['missing required property "path"'])
    expect(validateArgs(spec, { path: undefined })).toEqual(['missing required property "path"'])
  })

  it('allows extra keys (no additionalProperties:false) and omitted optionals', () => {
    const spec = { path: { type: 'string', required: true } } satisfies SchemaSpec
    expect(validateArgs(spec, { path: '/tmp', extra: 1 })).toEqual([])
  })

  it('does not apply defaults (validation only)', () => {
    const spec = { limit: { type: 'number', default: 25 } } satisfies SchemaSpec
    // absent optional is valid, and validation does not synthesize the default
    expect(validateArgs(spec, {})).toEqual([])
  })

  it('type-checks primitives', () => {
    const spec = {
      s: { type: 'string' },
      n: { type: 'number' },
      b: { type: 'boolean' },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { s: 1 })).toEqual(['"s" must be a string'])
    expect(validateArgs(spec, { n: 'x' })).toEqual(['"n" must be a number'])
    expect(validateArgs(spec, { b: 'x' })).toEqual(['"b" must be a boolean'])
  })

  it('checks enum membership', () => {
    const spec = { color: { type: 'string', enum: ['red', 'green'] } } satisfies SchemaSpec
    expect(validateArgs(spec, { color: 'red' })).toEqual([])
    expect(validateArgs(spec, { color: 'blue' })).toEqual(['"color" must be one of ["red","green"]'])
  })

  it('checks enum uniformly with the converter (enum on a non-string prop)', () => {
    // The converter emits `enum` regardless of type; the validator must agree.
    // `enum` is string[], so a number value can never be a member.
    const spec = { n: { type: 'number', enum: ['1', '2'] } } as unknown as SchemaSpec
    expect(validateArgs(spec, { n: 1 })).toEqual(['"n" must be one of ["1","2"]'])
  })

  it('rejects an unknown SchemaType at runtime (assertNever guard)', () => {
    const spec = { x: { type: 'weird' } } as unknown as SchemaSpec
    expect(() => validateArgs(spec, { x: 1 })).toThrow(/unreachable variant.*validateArgs/)
  })

  it('recurses into nested objects (and an object without properties only type-checks)', () => {
    const spec = {
      config: {
        type: 'object',
        required: true,
        properties: { host: { type: 'string', required: true }, port: { type: 'number' } },
      },
      bag: { type: 'object' },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { config: { host: 'h' }, bag: { anything: true } })).toEqual([])
    expect(validateArgs(spec, { config: { port: 9 }, bag: 5 })).toEqual([
      'missing required property "config.host"',
      '"bag" must be an object',
    ])
  })

  it('recurses into array items (and an array without items only type-checks)', () => {
    const spec = {
      tags: { type: 'array', items: { type: 'string' } },
      raw: { type: 'array' },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { tags: ['a', 'b'], raw: [1, {}, 'x'] })).toEqual([])
    expect(validateArgs(spec, { tags: ['a', 2] })).toEqual(['"tags[1]" must be a string'])
    // a non-array value for an array-typed prop
    expect(validateArgs(spec, { tags: 'nope' })).toEqual(['"tags" must be an array'])
  })

  it('validates arrays of objects element-wise', () => {
    const spec = {
      servers: {
        type: 'array',
        items: { type: 'object', properties: { host: { type: 'string', required: true } } },
      },
    } satisfies SchemaSpec
    expect(validateArgs(spec, { servers: [{ host: 'a' }, {}] })).toEqual([
      'missing required property "servers[1].host"',
    ])
  })
})

describe('defineTool validation (the runtime-validation RFC, part 1)', () => {
  it('returns an isError result with the violations when the model sends bad args', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'reader',
      description: 'reads a path',
      parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: args.path }]
      },
    }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'reader', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      text: 'Error: invalid arguments: missing required property "path"',
    })
  })

  it('runs execute normally when args are valid', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'reader',
      description: 'reads a path',
      parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: `read ${args.path}` }]
      },
    }))
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'reader', arguments: { path: '/x' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'read /x' }], isError: false })
  })

  it('ToolArgsError carries a stable code and the violation list', () => {
    const err = new ToolArgsError(['missing required property "a"', '"b" must be a number'])
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ToolArgsError')
    expect(err.code).toBe('INVALID_ARGS')
    expect(err.violations).toEqual(['missing required property "a"', '"b" must be a number'])
    expect(err.message).toBe('invalid arguments: missing required property "a"; "b" must be a number')
  })

  it('a schema-invalid call surfaces the structured error on the result', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'reader',
      description: 'reads a path',
      parameters: { path: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text', text: args.path }]
      },
    }))
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'reader', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
  })

  it('a tool throwing a HarnessError surfaces its name and code', async () => {
    const { HarnessError } = await import('@deepseek-ai/dsh-llm')
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'coded',
      async execute() {
        throw new HarnessError('disk full', 'ENOSPC')
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'coded', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({ name: 'HarnessError', code: 'ENOSPC' })
    expect(result.content[0]).toMatchObject({ text: 'Error: disk full' })
  })

  it('a non-HarnessError throw has no structured error (only the text)', async () => {
    const ctx = await setup()
    ctx.tools.register({
      ...echoTool,
      name: 'plain',
      async execute() {
        throw new Error('just a message')
      },
    })
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'plain', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.content[0]).toMatchObject({ text: 'Error: just a message' })
  })

  it('raw-registered tools are NOT validated by defineTool (MCP keeps its own)', async () => {
    const ctx = await setup()
    // A raw ToolDefinition: no defineTool wrapping, so no validateArgs guard.
    ctx.tools.register({
      name: 'raw',
      description: 'raw tool',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(args: unknown) {
        return [{ type: 'text', text: typeof args }]
      },
    })
    // Missing the "required" path — but raw tools validate their own input, so
    // this reaches execute rather than being rejected by the harness.
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'raw', arguments: {} })
    expect(result.isError).toBe(false)
  })

  it('attaches a positive-finite timeoutMs to the definition', () => {
    const tool = defineTool({
      name: 'x', description: 'd', parameters: {}, timeoutMs: 30_000,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    })
    expect(tool.timeoutMs).toBe(30_000)
  })

  it('omits timeoutMs when not declared', () => {
    const tool = defineTool({
      name: 'x', description: 'd', parameters: {},
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    })
    expect(tool.timeoutMs).toBeUndefined()
  })

  it('throws when timeoutMs is zero or negative', () => {
    const make = (ms: number) => defineTool({
      name: 'x', description: 'd', parameters: {}, timeoutMs: ms,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    })
    expect(() => make(0)).toThrow('timeoutMs must be a positive finite number')
    expect(() => make(-5)).toThrow('positive finite number')
  })

  it('throws when timeoutMs is non-finite', () => {
    expect(() => defineTool({
      name: 'x', description: 'd', parameters: {}, timeoutMs: Infinity,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    })).toThrow('positive finite number')
  })
})

describe('defineTool presentation (presentCall / presentResult)', () => {
  it('threads presentCall/presentResult onto the ToolDefinition with typed args', () => {
    const tool = defineTool({
      name: 'demo',
      description: 'demo',
      parameters: { path: { type: 'string', required: true }, n: { type: 'number' } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
      presentCall(args) {
        // args is typed { path: string; n?: number } — zero casts.
        expectTypeOf(args).toEqualTypeOf<{ path: string; n?: number }>()
        return { card: 'generic', title: `Open ${args.path}`, kind: 'read', rawInput: args.path }
      },
      presentResult(args, result) {
        return { card: 'generic', title: `Opened ${args.path}`, content: result.content }
      },
    })
    expect(tool.presentCall!({ path: '/a', n: 2 })).toEqual({ card: 'generic', title: 'Open /a', kind: 'read', rawInput: '/a' })
    expect(tool.presentResult!({ path: '/a' }, { content: [{ type: 'text', text: 'x' }], isError: false }))
      .toEqual({ card: 'generic', title: 'Opened /a', content: [{ type: 'text', text: 'x' }] })
  })

  it('a tool without presentCall/presentResult leaves them undefined (UI falls back generically)', () => {
    const tool = defineTool({
      name: 'plain',
      description: 'plain',
      parameters: { x: { type: 'string', required: true } },
      async execute() { return [] },
    })
    expect(typeof tool.presentCall).toBe('undefined')
    expect(typeof tool.presentResult).toBe('undefined')
  })

  it('presentCall/presentResult validate softly: malformed args return undefined, never throw (display runs on replay)', () => {
    const tool = defineTool({
      name: 'demo',
      description: 'demo',
      parameters: { path: { type: 'string', required: true } },
      async execute() { return [] },
      presentCall: args => ({ card: 'generic', title: args.path }),
      presentResult: (args, result) => ({ card: 'generic', title: args.path, content: result.content }),
    })
    // Unlike execute (which throws ToolArgsError on a mismatch), the display
    // methods soft-validate and fall back to undefined so a UI never crashes
    // replaying an old/foreign log entry. The ToolDefinition methods take
    // `unknown`, so malformed shapes pass without a cast.
    expect(tool.presentCall?.({})).toBeUndefined()
    expect(tool.presentResult?.({ wrong: 1 }, { content: [], isError: false })).toBeUndefined()
  })
})
