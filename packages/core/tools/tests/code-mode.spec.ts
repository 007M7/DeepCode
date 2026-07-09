import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import ToolRegistry, { CodeRunFailedError, RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import type { Config, PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'

/**
 * Code Mode unit tier (per the RFC's plan): provider contribution per mode,
 * misconfiguration rejections, the run_code dispatch bridge (serialization,
 * abort, JSON normalization, error mapping, events, quiescence), and HMR
 * safety — all against an in-repo fake runtime, exactly the
 * interface/implementation/consumer shape the seam promises.
 */

/** A scriptable in-repo CodeRuntime: each test sets `behavior` to drive the bindings however it needs. */
class FakeRuntime extends CodeRuntime {
  readonly language: string
  readonly isolation = 'fake'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })
  lastRequest?: CodeRunRequest

  constructor(ctx: Context, config: { language?: string } = {}) {
    super(ctx)
    this.language = config.language ?? 'typescript'
  }

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    this.lastRequest = request
    return this.behavior(request)
  }
}

interface SetupOptions {
  mode?: Config['mode']
  runtime?: false | { language?: string }
  toolOrder?: string[]
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { ...options.toolOrder ? { toolOrder: options.toolOrder } : {} })
  await ctx.plugin(ToolRegistry, { mode: options.mode ?? 'code' })
  let runtime: FakeRuntime | undefined
  if (options.runtime !== false) {
    await ctx.plugin(FakeRuntime, options.runtime ?? {})
    runtime = ctx.codeRuntime as FakeRuntime
  }
  return { ctx, tools: ctx.tools, systemPrompt: ctx.systemPrompt, runtime: runtime! }
}

/** Register a trivial echo tool; returns the calls it received. */
function registerEcho(ctx: Context, name = 'echo'): unknown[] {
  const calls: unknown[] = []
  ctx.tools.register(defineTool({
    name,
    description: `Echo tool ${name}.`,
    parameters: { value: { type: 'string', required: true } },
    execute(args) {
      calls.push(args)
      return Promise.resolve([{ type: 'text' as const, text: `${name}:${args.value}` }])
    },
  }))
  return calls
}

/** A structural fake of the owning agent: captures session appends. */
function fakeAgent(): { agent: Agent; events: { type: string; data: unknown }[] } {
  const events: { type: string; data: unknown }[] = []
  const agent = {
    session: {
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
  return { agent, events }
}

/** Dispatch run_code through the registry pipeline, as the loop would. */
async function runCode(ctx: Context, code: string, extras: { agent?: Agent; signal?: AbortSignal } = {}): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: CallId('call-1'),
    name: RUN_CODE_NAME,
    arguments: { code },
    ...extras.agent ? { agent: extras.agent } : {},
    ...extras.signal ? { signal: extras.signal } : {},
  })
}

describe('mode-aware wire contribution', () => {
  it("mode 'native' contributes every schema, no run_code, no SDK section — and needs no runtime", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'native', runtime: false })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
  })

  it("mode 'code' contributes exactly [run_code] plus the SDK section declaring the other tools", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'code' })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')
    expect(sdk?.text).toContain('declare const tools: {')
    expect(sdk?.text).toContain('echo(args:')
    expect(sdk?.text).not.toContain('run_code(args:')
  })

  it("mode 'both' contributes every native schema plus run_code, and the SDK section", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'both' })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo', RUN_CODE_NAME])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(true)
  })

  it("never exposes run_code to programs, even under mode 'both' (no recursive dispatch path)", async () => {
    const { ctx, runtime } = await setup({ mode: 'both' })
    registerEcho(ctx)
    runtime.behavior = (request) => {
      const functions = request.bindings[0]!.functions
      return Promise.resolve({
        logs: [],
        value: JSON.stringify({
          names: Object.keys(functions).sort(),
          // Own-property AND prototype-chain reads both come back empty —
          // there is no handle a program could re-enter run_code through.
          runCode: String(functions[RUN_CODE_NAME]),
        }),
      })
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ names: ['echo'], runCode: 'undefined' })
  })

  it('renders byte-identical SDK text across consecutive assemblies of an unchanged tool set', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'code' })
    registerEcho(ctx)
    const first = await systemPrompt.assemble()
    const second = await systemPrompt.assemble()
    const text = (assembly: typeof first) => assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(text(first)).toBe(text(second))
  })

  it('rejects every assembly when a non-native mode has no code runtime', async () => {
    const { systemPrompt } = await setup({ mode: 'code', runtime: false })
    await expect(systemPrompt.assemble()).rejects.toThrow(/requires a code runtime/)
  })

  it("rejects every assembly when the runtime's language is not typescript", async () => {
    const { systemPrompt } = await setup({ mode: 'code', runtime: { language: 'python' } })
    await expect(systemPrompt.assemble()).rejects.toThrow(/language is "python"/)
  })

  it("rejects the assembly when toolOrder names a native tool that mode 'code' no longer contributes", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'code', toolOrder: ['echo', '<unlisted-tools>'] })
    registerEcho(ctx)
    await expect(systemPrompt.assemble()).rejects.toThrow(/toolOrder lists unregistered tool "echo"/)
  })

  it('removes run_code and the SDK section when the registry fiber disposes (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(FakeRuntime, {})
    const fiber = await ctx.plugin(ToolRegistry, { mode: 'code' })
    expect(ctx.tools.get(RUN_CODE_NAME)).toBeDefined()
    await fiber.dispose()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools).toEqual([])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
  })
})

