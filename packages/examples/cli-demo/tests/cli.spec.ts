import { readdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage,
  CallId,
  LlmAdapter,
  resolveRetryPolicy,
  type GenerateOptions,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import * as cliDemo from '../src/index.ts'
import {
  executeCli,
  parseCliArgs,
  runOneShot,
  type CliResult,
} from '../src/cli.ts'

type ScriptEntry = readonly StreamChunk[] | 'hang'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private cursor = 0
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'cli test provider retryPolicy')

  constructor(private readonly script: readonly ScriptEntry[]) {
    super()
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script[this.cursor++]
    if (entry === undefined) throw new Error('script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) yield chunk
  }
}

function textResponse(text: string, usage?: TokenUsage, finish: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...usage === undefined ? [] : [{ type: 'usage', usage } as const],
    { type: 'finish', reason: { kind: finish } },
  ]
}

function toolResponse(usage: TokenUsage): StreamChunk[] {
  const id = CallId('cli-call')
  const args = JSON.stringify({ text: 'round trip' })
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'working' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'working' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id, name: 'echo', argumentsDelta: args },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'echo', arguments: args } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function failedResponse(usage: TokenUsage): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'discarded' },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'temporary', code: 'SERVER' } } },
  ]
}

function reasoningResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly persistenceRoot: string
}

const liveContexts: Context[] = []

async function harness(script: readonly ScriptEntry[]): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli-runner-'))
  const ctx = new Context()
  liveContexts.push(ctx)
  await ctx.plugin(cliDemo, {
    provider: 'mock',
    model: 'mock',
    persistenceRoot: root,
    skills: { enabled: false },
    workspaceContext: false,
  })
  await new Promise(resolve => setTimeout(resolve, 80))
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(script))
  ctx.tools.register({
    name: 'echo',
    description: 'Echo text.',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: async args => `ECHO: ${(args as { text: string }).text}`,
  })
  const [agent] = ctx.agents.roots()
  if (agent === undefined) throw new Error('test main agent missing')
  return { ctx, agent, persistenceRoot: root }
}

