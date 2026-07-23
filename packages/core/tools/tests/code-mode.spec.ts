import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import ToolRegistry, { CodeRunFailedError, RUN_CODE_NAME, TOOL_ABORTED_BEFORE_DISPATCH, defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import type { Config, JsonSchemaNode, PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue, SessionEventMap } from '@deepseek-ai/dsh-session'

const testToolSignal = new AbortController().signal

/**
 * Code Mode unit tier (per the Agent Note's plan): provider contribution per mode,
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

/** Mint one production-shaped agent scope that can register scoped tool policy. */
async function mintAgentScope(ctx: Context, name = 'scoped'): Promise<{ scope: Scope; agent: Agent }> {
  const agent = { id: SessionId(name) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] }))
  return { scope, agent }
}

/** Register a trivial echo tool; returns the calls it received. */
function registerEcho(ctx: Context, name = 'echo'): unknown[] {
  const calls: unknown[] = []
  ctx.tools.register(defineTool({
    name,
    description: `Echo tool ${name}.`,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      calls.push(args)
      return Promise.resolve(`${name}:${args.value}`)
    },
  }))
  return calls
}

/** A structural fake of the owning agent: captures session appends. */
function fakeAgent(options: { cwd?: string } = { cwd: '/workspace' }): { agent: Agent; events: { type: string; data: unknown }[] } {
  const events: { type: string; data: unknown }[] = []
  const agent = {
    session: {
      header: options.cwd === undefined ? {} : { cwd: options.cwd },
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
  return { agent, events }
}

/** Dispatch run_code through the registry pipeline, as the loop would. */
async function runCode(ctx: Context, code: string, extras: { agent?: Agent; signal?: AbortSignal } = {}): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
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
    expect(sdk?.text).toContain('echo: {')
    expect(sdk?.text).not.toContain('run_code:')
  })

  it('projects deeply nested output schemas into the Code Mode SDK without structured-clone recursion', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'code' })
    let output: JsonSchemaNode = { type: 'string' }
    for (let depth = 0; depth < 5_000; depth++) {
      output = { oneOf: [output, { type: 'null' }] }
    }
    ctx.tools.register({
      name: 'deep_output',
      description: 'Return a deeply nested output union.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: output,
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : 'null' }],
      },
      execute() { return Promise.resolve('ok') },
    })

    const assembly = await systemPrompt.assemble()
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text

    expect(sdk).toContain('deep_output: Record<string, JsonValue>;')
    expect(sdk).toContain('deep_output: string | null')
  })

  it.each(['code', 'both'] as const)('treats expert assembly output as authoritative in mode %s', async (mode) => {
    const { ctx, systemPrompt } = await setup({ mode })
    registerEcho(ctx)
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return {
        ...assembly,
        sections: assembly.sections.filter(section => section.name !== 'tools:sdk'),
        tools: assembly.tools.filter(tool => tool.name !== RUN_CODE_NAME),
      }
    }, { prepend: true })

    const assembly = await systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
    expect(assembly.tools.some(tool => tool.name === RUN_CODE_NAME)).toBe(false)
  })

  it.each(['code', 'both'] as const)('lets one scope shadow the default SDK section in mode %s', async (mode) => {
    const { ctx, systemPrompt } = await setup({ mode })
    registerEcho(ctx)
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.systemPrompt.section({ name: 'tools:sdk', order: 150, text: 'SCOPED SDK' })

    const scoped = await systemPrompt.assemble({ scope: agent })
    const global = await systemPrompt.assemble()
    expect(scoped.sections.find(section => section.name === 'tools:sdk')?.text).toBe('SCOPED SDK')
    expect(global.sections.find(section => section.name === 'tools:sdk')?.text).toContain('declare const tools:')
  })

  it("mode 'both' contributes every native schema plus run_code, and the SDK section", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'both' })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo', RUN_CODE_NAME])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(true)
  })

  it.each(['code', 'both'] as const)('keeps the run_code transport outside scoped allow-list filtering in mode %s', async (mode) => {
    const { ctx, systemPrompt, runtime } = await setup({ mode })
    registerEcho(ctx, 'echo')
    registerEcho(ctx, 'hidden')
    const { scope, agent } = await mintAgentScope(ctx)
    const lift = scope.ctx.tools.restrict({ allow: ['echo'] })

    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(mode === 'code'
      ? [RUN_CODE_NAME]
      : ['echo', RUN_CODE_NAME])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).toContain('echo: {')
    expect(sdk).not.toContain('hidden:')

    runtime.behavior = request => Promise.resolve({
      logs: [],
      value: Object.keys(request.bindings[0]!.functions).sort().join(','),
    })
    const result = await runCode(ctx, 'return Object.keys(tools)', { agent })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'echo' }])

    lift()
    const unrestricted = await systemPrompt.assemble({ scope: agent })
    expect(unrestricted.tools.map(tool => tool.name)).toEqual(mode === 'code'
      ? [RUN_CODE_NAME]
      : ['echo', 'hidden', RUN_CODE_NAME])
  })

  it.each(['code', 'both'] as const)('keeps the run_code transport outside scoped deny-list filtering in mode %s', async (mode) => {
    const { ctx, systemPrompt, runtime } = await setup({ mode })
    registerEcho(ctx, 'denied')
    registerEcho(ctx, 'kept')
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.tools.restrict({ deny: ['denied'] })

    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(mode === 'code'
      ? [RUN_CODE_NAME]
      : ['kept', RUN_CODE_NAME])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).not.toContain('denied:')
    expect(sdk).toContain('kept: {')

    runtime.behavior = request => Promise.resolve({
      logs: [],
      value: Object.keys(request.bindings[0]!.functions).sort().join(','),
    })
    const result = await runCode(ctx, 'return Object.keys(tools)', { agent })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'kept' }])
  })

  it.each(['code', 'both'] as const)('reserves run_code against scoped shadows and explicit restrictions in mode %s', async (mode) => {
    const { ctx, systemPrompt } = await setup({ mode })
    const { scope, agent } = await mintAgentScope(ctx)
    const impostor = defineContentToolFixture({
      name: RUN_CODE_NAME,
      description: 'Scoped impostor.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text' as const, text: 'impostor' }]),
    })

    expect(() => scope.ctx.tools.register(impostor)).toThrow(/reserved for the Code Mode presentation transport/)
    expect(() => ctx.tools.register(impostor)).toThrow(/reserved for the Code Mode presentation transport/)
    expect(() => scope.ctx.tools.restrict({ allow: [RUN_CODE_NAME] })).toThrow(/cannot name reserved Code Mode presentation transport/)
    expect(() => scope.ctx.tools.restrict({ deny: [RUN_CODE_NAME] })).toThrow(/cannot name reserved Code Mode presentation transport/)
    scope.ctx.systemPrompt.section({ name: 'scoped-note', order: 149, text: 'safe note' })
    scope.ctx.tools.register(defineContentToolFixture({
      name: 'scoped_safe',
      description: 'Safe scoped tool.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text' as const, text: 'safe' }]),
    }))

    const assembly = await systemPrompt.assemble({ scope: agent })
    const transports = assembly.tools.filter(tool => tool.name === RUN_CODE_NAME)
    expect(transports).toHaveLength(1)
    expect(transports[0]?.description).toContain('Execute a TypeScript program')
    expect(assembly.sections.find(section => section.name === 'scoped-note')?.text).toBe('safe note')
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain('scoped_safe:')
    expect(ctx.tools.get(RUN_CODE_NAME, agent)).toBe(ctx.tools.get(RUN_CODE_NAME))
    const result = await runCode(ctx, 'return 1', { agent })
    expect(result.content).toEqual([{ type: 'text', text: '(run_code completed with no output)' }])
  })

  it.each(['code', 'both'] as const)('keeps run_code in the toolOrder universe without exposing it as a restriction target in mode %s', async (mode) => {
    const { ctx, systemPrompt } = await setup({
      mode,
      toolOrder: [RUN_CODE_NAME, '<unlisted-tools>'],
    })
    registerEcho(ctx)
    const { agent } = await mintAgentScope(ctx)

    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(mode === 'code'
      ? [RUN_CODE_NAME]
      : [RUN_CODE_NAME, 'echo'])
  })

  it("never exposes run_code to programs, even under mode 'both' (no recursive dispatch path)", async () => {
    const { ctx, runtime } = await setup({ mode: 'both' })
    registerEcho(ctx)
    runtime.behavior = (request) => {
      expect(request.bindings[0]!.errorClass).toEqual({
        name: 'ToolCallError',
        memberNameProperty: 'toolName',
      })
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
      if (typeof first !== 'string' || typeof second !== 'string') throw new Error('echo returned a non-string')
      return { logs: [`saw ${first}`], value: second }
    }
    const result = await runCode(ctx, 'const …: string = …', { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected run_code success')
    expect(result.value).toEqual({ logs: ['saw echo:one'], result: 'echo:two' })
    expect(result.content).toEqual([{ type: 'text', text: 'saw echo:one\necho:two' }])
    expect(calls).toEqual([{ value: 'one' }, { value: 'two' }])
    const dispatches = events.filter(event => event.type === 'tool/code-dispatch')
    expect(dispatches.map(event => event.data)).toEqual([
      { parentCallId: 'call-1', subCallId: 'call-1:code:1', name: 'echo', arguments: { value: 'one' }, isError: false, resultSummary: 'echo:one' },
      { parentCallId: 'call-1', subCallId: 'call-1:code:2', name: 'echo', arguments: { value: 'two' }, isError: false, resultSummary: 'echo:two' },
    ])
    expect(result.meta).toBeUndefined()
  })

  it('exposes only an opaque parent token to nested result observers', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    registerEcho(ctx)
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'nested' })
      return { logs: [], value: 'done' }
    }

    // Freeze the nested observer's parent correlation. If that were the live
    // outer execution object, the timeout-style wrapper could not restore it.
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name !== RUN_CODE_NAME) return next()
      const previous = exec.signal
      exec.signal = new AbortController().signal
      const result = await next()
      exec.signal = previous
      return result
    })
    ctx.on('tools/result', (exec) => {
      if (exec.parent !== undefined) Object.freeze(exec.parent)
    })

    const result = await runCode(ctx, 'await tools.echo({ value: "nested" })')
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'done' }])
  })

  it('serializes Promise.all dispatches: tool executions never overlap, in submission order', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const intervals: [string, string][] = []
    let active = 0
    ctx.tools.register(defineTool({
      name: 'probe',
      description: 'Records execution overlap.',
      parameters: { id: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        active++
        expect(active, 'probe executions overlapped').toBe(1)
        intervals.push(['enter', args.id])
        await new Promise(resolve => setTimeout(resolve, 20))
        intervals.push(['exit', args.id])
        active--
        return args.id
      },
    }))
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const values = await Promise.all([tools.probe!({ id: 'a' }), tools.probe!({ id: 'b' }), tools.probe!({ id: 'c' })])
      if (!values.every(value => typeof value === 'string')) throw new Error('probe returned a non-string')
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
    ctx.tools.register(defineContentToolFixture({
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
    expect(result.content[0]).toEqual({ type: 'text', text: 'caught: deliberate failure' })
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

  it('rejects a binding argument that is not lossless JSON, dispatching nothing', async () => {
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
    expect((result.content[0] as { text: string }).text).toContain('lossless JSON')
    expect(calls).toEqual([])
    expect(events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })

  it('dispatches and logs independent snapshots of the same lossless JSON value', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const calls = registerEcho(ctx)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      const args = Object.assign(Object.create(null) as Record<string, unknown>, { value: 'x', nested: ['same'] })
      await request.bindings[0]!.functions.echo!(args)
      return { logs: [] }
    }
    await runCode(ctx, 'program', { agent })
    expect(calls).toEqual([{ value: 'x', nested: ['same'] }])
    const dispatch = events.find(event => event.type === 'tool/code-dispatch')?.data as SessionEventMap['tool/code-dispatch']
    expect(dispatch.arguments).toEqual({ value: 'x', nested: ['same'] })
  })

  it('defers sub-call additionalContexts onto the outer run_code result', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    registerEcho(ctx)
    ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name === 'echo') {
        return Promise.resolve({
          kind: 'accept' as const,
          additionalContexts: [{
            content: [{ type: 'text' as const, text: `context for ${exec.callId}` }],
            source: { kind: 'plugin' as const, plugin: 'test' },
            meta: { callId: exec.callId },
          }],
        })
      }
      return next()
    })
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'x' })
      await request.bindings[0]!.functions.echo!({ value: 'y' })
      return { logs: [], value: 'done' }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(result.additionalContexts).toEqual([
      {
        content: [{ type: 'text', text: 'context for call-1:code:1' }],
        source: { kind: 'plugin', plugin: 'test' },
        meta: { callId: 'call-1:code:1' },
      },
      {
        content: [{ type: 'text', text: 'context for call-1:code:2' }],
        source: { kind: 'plugin', plugin: 'test' },
        meta: { callId: 'call-1:code:2' },
      },
    ])
  })

  it('keeps sub-call contexts when run_code fails after the nested dispatch', async () => {
    const { ctx, runtime } = await setup({ mode: 'both' })
    registerEcho(ctx)
    ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name !== 'echo') return next()
      return Promise.resolve({
        kind: 'accept',
        additionalContexts: [{
          content: [{ type: 'text', text: 'nested context' }],
          source: { kind: 'plugin', plugin: 'test' },
        }],
      })
    })
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'x' })
      return { logs: [], error: { kind: 'exception', message: 'program failed later' } }
    }

    const result = await runCode(ctx, 'program')

    expect(result.isError).toBe(true)
    expect(result.additionalContexts).toEqual([{
      content: [{ type: 'text', text: 'nested context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }])
  })

  it('converts a failed run into a structured isError result carrying kind, message, and captured logs', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    runtime.behavior = () => Promise.resolve({
      logs: ['got this far'],
      error: { kind: 'timeout', message: 'compute budget exhausted (300ms busy)' },
    })
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' } })
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
    ctx.tools.register(defineContentToolFixture({
      name: 'slow',
      description: 'Slow tool observing its signal.',
      parameters: { id: { type: 'string', required: true } },
      async execute(args, exec) {
        seen.push(args.id)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500)
          exec.signal.addEventListener('abort', () => { sawAbort = true; clearTimeout(timer); resolve() }, { once: true })
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
    ctx.tools.register(defineContentToolFixture({
      name: 'slow',
      description: 'Slow tool observing its signal.',
      parameters: { id: { type: 'string', required: true } },
      async execute(args, exec) {
        started()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500)
          exec.signal.addEventListener('abort', () => { sawAbort = true; clearTimeout(timer); resolve() }, { once: true })
        })
        return [{ type: 'text' as const, text: args.id }]
      },
    }))
    runtime.behavior = async (request) => {
      // Start a sub-dispatch, keep its rejection held, and fail the run once the tool is
      // genuinely in flight — a seam error after work has begun.
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

  it('presents the program as the execute-card title', async () => {
    const { ctx } = await setup({ mode: 'code' })
    const tool = ctx.tools.get(RUN_CODE_NAME)!
    // The program is the title, mirroring how command tools label their cards
    // with the command while retaining the same value in the expanded input.
    expect(tool.presentCall?.({ code: 'return 1' })).toEqual({
      card: 'generic',
      title: 'return 1',
      kind: 'execute',
      rawInput: 'return 1',
    })
  })

  it.each([
    ['logs only', { logs: ['printed'] }, 'printed'],
    ['result only', { logs: [], value: 'returned' }, 'returned'],
    ['logs plus result', { logs: ['printed'], value: 'returned' }, 'printed\nreturned'],
    ['no output', { logs: [] }, '(run_code completed with no output)'],
  ] as [string, CodeRunResult, string][])('keeps %s in durable content without a result presenter', async (_name, output, text) => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    runtime.behavior = () => Promise.resolve(output)

    const result = await runCode(ctx, 'return 1')
    const tool = ctx.tools.get(RUN_CODE_NAME)!

    expect(result.content).toEqual([{ type: 'text', text }])
    // Surfaces keep the pending program title and render this durable content
    // through their generic fallback. Omitting a result view also prevents the
    // host frame from carrying the same raw content a second time.
    expect('presentResult' in tool).toBe(false)
  })

  it('keeps a post-policy spill preview in durable content without a result presenter', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const preview = 'HEAD\n\n(Omitted 100 bytes. Full formatted result stored at: /tmp/run-code.txt.)\n\nTAIL'
    runtime.behavior = () => Promise.resolve({ logs: ['printed'], value: 'returned' })
    ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name !== RUN_CODE_NAME) return next()
      return Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: preview }] })
    })

    const result = await runCode(ctx, 'return 1')
    const tool = ctx.tools.get(RUN_CODE_NAME)!

    expect(result.content).toEqual([{ type: 'text', text: preview }])
    expect('presentResult' in tool).toBe(false)
  })

  it('keeps canonical failure content durable without a result presenter', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    runtime.behavior = () => Promise.resolve({
      logs: ['captured before failure'],
      error: { kind: 'output-limit', message: 'outer output exceeded 8 bytes' },
    })

    const result = await runCode(ctx, 'return 1')
    const tool = ctx.tools.get(RUN_CODE_NAME)!

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Error: code run failed (output-limit): outer output exceeded 8 bytes\nCaptured output:\ncaptured before failure',
    }])
    expect('presentResult' in tool).toBe(false)
  })

  it('renders non-text sub-result blocks as placeholders and truncates long event summaries', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const { agent, events } = fakeAgent()
    const long = 'x'.repeat(300)
    ctx.tools.register(defineTool({
      name: 'mixed',
      description: 'Returns mixed content.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: () => [
          { type: 'text', text: long },
          { type: 'reasoning', text: 'hidden' },
        ],
      },
      execute() {
        return Promise.resolve('mixed-value')
      },
    }))
    runtime.behavior = async (request) => {
      const value = await request.bindings[0]!.functions.mixed!({})
      return { logs: [], value }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text).toBe('mixed-value')
    const dispatch = events.find(event => event.type === 'tool/code-dispatch')?.data as SessionEventMap['tool/code-dispatch']
    expect(dispatch.resultSummary.length).toBe(201)
    expect(dispatch.resultSummary.endsWith('…')).toBe(true)
  })

  it('normalizes the session workspace root before bounding durable result summaries', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    ctx.tools.register(defineTool({
      name: 'workspace_path',
      description: 'Return a path beneath the session workspace.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute(_args, exec) {
        const cwd = exec.agent?.session.header.cwd ?? ''
        return Promise.resolve(`<path>${cwd}/nested/task.txt</path>\n${'x'.repeat(240)}`)
      },
    }))
    runtime.behavior = async request => ({
      logs: [],
      value: await request.bindings[0]!.functions.workspace_path!({}),
    })

    const short = fakeAgent({ cwd: '/tmp/workspace' })
    const long = fakeAgent({ cwd: `/tmp/${'long-segment/'.repeat(30)}workspace` })
    const shortResult = await runCode(ctx, 'program', { agent: short.agent })
    const longResult = await runCode(ctx, 'program', { agent: long.agent })
    const shortDispatch = short.events[0]!.data as SessionEventMap['tool/code-dispatch']
    const longDispatch = long.events[0]!.data as SessionEventMap['tool/code-dispatch']

    expect(shortResult.content).not.toEqual(longResult.content)
    expect(shortDispatch.resultSummary).toBe(longDispatch.resultSummary)
    expect(shortDispatch.resultSummary).toHaveLength(201)
    expect(shortDispatch.resultSummary).toMatch(/^<path>\.\/nested\/task\.txt<\/path>\n.+…$/)
  })

  it('leaves result summaries unchanged when a session cwd is absent or is the filesystem root', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    registerEcho(ctx)
    runtime.behavior = async request => ({
      logs: [],
      value: await request.bindings[0]!.functions.echo!({ value: '/workspace/value' }),
    })

    const absent = fakeAgent({})
    const root = fakeAgent({ cwd: '/' })
    await runCode(ctx, 'program', { agent: absent.agent })
    await runCode(ctx, 'program', { agent: root.agent })

    expect((absent.events[0]!.data as SessionEventMap['tool/code-dispatch']).resultSummary).toBe('echo:/workspace/value')
    expect((root.events[0]!.data as SessionEventMap['tool/code-dispatch']).resultSummary).toBe('echo:/workspace/value')
  })

  it('rejects undefined, getter-throwing, exotic, and unrepresentable binding arguments before dispatch', async () => {
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
          await catchMessage(echo(Object.defineProperty({}, 'bad', { enumerable: true, get() { throw 'raw-throw' } }))),
          await catchMessage(echo(Object.defineProperty({}, 'bad', { enumerable: true, get() { throw new Error('error-throw') } }))),
          await catchMessage(echo(new Date(0))),
          // A bare function is a value JSON cannot represent at all.
          await catchMessage(echo(() => 1)),
        ].join(' | '),
      }
    }
    const result = await runCode(ctx, 'program', { agent })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('call the tool with an arguments object')
    expect(text).toContain('lossless JSON: raw-throw')
    expect(text).toContain('lossless JSON: error-throw')
    expect(text.match(/tool arguments must be lossless JSON/g)).toHaveLength(5)
    // None dispatched or logged.
    expect(calls).toEqual([])
    expect(events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })

  it('dispatches and durably logs binding arguments deeper than the structured-clone call stack', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const depth = 5_000
    let observedDepth = 0
    let observedLeaf: JsonValue | undefined
    ctx.tools.register(defineTool({
      name: 'deep_args',
      description: 'Measure a deeply nested JSON argument.',
      parameters: { nested: { type: 'json', required: true } },
      output: {
        schema: { type: 'integer' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute(args) {
        let cursor = args.nested
        while (Array.isArray(cursor)) {
          if (cursor.length !== 1) throw new Error('expected one item per nesting layer')
          observedDepth++
          cursor = cursor[0]!
        }
        observedLeaf = cursor
        return Promise.resolve(observedDepth)
      },
    }))
    const session = new Session(SessionId('deep-code-arguments'))
    const agent = { session } as Agent
    runtime.behavior = async (request) => {
      let nested: JsonValue = 'leaf'
      for (let index = 0; index < depth; index++) nested = [nested]
      const value = await request.bindings[0]!.functions.deep_args!({ nested })
      return { logs: [], value }
    }

    const result = await runCode(ctx, 'return tools.deep_args(...)', { agent })

    expect(result.isError).toBe(false)
    expect(result.isError ? undefined : result.value).toEqual({ logs: [], result: depth })
    expect({ observedDepth, observedLeaf }).toEqual({ observedDepth: depth, observedLeaf: 'leaf' })
    const dispatch = session.events.find(event => event.type === 'tool/code-dispatch')
    if (dispatch === undefined) throw new Error('expected a durable tool/code-dispatch event')
    const logged = dispatch.data.arguments as { nested: JsonValue }
    let loggedDepth = 0
    let loggedCursor = logged.nested
    while (Array.isArray(loggedCursor)) {
      if (loggedCursor.length !== 1) throw new Error('expected one logged item per nesting layer')
      loggedDepth++
      loggedCursor = loggedCursor[0]!
    }
    expect({ loggedDepth, loggedCursor }).toEqual({ loggedDepth: depth, loggedCursor: 'leaf' })
  })

  it('gives the tool and durable log the same immutable argument value', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    const { agent, events } = fakeAgent()
    let mutationSucceeded: boolean | undefined
    ctx.tools.register(defineContentToolFixture({
      name: 'mutator',
      description: 'Attempts to mutate its args object.',
      parameters: { list: { type: 'array', required: true } },
      execute(args) {
        mutationSucceeded = Reflect.set(args.list, 1, 'injected-by-tool')
        return Promise.resolve([{ type: 'text' as const, text: 'protected' }])
      },
    }))
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.mutator!({ list: ['original'] })
      return { logs: [] }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    expect(mutationSucceeded).toBe(false)
    const dispatch = events.find(event => event.type === 'tool/code-dispatch')?.data as SessionEventMap['tool/code-dispatch']
    expect(dispatch.arguments).toEqual({ list: ['original'] })
  })

  it('exposes a tool named __proto__ as an ordinary own binding', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    ctx.tools.register(defineTool({
      name: '__proto__',
      description: 'A prototype-colliding tool name.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute() { return Promise.resolve('proto-tool-ok') },
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

  it('renders every non-string JSON root as pretty JSON while preserving strings raw', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: { n: 42, ok: true } })
    expect((await runCode(ctx, 'object')).content[0]).toEqual({ type: 'text', text: '{\n  "n": 42,\n  "ok": true\n}' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: {} })
    expect((await runCode(ctx, 'empty object')).content[0]).toEqual({ type: 'text', text: '{}' })
    const nested = { outer: [{ inner: true }] }
    runtime.behavior = () => Promise.resolve({ logs: [], value: nested })
    expect((await runCode(ctx, 'nested')).content[0]).toEqual({ type: 'text', text: JSON.stringify(nested, null, 2) })
    runtime.behavior = () => Promise.resolve({ logs: [], value: ['x', 2] })
    expect((await runCode(ctx, 'array')).content[0]).toEqual({ type: 'text', text: '[\n  "x",\n  2\n]' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: [] })
    expect((await runCode(ctx, 'empty array')).content[0]).toEqual({ type: 'text', text: '[]' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: null })
    expect((await runCode(ctx, 'null')).content[0]).toEqual({ type: 'text', text: 'null' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: 'raw' })
    expect((await runCode(ctx, 'string')).content[0]).toEqual({ type: 'text', text: 'raw' })
    runtime.behavior = () => Promise.resolve({ logs: [] })
    const absent = await runCode(ctx, 'undefined')
    expect(absent.content[0]).toEqual({ type: 'text', text: '(run_code completed with no output)' })
    expect(absent.isError ? undefined : absent.value).toEqual({ logs: [] })
  })

  it('renders deeply nested JSON without recursive traversal or quadratic indentation', async () => {
    const { ctx, runtime } = await setup({ mode: 'code' })
    let value: JsonValue = {
      emptyArray: [],
      emptyObject: {},
      pair: ['leaf', 2],
      record: { first: true, second: null },
    }
    for (let depth = 0; depth < 5_000; depth++) value = [value]
    runtime.behavior = () => Promise.resolve({ logs: [], value })

    const result = await runCode(ctx, 'deep result')

    expect(result.isError).toBe(false)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text.startsWith('[\n  [\n    [')).toBe(true)
    expect(text).toContain('"leaf"')
    expect(text.endsWith(']')).toBe(true)
    expect(text.length).toBeLessThan(11_000)
  })

  it('short-circuits a pre-aborted outer signal before the code runtime', async () => {
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
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
      isError: true,
      error: {
        message: 'tool call aborted before dispatch',
        info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
      },
    })
    expect(runtime.lastRequest).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('reports cancellation after rejecting a late binding without dispatching it', async () => {
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
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted',
      info: { name: 'AbortError', code: 'ABORTED' },
    })
    expect((result.content[0] as { text: string }).text).toBe('Error: tool call aborted')
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