describe('the run_code dispatch bridge', () => {
  it('bridges tool calls, returns only the curated output, and logs one event per dispatch', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const calls = registerEcho(ctx)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const first = await tools.echo!({ value: 'one' })
      const second = await tools.echo!({ value: 'two' })
      return { logs: [{ source: 'console', level: 'log', text: `saw ${String(first)}` }], value: second }
    }
    const result = await runCode(ctx, 'const …: string = …', { agent })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'saw echo:one\necho:two' }])
    expect(calls).toEqual([{ value: 'one' }, { value: 'two' }])
    const dispatches = events.filter(event => event.type === 'tool/code-dispatch')
    expect(dispatches.map(event => event.data)).toEqual([
      { parentCallId: 'call-1', subCallId: 'call-1:code:1', name: 'echo', arguments: { value: 'one' }, isError: false, resultSummary: 'echo:one' },
      { parentCallId: 'call-1', subCallId: 'call-1:code:2', name: 'echo', arguments: { value: 'two' }, isError: false, resultSummary: 'echo:two' },
    ])
    expect(result.meta).toEqual({ logs: [{ source: 'console', level: 'log', text: 'saw echo:one' }], dispatches: 2 })
  })

  it('serializes Promise.all dispatches: tool executions never overlap, in submission order', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const intervals: [string, string][] = []
    let active = 0
    ctx.tools.register(defineTool({
      name: 'probe',
      description: 'Records execution overlap.',
      parameters: { id: { type: 'string', required: true } },
      async execute(args) {
        active++
        expect(active, 'probe executions overlapped').toBe(1)
        intervals.push(['enter', args.id])
        await new Promise(resolve => setTimeout(resolve, 20))
        intervals.push(['exit', args.id])
        active--
        return [{ type: 'text' as const, text: args.id }]
      },
    }))
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const values = await Promise.all([tools.probe!({ id: 'a' }), tools.probe!({ id: 'b' }), tools.probe!({ id: 'c' })])
      return { logs: [], value: values.join(',') }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(intervals).toEqual([
      ['enter', 'a'], ['exit', 'a'],
      ['enter', 'b'], ['exit', 'b'],
      ['enter', 'c'], ['exit', 'c'],
    ])
    expect(result.content[0]).toEqual({ type: 'text', text: 'a,b,c' })
  })

  it('rejects the program-side call when the tool errors, with the tool error text', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    ctx.tools.register(defineTool({
      name: 'fail',
      description: 'Always fails.',
      parameters: {},
      execute(): Promise<never> { return Promise.reject(new Error('deliberate failure')) },
    }))
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions.fail!({})
        return { logs: [], value: 'unreachable' }
      } catch (error: unknown) {
        return { logs: [], value: `caught: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const result = await runCode(ctx, 'program')
    expect(result.content[0]).toEqual({ type: 'text', text: 'caught: Error: deliberate failure' })
  })

  it('a tools/pre-execute deny reaches the program as a binding rejection', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    registerEcho(ctx)
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'echo') return Promise.resolve({ kind: 'deny' as const, reason: 'not on my watch' })
      return next()
    })
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions.echo!({ value: 'x' })
        return { logs: [], value: 'unreachable' }
      } catch (error: unknown) {
        return { logs: [], value: `denied: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const result = await runCode(ctx, 'program')
    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('not on my watch')
  })

  it('rejects a binding argument that does not survive JSON normalization, dispatching nothing', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const calls = registerEcho(ctx)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions.echo!({ value: 'x', big: 1n })
        return { logs: [], value: 'unreachable' }
      } catch (error: unknown) {
        return { logs: [], value: error instanceof Error ? error.message : String(error) }
      }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect((result.content[0] as { text: string }).text).toContain('JSON-serializable')
    expect(calls).toEqual([])
    expect(events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })

  it('dispatches the JSON-normalized value: what the tool sees is what the event logs', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const calls = registerEcho(ctx)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      // A Date survives structured clone but is not JSON; the bridge
      // normalizes it to its JSON form (an ISO string) BEFORE dispatch.
      await request.bindings[0]!.functions.echo!({ value: 'x', when: new Date(0) }).catch(() => undefined)
      return { logs: [] }
    }
    await runCode(ctx, 'program', { agent })
    expect(calls).toEqual([{ value: 'x', when: '1970-01-01T00:00:00.000Z' }])
    const dispatch = events.find(event => event.type === 'tool/code-dispatch')?.data as SessionEventMap['tool/code-dispatch']
    expect(dispatch.arguments).toEqual({ value: 'x', when: '1970-01-01T00:00:00.000Z' })
  })

  it('suppresses sub-call additionalContext (deliberately; pinned)', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    registerEcho(ctx)
    ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name === 'echo') {
        return Promise.resolve({
          kind: 'accept' as const,
          additionalContext: { content: [{ type: 'text' as const, text: 'context for the next request' }], source: { kind: 'plugin' as const, plugin: 'test' } },
        })
      }
      return next()
    })
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'x' })
      return { logs: [], value: 'done' }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    // The sub-call's context has no safe outlet mid-run; the parent result
    // must not carry it either.
    expect(result.additionalContext).toBeUndefined()
  })

  it('converts a failed run into a structured isError result carrying kind, message, and captured logs', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    runtime.behavior = () => Promise.resolve({
      logs: [{ source: 'console', level: 'log', text: 'got this far' }],
      error: { kind: 'timeout', message: 'compute budget exhausted (300ms busy)' },
    })
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({ name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('code run failed (timeout)')
    expect(text).toContain('compute budget exhausted')
    expect(text).toContain('got this far')
  })

  it('CodeRunFailedError is a HarnessError with the CODE_RUN_FAILED code', () => {
    const error = new CodeRunFailedError('boom')
    expect(error.code).toBe('CODE_RUN_FAILED')
    expect(error.name).toBe('CodeRunFailedError')
  })

  it('aborting the outer signal aborts the in-flight sub-dispatch and abandons queued ones', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const seen: string[] = []
    let sawAbort = false
    ctx.tools.register(defineTool({
      name: 'slow',
      description: 'Slow tool observing its signal.',
      parameters: { id: { type: 'string', required: true } },
      async execute(args, exec) {
        seen.push(args.id)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500)
          exec.signal?.addEventListener('abort', () => { sawAbort = true; clearTimeout(timer); resolve() }, { once: true })
        })
        return [{ type: 'text' as const, text: args.id }]
      },
    }))
    const controller = new AbortController()
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const calls = [tools.slow!({ id: 'first' }).catch(() => 'rejected'), tools.slow!({ id: 'second' }).catch(() => 'rejected')]
      setTimeout(() => { controller.abort('user-cancel') }, 50)
      await Promise.all(calls)
      // A real runtime would be terminated by the abort; the fake honors the
      // contract by reporting the abort as the run failure.
      return { logs: [], error: { kind: 'abort', message: 'user-cancel' } }
    }
    const result = await runCode(ctx, 'program', { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('code run failed (abort)')
    expect(seen).toEqual(['first'])
    expect(sawAbort).toBe(true)
  })

  it('a runtime that starts a binding call and then REJECTS still reaches quiescence before returning', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const { agent, events } = fakeAgent()
    let sawAbort = false
    let started!: () => void
    const inFlight = new Promise<void>((resolve) => { started = resolve })
    ctx.tools.register(defineTool({
      name: 'slow',
      description: 'Slow tool observing its signal.',
      parameters: { id: { type: 'string', required: true } },
      async execute(args, exec) {
        started()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500)
          exec.signal?.addEventListener('abort', () => { sawAbort = true; clearTimeout(timer); resolve() }, { once: true })
        })
        return [{ type: 'text' as const, text: args.id }]
      },
    }))
    runtime.behavior = async (request) => {
      // Start a sub-dispatch, keep its rejection held, and fail the run once
      // the tool is genuinely in flight — a seam error AFTER work has begun.
      // The bridge's settlement still owes quiescence: without the finally,
      // run_code would return now and the slow tool would finish (and log)
      // afterwards.
      request.bindings[0]!.functions.slow!({ id: 'orphan' }).catch(() => 'held')
      await inFlight
      throw new Error('backend exploded')
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('backend exploded')
    // Quiescence held: the in-flight sub-dispatch was aborted and its event
    // logged INSIDE the run_code execution, not after it returned.
    expect(sawAbort).toBe(true)
    expect(events.filter(event => event.type === 'tool/code-dispatch').map(event => (event.data as { name: string }).name)).toEqual(['slow'])
  })

  it('runs without an owning agent: dispatches work, event logging is skipped', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const calls = registerEcho(ctx)
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'x' })
      return { logs: [], value: 'ok' }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(calls).toEqual([{ value: 'x' }])
  })

  it('executing run_code under a missing runtime is a structured isError, not a crash', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRegistry, { mode: 'code' })
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('requires a code runtime')
  })

  it('presents the PROGRAM as the execute-card title on both call and result (the one slot execute cards always show)', async () => {
    const { ctx } = await setup({ mode: 'code' })
    const tool = ctx.tools.get(RUN_CODE_NAME)!
    // The program IS the title, mirroring how command tools title their cards
    // with the command: an ACP client's execute-card header is the only
    // always-visible slot (Zed renders no body content and no raw input for
    // execute-kind cards without a real terminal).
    expect(tool.presentCall?.({ code: 'return 1' })).toEqual({
      card: 'generic',
      title: 'return 1',
      kind: 'execute',
      rawInput: 'return 1',
    })
    const view = tool.presentResult?.({ code: 'return 1' }, {
      content: [{ type: 'text', text: 'model-facing' }],
      isError: false,
      meta: { logs: [{ source: 'console', level: 'log', text: 'printed' }], dispatches: 1 },
    })
    // The result omits the title — an update replaces only provided fields,
    // so the pending card's program title persists through completion.
    expect(view).toEqual({
      card: 'generic',
      content: [{ type: 'text', text: 'printed' }],
    })
    // No captured output → no content either; everything pending persists.
    expect(tool.presentResult?.({ code: 'x' }, { content: [], isError: false, meta: { logs: [], dispatches: 2 } }))
      .toEqual({ card: 'generic' })
    // Replay with an unrecognizable meta falls back to the generic rendering.
    expect(tool.presentResult?.({ code: 'x' }, { content: [], isError: false, meta: { other: true } })).toBeUndefined()
    expect(tool.presentResult?.({ code: 'x' }, { content: [], isError: false })).toBeUndefined()
  })

  it('renders non-text sub-result blocks as placeholders and truncates long event summaries', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const { agent, events } = fakeAgent()
    const long = 'x'.repeat(300)
    ctx.tools.register(defineTool({
      name: 'mixed',
      description: 'Returns mixed content.',
      parameters: {},
      execute() {
        return Promise.resolve([
          { type: 'text' as const, text: long },
          { type: 'reasoning' as const, text: 'hidden' },
        ])
      },
    }))
    runtime.behavior = async (request) => {
      const value = await request.bindings[0]!.functions.mixed!({})
      return { logs: [], value }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text).toBe(`${long}\n[reasoning content]`)
    const dispatch = events.find(event => event.type === 'tool/code-dispatch')?.data as SessionEventMap['tool/code-dispatch']
    expect(dispatch.resultSummary.length).toBe(201)
    expect(dispatch.resultSummary.endsWith('…')).toBe(true)
  })

  it('rejects undefined, JSON-throwing, and JSON-unrepresentable binding arguments BEFORE dispatch', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const calls = registerEcho(ctx)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      const echo = request.bindings[0]!.functions.echo!
      const catchMessage = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
      return {
        logs: [],
        value: [
          // Root undefined must reject up front: the event log rejects it as
          // data, and nothing may execute unlogged.
          await catchMessage(echo(undefined)),
          // A toJSON that throws a NON-Error propagates out of JSON.stringify.
          await catchMessage(echo({ toJSON() { throw 'raw-throw' } })),
          // A bare function is a value JSON cannot represent at all.
          await catchMessage(echo(() => 1)),
        ].join(' | '),
      }
    }
    const result = await runCode(ctx, 'program', { agent })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('call the tool with an arguments object')
    expect(text).toContain('JSON-serializable: raw-throw')
    expect(text).toContain('a value JSON cannot represent')
    // None of the three dispatched, none logged.
    expect(calls).toEqual([])
    expect(events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })

  it('logs the value the tool RECEIVED even when the tool mutates its arguments', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const { agent, events } = fakeAgent()
    ctx.tools.register(defineTool({
      name: 'mutator',
      description: 'Mutates its own args object.',
      parameters: { list: { type: 'array', required: true } },
      execute(args) {
        args.list.push('injected-by-tool')
        return Promise.resolve([{ type: 'text' as const, text: 'mutated' }])
      },
    }))
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.mutator!({ list: ['original'] })
      return { logs: [] }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    const dispatch = events.find(event => event.type === 'tool/code-dispatch')?.data as SessionEventMap['tool/code-dispatch']
    expect(dispatch.arguments).toEqual({ list: ['original'] })
  })

  it('exposes a tool named __proto__ as an ordinary own binding', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    ctx.tools.register(defineTool({
      name: '__proto__',
      description: 'A prototype-colliding tool name.',
      parameters: {},
      execute() { return Promise.resolve([{ type: 'text' as const, text: 'proto-tool-ok' }]) },
    }))
    runtime.behavior = async (request) => {
      const functions = request.bindings[0]!.functions
      expect(Object.getPrototypeOf(functions)).toBeNull()
      const value = await functions['__proto__']!({})
      return { logs: [], value }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'proto-tool-ok' })
  })

  it('renders a non-string completion value inspect-style', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: { n: 42 } })
    const result = await runCode(ctx, 'program')
    expect((result.content[0] as { text: string }).text).toBe('{ n: 42 }')
  })

  it('reports a pre-aborted outer signal as the run failure without dispatching anything', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const calls = registerEcho(ctx)
    runtime.behavior = (request) => {
      // The fake honors the seam contract for an already-aborted signal.
      if (request.signal?.aborted) return Promise.resolve({ logs: [], error: { kind: 'abort' as const, message: String(request.signal.reason) } })
      return Promise.resolve({ logs: [], value: 'unreachable' })
    }
    const controller = new AbortController()
    controller.abort('too-late')
    const result = await runCode(ctx, 'program', { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('code run failed (abort)')
    expect(calls).toEqual([])
  })

  it('rejects a binding invoked after the run is over without dispatching it', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const calls = registerEcho(ctx)
    const controller = new AbortController()
    runtime.behavior = async (request) => {
      controller.abort('cancelled-mid-run')
      const message = await request.bindings[0]!.functions.echo!({ value: 'x' })
        .then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
      return { logs: [], value: message }
    }
    const result = await runCode(ctx, 'program', { signal: controller.signal })
    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('not dispatched')
    expect(calls).toEqual([])
  })

  it('a tool/code-dispatch event never derives a model message', () => {
    const session = new Session(SessionId('code-mode-derive'))
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('tool/code-dispatch', {
      parentCallId: CallId('p1'),
      subCallId: CallId('p1:code:1'),
      name: 'echo',
      arguments: { value: 'x' },
      isError: false,
      resultSummary: 'echo:x',
    })
    const derived = session.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]?.role).toBe('user')
  })

  it('defaults to native mode under direct construction with no config', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const registry = new ToolRegistry(ctx)
    expect(registry.get(RUN_CODE_NAME)).toBeUndefined()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
  })
})