async function invoke(
  ctx: Context,
  args: readonly string[],
  options: { signal?: AbortSignal; failStdout?: boolean; failDispose?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await executeCli(args, {
    cwd: '/tmp/cli-cwd',
    ...options.signal === undefined ? {} : { signal: options.signal },
    boot: async () => ctx,
    loadEnv: () => {},
    writeStdout: (chunk) => {
      if (options.failStdout === true) throw new Error('stdout closed')
      stdout += chunk
    },
    writeStderr: (chunk) => { stderr += chunk },
    ...options.failDispose === true
      ? { dispose: async (target: Context) => {
        await target.fiber.dispose()
        throw new Error('dispose exploded')
      } }
      : {},
  })
  return { code, stdout, stderr }
}

afterEach(async () => {
  await Promise.all(liveContexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('parseCliArgs', () => {
  it('parses defaults, explicit options, spaces, and an option-like task after --', () => {
    expect(parseCliArgs(['task with spaces'])).toEqual({
      kind: 'run', configPath: './cordis.yml', outputFormat: 'text', task: 'task with spaces',
    })
    expect(parseCliArgs(['--config', 'custom.yml', '--output-format', 'stream-json', 'do it'])).toEqual({
      kind: 'run', configPath: 'custom.yml', outputFormat: 'stream-json', task: 'do it',
    })
    expect(parseCliArgs(['--', '-task'])).toMatchObject({ task: '-task' })
    expect(parseCliArgs(['-p', 'flag task'])).toMatchObject({ task: 'flag task' })
    expect(parseCliArgs(['--prompt', 'long-flag task'])).toMatchObject({ task: 'long-flag task' })
    expect(parseCliArgs(['--help', 'ignored'])).toEqual({ kind: 'help' })
  })

  it('rejects missing, blank, extra, invalid-format, and unsupported flags', () => {
    expect(() => parseCliArgs([])).toThrow('received 0')
    expect(() => parseCliArgs(['   '])).toThrow('must not be blank')
    expect(() => parseCliArgs(['-p', '   '])).toThrow('must not be blank')
    expect(() => parseCliArgs(['one', 'two'])).toThrow('received 2')
    expect(() => parseCliArgs(['-p', 'task', 'positional'])).toThrow('mutually exclusive')
    expect(() => parseCliArgs(['--output-format', 'xml', 'task'])).toThrow('unsupported output format')
    expect(() => parseCliArgs(['-x', 'task'])).toThrow('Unknown option')
  })
})

describe('runOneShot and executeCli', () => {
  it('prints help and argument diagnostics without booting or contaminating stdout', async () => {
    let booted = false
    let stdout = ''
    let stderr = ''
    const runtime = {
      boot: async (): Promise<Context> => { booted = true; throw new Error('unexpected') },
      writeStdout: (chunk: string): void => { stdout += chunk },
      writeStderr: (chunk: string): void => { stderr += chunk },
    }
    expect(await executeCli(['--help'], runtime)).toBe(0)
    expect(stdout).toContain('Usage: dsh-cli-demo')
    stdout = ''
    expect(await executeCli([], runtime)).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('received 0')
    expect(booted).toBe(false)
  })

  it('leaves stdout empty for environment and boot failures and resolves the default config', async () => {
    let bootPath = ''
    let stderr = ''
    const code = await executeCli(['task'], {
      cwd: '/tmp/cli-work',
      loadEnv: (_name, _dir, warn) => { warn('env warning\n') },
      boot: async (_name, path) => { bootPath = path; throw 'boot exploded' },
      writeStdout: () => { throw new Error('stdout must stay empty') },
      writeStderr: (chunk) => { stderr += chunk },
    })
    expect(code).toBe(1)
    expect(bootPath).toBe(resolve('/tmp/cli-work/cordis.yml'))
    expect(stderr).toContain('env warning')
    expect(stderr).toContain('boot exploded')
  })

  it('contains a thrown value whose inspection and coercion both fail', async () => {
    const hostile = new Proxy({}, {
      getPrototypeOf: () => { throw new Error('prototype trap escaped') },
      get: (target, key, receiver) => {
        if (key === Symbol.toPrimitive) throw new Error('coercion escaped')
        return Reflect.get(target, key, receiver) as unknown
      },
    })
    let stdout = ''
    let stderr = ''
    const code = await executeCli(['task'], {
      boot: async () => { throw hostile },
      loadEnv: () => {},
      writeStdout: (chunk) => { stdout += chunk },
      writeStderr: (chunk) => { stderr += chunk },
    })
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe('dsh-cli-demo: [unrenderable thrown value]\n')
  })

  it('interrupts Loader boot and contains every late boot outcome', async () => {
    const abort = new AbortController()
    const lateContext = new Context()
    liveContexts.push(lateContext)
    const boot = Promise.withResolvers<Context>()
    const disposed = Promise.withResolvers<undefined>()
    let disposeCalls = 0
    let stderr = ''
    const running = executeCli(['task'], {
      signal: abort.signal,
      boot: () => boot.promise,
      loadEnv: () => {},
      writeStdout: () => {},
      writeStderr: (chunk) => { stderr += chunk },
      dispose: async (ctx) => {
        disposeCalls += 1
        await ctx.fiber.dispose()
        disposed.resolve(undefined)
      },
    })
    abort.abort('received SIGTERM')
    await expect(running).resolves.toBe(1)
    expect(stderr).toContain('received SIGTERM')
    expect(disposeCalls).toBe(0)
    boot.resolve(lateContext)
    await disposed.promise
    expect(disposeCalls).toBe(1)

    const rejectedBoot = Promise.withResolvers<Context>()
    const rejectedAbort = new AbortController()
    const rejected = executeCli(['task'], {
      signal: rejectedAbort.signal,
      boot: () => rejectedBoot.promise,
      loadEnv: () => {},
      writeStdout: () => {},
      writeStderr: () => {},
    })
    rejectedAbort.abort('stop rejected boot')
    await expect(rejected).resolves.toBe(1)
    rejectedBoot.reject(new Error('late boot rejection'))
    await Promise.resolve()

    let ordinaryBootStderr = ''
    const ordinaryBootFailure = await executeCli(['task'], {
      signal: new AbortController().signal,
      boot: async () => { throw new Error('ordinary boot failure') },
      loadEnv: () => {},
      writeStdout: () => {},
      writeStderr: (chunk) => { ordinaryBootStderr += chunk },
    })
    expect(ordinaryBootFailure).toBe(1)
    expect(ordinaryBootStderr).toContain('ordinary boot failure')

    const failedCleanupBoot = Promise.withResolvers<Context>()
    const failedCleanupAbort = new AbortController()
    const cleanupFailure = Promise.withResolvers<undefined>()
    const failedCleanupContext = new Context()
    liveContexts.push(failedCleanupContext)
    const failedCleanup = executeCli(['task'], {
      signal: failedCleanupAbort.signal,
      boot: () => failedCleanupBoot.promise,
      loadEnv: () => {},
      writeStdout: () => {},
      writeStderr: (chunk) => {
        if (chunk.includes('dispose after interrupted boot failed: late cleanup')) cleanupFailure.resolve(undefined)
      },
      dispose: async (ctx) => {
        await ctx.fiber.dispose()
        throw new Error('late cleanup')
      },
    })
    failedCleanupAbort.abort('stop failed cleanup boot')
    await expect(failedCleanup).resolves.toBe(1)
    failedCleanupBoot.resolve(failedCleanupContext)
    await cleanupFailure.promise
  })

  it('renders text, flushes a persisted fresh session, and disposes the context', async () => {
    const { ctx, agent, persistenceRoot } = await harness([textResponse('final answer')])
    const output = await invoke(ctx, ['task'])
    expect(output).toEqual({ code: 0, stdout: 'final answer\n', stderr: '' })
    expect(agent.status).toBe('idle')
    const files = await readdir(persistenceRoot, { recursive: true })
    expect(files.some(file => file.endsWith('.jsonl.zstd'))).toBe(true)
  })

  it('writes correlated session events in stream-json mode', async () => {
    const { ctx } = await harness([textResponse('streamed answer')])
    const output = await invoke(ctx, ['--output-format', 'stream-json', 'task'])
    const records = output.stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string })

    expect(output.code).toBe(0)
    expect(records.some(record => record.type === 'session_event')).toBe(true)
    expect(records.at(-1)).toMatchObject({ type: 'result', output: 'streamed answer' })
  })

  it('sums usage across tool steps and selects the last text-bearing assistant message', async () => {
    const first = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 }
    const second = { inputTokens: 7, outputTokens: 5, cacheReadTokens: 4, reasoningTokens: 6 }
    const { ctx } = await harness([toolResponse(first), textResponse('done', second)])
    const output = await invoke(ctx, ['--output-format', 'json', 'task'])
    const result = JSON.parse(output.stdout) as CliResult
    expect(output.code).toBe(0)
    expect(result).toMatchObject({ type: 'result', output: 'done' })
    expect(result.usage).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      cacheReadTokens: 6,
      cacheWriteTokens: 1,
      reasoningTokens: 6,
    })
  })

  it('reports usage committed by the recovered assistant message', async () => {
    const failed = { inputTokens: 11, outputTokens: 2, cacheReadTokens: 3 }
    const recovered = { inputTokens: 7, outputTokens: 5, reasoningTokens: 4 }
    const { ctx } = await harness([failedResponse(failed), textResponse('done', recovered)])

    const result = await runOneShot(ctx, { task: 'task' })

    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 5,
      reasoningTokens: 4,
    })
  })

  it('keeps the prior text when a later assistant message has no text blocks', async () => {
    const { ctx } = await harness([
      toolResponse({ inputTokens: 1, outputTokens: 1 }),
      reasoningResponse('reasoning only'),
    ])
    const result = await runOneShot(ctx, { task: 'task' })
    expect(result.output).toBe('working')
  })

  it('observes only the correlated main message turn', async () => {
    const { ctx, agent } = await harness([
      textResponse('startup'),
      textResponse('autonomous'),
      textResponse('streamed'),
    ])
    const other = ctx.sessions.create(SessionId('unrelated'))
    let startupStarted!: () => void
    const started = new Promise<void>((resolve) => { startupStarted = resolve })
    const releaseStartup = Promise.withResolvers<undefined>()
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'assistant/message'
        && event.data.turn === 1) startupStarted()
    })
    ctx.on('agent/turn-stopping', async ({ agent: subject, turn }) => {
      if (subject === agent && turn === 1) await releaseStartup.promise
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'startup' }],
      source: { kind: 'plugin', plugin: 'startup' },
    }))
    await started

    const followup = agent.followup.bind(agent)
    let injectedBeforeReceipt = false
    agent.followup = (input) => {
      if (!injectedBeforeReceipt && input.source.kind === 'user') {
        injectedBeforeReceipt = true
        agent.inbox.append('next-step', createUserMessage({
          content: [{ type: 'text', text: 'wrong receipt' }],
          source: { kind: 'plugin', plugin: 'test-wrong-receipt' },
        }))
        other.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'unrelated session event' }],
          source: { kind: 'plugin', plugin: 'test' },
        }), { surfaceOp: 'append' })
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'uncorrelated main-session event' }],
          source: { kind: 'plugin', plugin: 'test-before-receipt' },
        }), { surfaceOp: 'append' })
      }
      followup(input)
    }

    let replacementQueued = false
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || replacementQueued) return
      replacementQueued = true
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'autonomous' }],
        source: { kind: 'plugin', plugin: 'test' },
      }))
      other.append('turn/start', { turn: 1 })
      other.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    })
    const streamed: { sessionId: string; event: SessionEvent }[] = []
    const result = runOneShot(ctx, {
      task: 'task',
      onEvent: (sessionId, event) => { streamed.push({ sessionId, event }) },
    })
    releaseStartup.resolve(undefined)

    const outcome = await result
    expect(outcome).toMatchObject({ type: 'result', output: 'streamed' })
    const events = streamed.map(item => item.event)
    expect(events.find(event => event.type === 'turn/start'))
      .toMatchObject({ type: 'turn/start', data: { turn: 3 } })
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { turn: 3 } })
    expect(streamed.every(item => item.sessionId === agent.session.id)).toBe(true)
    expect(events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'test')).toBe(false)
    expect(events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'test-before-receipt')).toBe(false)
  })

  it('correlates a task whose step history is replaced', async () => {
    const { ctx } = await harness([textResponse('rewritten answer')])
    ctx.on('agent/pre-step', async () => ({
      kind: 'enter',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'rewritten task' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    await expect(runOneShot(ctx, { task: 'original task' })).resolves.toMatchObject({
      type: 'result',
      output: 'rewritten answer',
    })
  })

  it('settles rejected tasks at whole-agent idle without attributing a result', async () => {
    const blocked = await harness([])
    blocked.ctx.on('agent/pre-step', async () => ({
      kind: 'reject' as const,
    }))
    await expect(runOneShot(blocked.ctx, { task: 'task' })).resolves.toMatchObject({ output: '' })

    const failed = await harness([])
    failed.ctx.on('agent/pre-step', async () => { throw new Error('pre-step exploded') })
    await expect(runOneShot(failed.ctx, { task: 'task' })).resolves.toMatchObject({ output: '' })
  })

  it('emits partial data without attributing a turn outcome', async () => {
    const { ctx } = await harness([textResponse('partial', { inputTokens: 2, outputTokens: 3 }, 'max-tokens')])
    const output = await invoke(ctx, ['--output-format', 'json', 'task'])
    expect(JSON.parse(output.stdout)).toMatchObject({ type: 'result', output: 'partial' })
    expect(output.code).toBe(0)
    expect(output.stderr).toBe('')
  })

  it('cancels an active turn, emits its durable aborted result, and disposes', async () => {
    const { ctx, agent } = await harness(['hang'])
    const abort = new AbortController()
    let started!: () => void
    const running = new Promise<void>((resolveStarted) => { started = resolveStarted })
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'assistant/chunk') started()
    })
    const outcome = invoke(ctx, ['--output-format', 'json', 'task'], { signal: abort.signal })
    await running
    abort.abort('received SIGINT')
    const output = await outcome
    expect(output.stdout).toBe('')
    expect(output.code).toBe(1)
    expect(output.stderr).toContain('received SIGINT')
    expect(agent.status).toBe('idle')
  })

  it('contains stream-writer failures, cancels, flushes, and returns the output error', async () => {
    const { ctx, agent } = await harness(['hang'])
    await expect(runOneShot(ctx, {
      task: 'task',
      onEvent: () => { throw new Error('stream sink failed') },
    })).rejects.toThrow('stream sink failed')
    expect(agent.status).toBe('idle')
  })

  it('handles cancellation before submission, a missing main agent, and final-output failure', async () => {
    const early = await harness([textResponse('unused')])
    const fakeSignal = {
      aborted: true,
      reason: undefined,
    } as unknown as AbortSignal
    await expect(runOneShot(early.ctx, { task: 'task', signal: fakeSignal })).rejects.toThrow('interrupted')

    const raced = await harness([textResponse('unused')])
    let registrations = 0
    const racedSignal = {
      aborted: false,
      reason: 'cancel before followup',
      addEventListener: (_type: string, listener: () => void) => {
        registrations += 1
        if (registrations === 2) listener()
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal
    await expect(runOneShot(raced.ctx, { task: 'task', signal: racedSignal }))
      .rejects.toThrow('cancel before followup')
    expect(raced.agent.session.events.some(event => event.type === 'turn/start')).toBe(false)

    const preBootAbort = new AbortController()
    preBootAbort.abort('before boot completed')
    const preBoot = await invoke(early.ctx, ['task'], { signal: preBootAbort.signal })
    expect(preBoot).toMatchObject({ code: 1, stdout: '' })
    expect(preBoot.stderr).toContain('before boot completed')

    const empty = new Context()
    liveContexts.push(empty)
    await expect(runOneShot(empty, { task: 'task' })).rejects.toThrow('exactly one top-level agent')

    const final = await harness([textResponse('answer')])
    const output = await invoke(final.ctx, ['task'], { failStdout: true })
    expect(output.code).toBe(1)
    expect(output.stdout).toBe('')
    expect(output.stderr).toContain('stdout closed')
    expect(final.agent.status).toBe('idle')

    const disposal = await harness([textResponse('answer')])
    const disposalOutput = await invoke(disposal.ctx, ['task'], { failDispose: true })
    expect(disposalOutput).toMatchObject({ code: 1, stdout: 'answer\n' })
    expect(disposalOutput.stderr).toContain('dispose exploded')
  })

  it('reports disposal failure alongside an earlier run failure', async () => {
    const ctx = new Context()
    liveContexts.push(ctx)
    const output = await invoke(ctx, ['task'], { failDispose: true })
    expect(output).toEqual({
      code: 1,
      stdout: '',
      stderr: 'dsh-cli-demo: config must create exactly one top-level agent, found 0\n'
        + 'dsh-cli-demo: dispose failed: dispose exploded\n',
    })
  })

  it('cancels startup work and queued work before the correlated turn begins', async () => {
    const startup = await harness(['hang'])
    let started!: () => void
    const running = new Promise<void>((resolveStarted) => { started = resolveStarted })
    startup.ctx.on('session/event', (session, event) => {
      if (session === startup.agent.session && event.type === 'assistant/chunk') started()
    })
    startup.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await running
    const startupAbort = new AbortController()
    const waiting = runOneShot(startup.ctx, { task: 'second', signal: startupAbort.signal })
    startupAbort.abort('cancel startup')
    await expect(waiting).rejects.toThrow('cancel startup')
    await startup.agent.whenIdle()

    const queued = await harness([textResponse('unused')])
    const queuedAbort = new AbortController()
    queued.ctx.on('session/event', (session, event) => {
      if (session === queued.agent.session && event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.source.kind === 'user')) {
        queueMicrotask(() => { queuedAbort.abort('cancel queued') })
      }
    })
    await expect(runOneShot(queued.ctx, { task: 'task', signal: queuedAbort.signal })).rejects.toThrow('cancel queued')
    await queued.agent.whenIdle()
  })
})
