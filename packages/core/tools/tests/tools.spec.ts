import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from 'cordis'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import ToolRegistry, {
  defineTool, schemaSpecToJsonSchema, validateArgs, ToolArgsError, ToolNotFoundError,
  type DefineToolOptions, type InferArgs, type SchemaSpec, type PreToolDecision, type PostToolDecision,
  type ToolDefinition, type ToolExecution, type ToolExecutionInput, type ToolExecutionResult, type ToolGuard,
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
    expect(result).toEqual({ callId: CallId('c1'), content: [{ type: 'text', text: 'hi' }], isError: false })
  })

  it.each([
    { field: 'callId', value: 1n },
    { field: 'callId', value: 123 },
    { field: 'name', value: 1n },
    { field: 'name', value: 123 },
  ] as const)('rejects a non-string $field before final observation', async ({ field, value }) => {
    const ctx = await setup()
    let observed = 0
    ctx.on('tools/result', () => { observed += 1 })
    const input: Record<string, unknown> = {
      callId: CallId('valid-call'),
      name: 'missing',
      arguments: {},
    }
    input[field] = value

    await expect(ctx.tools.execute(input as unknown as ToolExecutionInput))
      .rejects.toThrow(`tool execution ${field} must be a string`)
    expect(observed).toBe(0)
  })

  it('reads correlation accessors once and normalizes a later hostile accessor', async () => {
    const ctx = await setup()
    const reads = { callId: 0, name: 0, arguments: 0 }
    let observed: { callId: unknown; name: unknown; isError: boolean } | undefined
    ctx.on('tools/result', (exec, result) => {
      observed = { callId: exec.callId, name: exec.name, isError: result.isError }
    })
    const input = Object.defineProperties({}, {
      callId: {
        enumerable: true,
        get: () => {
          reads.callId += 1
          if (reads.callId > 1) throw new Error('callId reread')
          return CallId('one-read-call')
        },
      },
      name: {
        enumerable: true,
        get: () => {
          reads.name += 1
          if (reads.name > 1) throw new Error('name reread')
          return 'missing'
        },
      },
      arguments: {
        enumerable: true,
        get: () => {
          reads.arguments += 1
          throw new Error('arguments accessor broke')
        },
      },
    }) as unknown as ToolExecutionInput

    const result = await ctx.tools.execute(input)

    expect(reads).toEqual({ callId: 1, name: 1, arguments: 1 })
    expect(result).toMatchObject({ callId: CallId('one-read-call'), isError: true })
    expect(result.content[0]).toMatchObject({ text: 'Error: arguments accessor broke' })
    expect(observed).toEqual({ callId: CallId('one-read-call'), name: 'missing', isError: true })
  })

  it('reads callId once before a hostile name accessor rejects correlation', async () => {
    const ctx = await setup()
    const reads = { callId: 0, name: 0 }
    let observed = 0
    ctx.on('tools/result', () => { observed += 1 })
    const input = Object.defineProperties({ arguments: {} }, {
      callId: {
        enumerable: true,
        get: () => {
          reads.callId += 1
          return CallId('hostile-name')
        },
      },
      name: {
        enumerable: true,
        get: () => {
          reads.name += 1
          throw new Error('name accessor broke')
        },
      },
    }) as unknown as ToolExecutionInput

    await expect(ctx.tools.execute(input)).rejects.toThrow('name accessor broke')
    expect(reads).toEqual({ callId: 1, name: 1 })
    expect(observed).toBe(0)
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
      callId: CallId('c1'),
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
    expect(result).toEqual({ callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false })
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

  it('reads each result value once so later getter drift cannot change the snapshot', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    let reads = 0
    const hostileBlock = Object.defineProperty({ type: 'text' }, 'text', {
      enumerable: true,
      get: () => ++reads === 1 ? 'safe' : new Map([['mutable', true]]),
    })
    ctx.on('tools/execute', async exec => ({
      callId: exec.callId,
      content: [hostileBlock],
      isError: false,
    }) as unknown as ToolExecutionResult)

    const result = await ctx.tools.execute({
      callId: CallId('unstable-result'), name: 'echo', arguments: {},
    })

    expect(reads).toBe(1)
    expect(result).toEqual({
      callId: CallId('unstable-result'),
      content: [{ type: 'text', text: 'safe' }],
      isError: false,
    })
  })

  it('reads every top-level execution result field once before validation', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    const reads = { callId: 0, content: 0, isError: 0, error: 0, additionalContext: 0, meta: 0 }
    ctx.on('tools/execute', async exec => Object.defineProperties({}, {
      callId: { enumerable: true, get: () => { reads.callId += 1; return reads.callId === 1 ? exec.callId : CallId('drifted') } },
      content: { enumerable: true, get: () => { reads.content += 1; return reads.content === 1 ? [{ type: 'text', text: 'accepted' }] : [] } },
      isError: { enumerable: true, get: () => { reads.isError += 1; return reads.isError !== 1 } },
      error: { enumerable: true, get: () => { reads.error += 1; return undefined } },
      additionalContext: { enumerable: true, get: () => { reads.additionalContext += 1; return undefined } },
      meta: { enumerable: true, get: () => { reads.meta += 1; return undefined } },
    }) as ToolExecutionResult)

    const result = await ctx.tools.execute({
      callId: CallId('one-read-result'), name: 'echo', arguments: {},
    })

    expect(reads).toEqual({ callId: 1, content: 1, isError: 1, error: 1, additionalContext: 1, meta: 1 })
    expect(result).toEqual({
      callId: CallId('one-read-result'),
      content: [{ type: 'text', text: 'accepted' }],
      isError: false,
    })
  })

  it('rejects an exotic nested result before its prototype can be sanitized', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    class ExoticText { readonly value = 'not text' }
    ctx.on('tools/execute', exec => Promise.resolve({
      callId: exec.callId,
      content: [{ type: 'text', text: new ExoticText() }],
      isError: false,
    } as unknown as ToolExecutionResult))

    const result = await ctx.tools.execute({
      callId: CallId('exotic-result'), name: 'echo', arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text', text: 'Error: tools/execute must return a losslessly JSON-serializable ToolExecutionResult',
    }])
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

  it('ToolNotFoundError carries the tool name and a stable code', async () => {
    const { HarnessError } = await import('@deepseek-ai/dsh-llm')
    const err = new ToolNotFoundError('ghost')
    expect(err).toBeInstanceOf(HarnessError)
    expect(err.name).toBe('ToolNotFoundError')
    expect(err.code).toBe('UNKNOWN_TOOL')
    expect(err.toolName).toBe('ghost')
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

  it.each([
    {
      name: 'non-object decision',
      replacement: null,
      message: 'tools/pre-execute must return a PreToolDecision object',
    },
    {
      name: 'unknown decision kind',
      replacement: { kind: 'permit' },
      message: 'tools/pre-execute must return an allow, deny, or ask decision',
    },
    {
      name: 'allow decision carrying extra fields',
      replacement: { kind: 'allow', reason: 'smuggled' },
      message: 'tools/pre-execute allow decision must contain only kind',
    },
    {
      name: 'deny decision without a reason',
      replacement: { kind: 'deny' },
      message: 'tools/pre-execute deny decision must contain only kind and a string reason',
    },
    {
      name: 'deny decision with a non-string reason',
      replacement: { kind: 'deny', reason: 42 },
      message: 'tools/pre-execute deny decision must contain only kind and a string reason',
    },
    {
      name: 'ask decision with a non-string reason',
      replacement: { kind: 'ask', reason: true },
      message: 'tools/pre-execute ask decision must contain only kind and an optional string reason',
    },
    {
      name: 'ask decision carrying extra fields',
      replacement: { kind: 'ask', cache: true },
      message: 'tools/pre-execute ask decision must contain only kind and an optional string reason',
    },
  ])('fails closed on a malformed tools/pre-execute $name', async ({ replacement, message }) => {
    const ctx = await setup()
    let bodyCalls = 0
    const observed: ToolExecutionResult[] = []
    ctx.tools.register({
      ...echoTool,
      async execute() {
        bodyCalls += 1
        return []
      },
    })
    ctx.on('tools/pre-execute', async () => replacement as unknown as PreToolDecision)
    ctx.on('tools/result', (_exec, result) => { observed.push(result) })

    const result = await ctx.tools.execute({
      callId: CallId('malformed-pre'), name: 'echo', arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: `Error: ${message}` })
    expect(bodyCalls).toBe(0)
    expect(observed).toEqual([result])
  })

  it('rejects a JavaScript guard that returns an async/non-string decision', async () => {
    const ctx = await setup()
    let bodyCalls = 0
    ctx.tools.register({
      ...echoTool,
      async execute() {
        bodyCalls += 1
        return []
      },
    })
    ctx.tools.guard((() => Promise.resolve('late denial')) as unknown as ToolGuard)

    const result = await ctx.tools.execute({ callId: CallId('bad-guard'), name: 'echo', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' && result.content[0].text)
      .toContain('tools.guard() must return')
    expect(bodyCalls).toBe(0)
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

  it('a post-execute listener cannot mutate any nested part of the dispatched result', async () => {
    // The decision is the ONLY sanctioned channel to change the outcome. A
    // listener that reaches in and mutates the passed result reference (flipping
    // isError, rewriting callId, attaching a bogus error) must NOT affect what
    // execute() returns — the registry snapshots the authoritative fields before
    // the waterfall and rebuilds from the snapshot + decision.
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/execute', async (_exec, next) => {
      await next()
      return {
        callId: CallId('c1'),
        content: [{ type: 'text', text: 'original' }],
        isError: true,
        error: { name: 'OriginalError', code: 'ORIGINAL' },
        meta: { nested: { label: 'original' } },
      }
    })

    ctx.on('tools/post-execute', async (_exec, result, next) => {
      const mutable = result as {
        callId: string
        isError: boolean
        error?: { name: string; code: string }
        content: { type: 'text'; text: string }[]
        meta?: { nested: { label: string } }
      }
      mutable.callId = 'hijacked'
      mutable.isError = false
      if (mutable.error) {
        mutable.error.name = 'Evil'
        mutable.error.code = 'EVIL'
      }
      mutable.content[0]!.text = 'MUTATED'
      mutable.content.push({ type: 'text', text: 'INJECTED' }) // in-place array mutation
      if (mutable.meta) mutable.meta.nested.label = 'MUTATED'
      return next() // delegate to the default accept — no decision-level override
    })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result.callId).toBe(CallId('c1'))   // authoritative exec.callId, not 'hijacked'
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({ name: 'OriginalError', code: 'ORIGINAL' })
    expect(result.content).toHaveLength(1)       // the in-place push did not leak in
    expect(result.content[0]).toMatchObject({ text: 'original' })
    expect(result.content.some(b => (b as { text?: string }).text === 'INJECTED')).toBe(false)
    expect(result.meta).toEqual({ nested: { label: 'original' } })
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
    expect(result).toEqual({ callId: CallId('c1'), content: [{ type: 'text', text: 'hi' }], isError: false })
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

    ctx.on('tools/execute', async (exec: ToolExecution, _next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> =>
      ({ callId: exec.callId, content: [{ type: 'text', text: 'short-circuited' }], isError: false }))

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'never-runs', arguments: {} })
    expect(dispatched).toBe(false) // returning without next() skips core dispatch
    expect(result.content[0]).toMatchObject({ text: 'short-circuited' })
  })

  it('preserves additionalContext supplied by an around-dispatch result', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/execute', async exec => ({
      callId: exec.callId,
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

  it('normalizes malformed tools/execute results instead of treating them as success', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    let observedError: boolean | undefined
    ctx.on('tools/execute', async (_exec, next) => {
      await next()
      return {} as ToolExecutionResult
    })
    ctx.on('tools/result', (_exec, result) => { observedError = result.isError })

    const result = await ctx.tools.execute({ callId: CallId('malformed'), name: 'echo', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      text: 'Error: tools/execute must return a ToolExecutionResult with content[] and boolean isError',
    })
    expect(observedError).toBe(true)
  })

  it('rejects non-JSON data at the defensive final-result notification boundary', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    let execution: ToolExecution | undefined
    ctx.on('tools/execute', async (exec, next) => {
      execution = exec
      return next()
    })
    await ctx.tools.execute({ callId: CallId('capture-execution'), name: 'echo', arguments: {} })
    if (execution === undefined) throw new Error('test fixture did not capture the execution')

    const internal = ctx.tools as unknown as {
      notifyResult(exec: ToolExecution, result: ToolExecutionResult): Promise<void>
    }
    const invalid = {
      callId: CallId('capture-execution'),
      content: new Map() as unknown as ToolExecutionResult['content'],
      isError: false,
    }
    await expect(internal.notifyResult(execution, invalid))
      .rejects.toThrow('tool result notification must be losslessly JSON-serializable')
  })

  it.each([
    {
      name: 'non-object result',
      replacement: null,
      message: 'tools/execute must return a ToolExecutionResult object',
    },
    {
      name: 'wrong call id',
      replacement: { callId: CallId('other'), content: [], isError: false },
      message: 'tools/execute returned callId "other" for authoritative call "malformed-shape"',
    },
  ])('normalizes a tools/execute $name', async ({ replacement, message }) => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/execute', async () => replacement as ToolExecutionResult)

    const result = await ctx.tools.execute({
      callId: CallId('malformed-shape'), name: 'echo', arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: `Error: ${message}` })
  })

  it('normalizes malformed tools/post-execute decisions', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/post-execute', async () => ({ kind: 'accept', content: 'not blocks' }) as unknown as PostToolDecision)

    const result = await ctx.tools.execute({ callId: CallId('malformed-post'), name: 'echo', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      text: 'Error: tools/post-execute accept content must be an array',
    })
  })

  it.each([
    {
      name: 'non-object decision',
      replacement: null,
      message: 'tools/post-execute must return a PostToolDecision object',
    },
    {
      name: 'block without feedback blocks',
      replacement: { kind: 'block', feedback: 'not blocks' },
      message: 'tools/post-execute block feedback must be an array',
    },
    {
      name: 'unknown decision kind',
      replacement: { kind: 'defer' },
      message: 'tools/post-execute must return an accept or block decision',
    },
    {
      name: 'non-JSON decision',
      replacement: { kind: 'accept', content: new Map() },
      message: 'tools/post-execute must return a losslessly JSON-serializable decision',
    },
  ])('normalizes a tools/post-execute $name', async ({ replacement, message }) => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/post-execute', async () => replacement as unknown as PostToolDecision)

    const result = await ctx.tools.execute({
      callId: CallId('malformed-post-shape'), name: 'echo', arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: `Error: ${message}` })
  })

  it('returns an isError result when a tools/execute listener throws', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/execute', async () => { throw new Error('wrapper broke') })

    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result).toEqual({
      callId: CallId('c1'),
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
      callId: CallId('c1'),
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
      callId: CallId('c1'),
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
      callId: CallId('c1'),
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

  it.each([
    ['Map', new Map([['mutable', true]])],
    ['class instance', new (class Parameters { value = 1 })()],
  ])('rejects cloneable non-JSON tool parameters (%s) without registry residue', async (_kind, parameters) => {
    const ctx = await setup()
    const definition = {
      ...echoTool,
      name: 'invalid-parameters',
      parameters,
    } as unknown as typeof echoTool

    expect(() => ctx.tools.register(definition)).toThrow(
      'tool parameters must be losslessly JSON-serializable',
    )
    expect(ctx.tools.get('invalid-parameters')).toBeUndefined()
  })

  it('reads nested tool parameters once into the accepted snapshot', async () => {
    const ctx = await setup()
    let reads = 0
    const parameters = Object.defineProperty({}, 'properties', {
      enumerable: true,
      get: () => ++reads === 1 ? {} : new Map([['mutable', true]]),
    })

    expect(() => ctx.tools.register({
      ...echoTool,
      name: 'unstable-parameters',
      parameters,
    })).not.toThrow()
    expect(reads).toBe(1)
    expect(ctx.tools.get('unstable-parameters')?.parameters).toEqual({ properties: {} })
  })

  it('reads a top-level parameters accessor once so validation and storage use one value', async () => {
    const ctx = await setup()
    const accepted = { type: 'object', properties: { accepted: { type: 'string' } } }
    class DriftedParameters {
      readonly type = 'object'
      readonly properties = { drifted: { type: 'number' } }
    }
    let reads = 0
    const definition = { ...echoTool, name: 'top-level-parameters' }
    Object.defineProperty(definition, 'parameters', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? accepted : new DriftedParameters()
      },
    })

    ctx.tools.register(definition)

    expect(reads).toBe(1)
    expect(ctx.tools.get('top-level-parameters')?.parameters).toEqual(accepted)
  })

  it('rejects malformed fixed definition fields without freezing caller objects', async () => {
    const ctx = await setup()
    const badName = { value: 'object-name' }
    const badDescription = { value: 'object-description' }
    const badTimeout = { value: 100 }

    expect(() => ctx.tools.register({ ...echoTool, name: badName as unknown as string }))
      .toThrow('tool name must be a string')
    expect(() => ctx.tools.register({ ...echoTool, name: 'bad-description', description: badDescription as unknown as string }))
      .toThrow('description must be a string')
    expect(() => ctx.tools.register({ ...echoTool, name: 'bad-timeout', timeoutMs: badTimeout as unknown as number }))
      .toThrow('timeoutMs must be a positive finite number')
    expect(() => ctx.tools.register({ ...echoTool, name: 'zero-timeout', timeoutMs: 0 }))
      .toThrow('timeoutMs must be a positive finite number')
    expect(() => ctx.tools.register({ ...echoTool, name: 'bad-execute', execute: { bind() {} } as unknown as typeof echoTool.execute }))
      .toThrow('execute must be a function')
    expect(() => ctx.tools.register({ ...echoTool, name: 'bad-present-call', presentCall: 1 as unknown as NonNullable<ToolDefinition['presentCall']> }))
      .toThrow('presentCall must be a function')
    expect(() => ctx.tools.register({ ...echoTool, name: 'bad-present-result', presentResult: 1 as unknown as NonNullable<ToolDefinition['presentResult']> }))
      .toThrow('presentResult must be a function')
    expect(Object.isFrozen(badName)).toBe(false)
    expect(Object.isFrozen(badDescription)).toBe(false)
    expect(Object.isFrozen(badTimeout)).toBe(false)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('snapshots callbacks while preserving their registration-time method receiver', async () => {
    const ctx = await setup()
    const receivers: object[] = []
    const definition = {
      ...echoTool,
      name: 'callback-snapshot',
      async execute() {
        receivers.push(this)
        return [{ type: 'text' as const, text: 'original' }]
      },
    }
    ctx.tools.register(definition)
    definition.execute = async () => [{ type: 'text' as const, text: 'replacement' }]

    const result = await ctx.tools.execute({
      callId: CallId('callback-snapshot'), name: definition.name, arguments: {},
    })

    expect(receivers).toEqual([definition])
    expect(result.content).toEqual([{ type: 'text', text: 'original' }])
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

    await dispose()
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
    await dispose()
    expect(ctx.tools.get('echo')).toBeUndefined()
  })

  it('register() returns the EXACT effect disposer: a composite yield nests the teardown in order', async () => {
    // The registry-disposer convention (set by agents.register): the returned
    // function IS the cordis effect disposer, so a composite (generator)
    // effect that yields it has the unregistration run at that yield's LIFO
    // position on owner unload. A wrapper would leave the inner effect
    // disposing as a CONCURRENT SIBLING of the composite; the async probe
    // below (disposed first, LIFO) yields the event loop exactly like the
    // agent factory's stop-and-drain link, and a sibling unregistration fires
    // in that window — the probe would observe the tool already gone. Pins
    // the convention for the whole register-method family (system-prompt
    // registrars, registerProvider, setFactory share the same return).
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

  it('reads defineTool options once and keeps wire and runtime schemas on one detached snapshot', async () => {
    const accepted: SchemaSpec = { value: { type: 'string', required: true, enum: ['accepted'] } }
    const drifted: SchemaSpec = { count: { type: 'number', required: true } }
    const reads = {
      name: 0,
      description: 0,
      parameters: 0,
      timeoutMs: 0,
      execute: 0,
      presentCall: 0,
      presentResult: 0,
    }
    const options = {} as DefineToolOptions<SchemaSpec>
    Object.defineProperties(options, {
      name: { enumerable: true, get: () => { reads.name += 1; return reads.name === 1 ? 'accepted' : 'drifted' } },
      description: { enumerable: true, get: () => { reads.description += 1; return reads.description === 1 ? 'accepted description' : 'drifted description' } },
      parameters: { enumerable: true, get: () => { reads.parameters += 1; return reads.parameters === 1 ? accepted : drifted } },
      timeoutMs: { enumerable: true, get: () => { reads.timeoutMs += 1; return reads.timeoutMs === 1 ? 250 : 0 } },
      execute: {
        enumerable: true,
        get: () => {
          reads.execute += 1
          return (args: Record<string, unknown>) => Promise.resolve([{ type: 'text' as const, text: String(args['value']) }])
        },
      },
      presentCall: {
        enumerable: true,
        get: () => {
          reads.presentCall += 1
          return (args: Record<string, unknown>) => ({ card: 'generic' as const, title: String(args['value']) })
        },
      },
      presentResult: {
        enumerable: true,
        get: () => {
          reads.presentResult += 1
          return (args: Record<string, unknown>) => ({ card: 'generic' as const, title: String(args['value']) })
        },
      },
    })

    const tool = defineTool(options)
    accepted.value!.type = 'number'
    accepted.value!.enum!.push('mutated')

    expect(tool).toMatchObject({
      name: 'accepted',
      description: 'accepted description',
      timeoutMs: 250,
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', enum: ['accepted'] } },
        required: ['value'],
      },
    })
    await expect(tool.execute({ value: 'accepted' }, {} as ToolExecution))
      .resolves.toEqual([{ type: 'text', text: 'accepted' }])
    expect(tool.presentCall?.({ value: 'accepted' })).toEqual({ card: 'generic', title: 'accepted' })
    expect(tool.presentResult?.(
      { value: 'accepted' },
      { content: [], isError: false },
    )).toEqual({ card: 'generic', title: 'accepted' })
    expect(reads).toEqual({
      name: 1,
      description: 1,
      parameters: 1,
      timeoutMs: 1,
      execute: 1,
      presentCall: 1,
      presentResult: 1,
    })
  })

  it('rejects an exotic defineTool schema before it can be normalized for the wire', () => {
    class ExoticDefault { readonly value = 'not JSON' }

    expect(() => defineTool({
      name: 'exotic-schema',
      description: 'must reject exotic defaults',
      parameters: {
        value: { type: 'string', default: new ExoticDefault() },
      },
      execute: () => Promise.resolve([]),
    })).toThrow(/parameters must be losslessly JSON-serializable/)
  })

  it('rejects a malformed defineTool spec whose generated wire schema is not JSON', () => {
    expect(() => defineTool({
      name: 'malformed-schema',
      description: 'missing property type',
      parameters: { value: {} } as unknown as SchemaSpec,
      execute: () => Promise.resolve([]),
    })).toThrow(/generated parameters must be losslessly JSON-serializable/)
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
    // no 'required' key in the nested object because nothing is required
    const config = jsonSchema.properties['config'] as Record<string, unknown>
    expect('required' in config).toBe(false)
  })
})

describe('schema DSL regressions (Codex review round 2)', () => {
  it('InferArgs makes non-required keys genuinely optional (omittable)', () => {
    type Args = InferArgs<{
      path: { type: 'string'; required: true }
      limit: { type: 'number' }
    }>
    expectTypeOf<Args>().toEqualTypeOf<{ path: string; limit?: number }>()
    // omitting the optional key is assignable — the actual regression
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
    expect(result).toEqual({ callId: CallId('c1'), content: [{ type: 'text', text: 'read /x' }], isError: false })
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
