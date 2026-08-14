/**
 * Interactive runner behavior over the real Agent, Session, approval, and
 * user-question registries with a scripted Agent factory.
 */

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { apply, internals } from '../src/index.ts'

const originalInternals = { ...internals }
const contexts: Context[] = []

afterEach(async () => {
  Object.assign(internals, originalInternals)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Wait for an observable runner condition without racing the async driver. */
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Append one committed assistant step and its turn close. */
function appendAnswer(
  session: Session,
  turn: number,
  message: UserMessage,
  streamed: string,
  fallback: string,
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/chunk', {
    turn,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: streamed },
  })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: streamed }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('step/start', { turn, step: 2 })
  session.append('assistant/message', {
    turn,
    step: 2,
    message: createAssistantMessage({
      content: [{ type: 'text', text: fallback }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 2 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

interface Script {
  afterPrompt(session: Session, message: UserMessage, agent: Agent): Promise<void> | void
  cancel?(): void
}

interface Bench {
  ctx: Context
  stdin: PassThrough
  output(): string
  error(): string
  order: string[]
  exited: Promise<number>
  cancellations(): number
}

/** Mount the runner on real registries around a small scripted Agent. */
async function bench(script: Script, terminal = false): Promise<Bench> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(UserQuestionService)
  ctx.provide('llm', {
    listConfigurableProviders: () => [],
    listProviders: () => [],
  } as never)
  ctx.provide('credentials', {
    describe: () => Promise.resolve({ configured: false, writable: true }),
  } as never)
  ctx.provide('settings', { describe: () => [] } as never)
  ctx.provide('commands', {
    list: () => [],
    execute: () => Promise.resolve(undefined),
  } as never)
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([]),
  } as never)

  const order: string[] = []
  let cancellationCount = 0
  ctx.on('session/flush', () => { order.push('flush') })
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      let idle = Promise.resolve()
      let status: Agent['status'] = 'idle'
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.defineProperty(agent, 'status', { enumerable: true, get: () => status })
      Object.assign(agent, {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        ctx: agentCtx,
        cancel: () => {
          cancellationCount += 1
          script.cancel?.()
        },
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message: UserMessage) => {
          agent.inbox.append('next-turn', message)
          status = 'running'
          idle = Promise.resolve()
            .then(() => script.afterPrompt(session, message, agent))
            .finally(() => { status = 'idle' })
        },
        steer: () => {},
        inject: () => {},
        whenIdle: () => idle,
      } satisfies Partial<Agent>)
      await options.setup?.(agentCtx)
      ctx.agents.register(agent)
      return {
        agent,
        dispose: async () => { order.push('dispose') },
      }
    },
    resume: () => Promise.reject(new Error('not used')),
  })

  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  if (terminal) {
    Object.assign(stdin, {
      isTTY: true,
      isRaw: false,
      setRawMode(raw: boolean) {
        Object.assign(stdin, { isRaw: raw })
        return stdin
      },
      ref() { return stdin },
      unref() { return stdin },
    })
    Object.assign(stdout, { isTTY: true, columns: 100, rows: 30 })
  }
  let out = ''
  let err = ''
  stdout.on('data', (chunk: Buffer | string) => { out += chunk.toString() })
  stderr.on('data', (chunk: Buffer | string) => { err += chunk.toString() })
  internals.stdin = stdin
  internals.stdout = stdout
  internals.stderr = stderr
  internals.terminal = terminal
  const exited = new Promise<number>((resolve) => {
    ctx.provide('appExit', (code: number) => {
      order.push('exit')
      resolve(code)
    })
  })
  apply(ctx, { cwd: process.cwd() })
  await waitUntil(() => out.includes(terminal ? 'Ask DeepCode' : '>') || err !== '', 'initial prompt')
  if (err !== '') throw new Error(`runner failed before its prompt: ${err}; stdout=${JSON.stringify(out)}`)
  return {
    ctx,
    stdin,
    output: () => out,
    error: () => err,
    order,
    exited,
    cancellations: () => cancellationCount,
  }
}

describe('cli runner', () => {
  it('stores /login input through the selected provider credential without echoing it', async () => {
    const test = await bench({ afterPrompt: () => { throw new Error('not used') } })
    const llm = test.ctx.llm as unknown as Record<string, unknown>
    const settings = test.ctx.settings as unknown as Record<string, unknown>
    const credentials = test.ctx.credentials as unknown as Record<string, unknown>
    let configured = false
    let stored: string | undefined
    Object.assign(llm, {
      listConfigurableProviders: () => [{
        provider: 'test-provider', displayName: 'Test Provider',
        settingsNs: 'test-provider', settingsPath: [],
      }],
    })
    Object.assign(settings, {
      describe: () => [{ ns: 'test-provider', value: { apiKeyEnv: 'TEST_API_KEY' } }],
    })
    Object.assign(credentials, {
      describe: () => Promise.resolve({ configured, writable: true, ...(configured ? { source: 'file' } : {}) }),
      set: (_ref: string, value: string) => { stored = value; configured = true; return Promise.resolve() },
    })

    test.stdin.write('/login\n')
    await waitUntil(() => test.output().includes('Paste DeepSeek API key'), 'masked login prompt')
    test.stdin.write('sk-test-secret\n')
    await waitUntil(() => test.output().includes('API key stored'), 'stored login result')
    test.stdin.write('/exit\n')

    await expect(test.exited).resolves.toBe(0)
    expect(stored).toBe('sk-test-secret')
    expect(test.output()).not.toContain('sk-test-secret')
  })

  it('dispatches plugin commands and reports the built-in command catalog', async () => {
    const test = await bench({ afterPrompt: () => { throw new Error('not used') } })
    const commands = test.ctx.commands as unknown as Record<string, unknown>
    const executed: string[] = []
    Object.assign(commands, {
      list: () => [
        { name: 'compact', description: 'Compact older conversation history' },
        {
          name: 'goal',
          description: 'set or view the goal for a long-running task',
          input: { hint: '[<objective>|clear|edit <objective>|pause|resume]' },
        },
      ],
      execute: (_agent: Agent, line: string) => {
        executed.push(line)
        return Promise.resolve({ result: { kind: 'success', text: 'plugin command complete' } })
      },
    })

    test.stdin.write('/help\n')
    await waitUntil(() => test.output().includes('/login'), 'built-in help')
    expect(test.output()).toContain('/compact  Compact older conversation history')
    expect(test.output()).toContain('/goal [<objective>|clear|edit <objective>|pause|resume]  set or view the goal for a long-running task')
    test.stdin.write('/compact\n')
    await waitUntil(() => test.output().includes('plugin command complete'), 'plugin command result')
    test.stdin.write('/exit\n')

    await expect(test.exited).resolves.toBe(0)
    expect(executed).toEqual(['/compact'])
  })

  it('discovers provider models, renders reasoning levels, and preserves opaque ids', async () => {
    const test = await bench({ afterPrompt: () => { throw new Error('not used') } })
    const llm = test.ctx.llm as unknown as Record<string, unknown>
    Object.assign(llm, {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: () => Promise.resolve([
        { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { provider: 'deepseek-official', id: 'private — pro', name: 'Private Pro' },
      ]),
      resolveModelInfo: (_provider: string, model: string) => Promise.resolve({
        provider: 'deepseek-official', id: model, name: model,
        reasoning: {
          efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
        },
      }),
      resolveCallConfig: (selection: unknown) => Promise.resolve(selection),
    })

    test.stdin.write('/models\n')
    await waitUntil(() => test.output().includes('reasoning off/high/max'), 'provider model catalog')
    test.stdin.write('/model\ndeepseek-official — DeepSeek\nprivate — pro — Private Pro\nmax — Max\n')
    await waitUntil(() => test.output().includes('deepseek-official/private — pro · max'), 'opaque model selection')
    test.stdin.write('/status\n')
    await waitUntil(() => test.output().includes('Model: deepseek-official/private — pro (max)'), 'selected model status')
    test.stdin.write('/exit\n')

    await expect(test.exited).resolves.toBe(0)
  })

  it('keeps one Agent across turns, streams without duplication, flushes, and disposes before exit', async () => {
    let turn = 0
    const messages: string[] = []
    const test = await bench({
      afterPrompt(session, message) {
        turn += 1
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        messages.push(text)
        appendAnswer(session, turn, message, `stream-${turn}`, `fallback-${turn}`)
      },
    })

    test.stdin.write('first\n')
    await waitUntil(() => test.output().includes('fallback-1\n> '), 'second prompt')
    test.stdin.write('second\n')
    await waitUntil(() => test.output().includes('fallback-2\n> '), 'third prompt')
    test.stdin.end()

    await expect(test.exited).resolves.toBe(0)
    expect(messages).toEqual(['first', 'second'])
    expect(test.output()).toBe('> stream-1fallback-1\n> stream-2fallback-2\n> ')
    expect(test.output().match(/stream-1/g)).toHaveLength(1)
    expect(test.output().match(/stream-2/g)).toHaveLength(1)
    expect(test.error()).toBe('')
    expect(test.order.filter(entry => entry === 'flush')).toHaveLength(3)
    expect(test.order.at(-2)).toBe('dispose')
    expect(test.order.at(-1)).toBe('exit')
  })

  it('queues terminal chat input during a running turn and dispatches it after idle', async () => {
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const messages: string[] = []
    const test = await bench({
      async afterPrompt(session, message) {
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        messages.push(text)
        if (messages.length === 1) await firstBlocked
        appendAnswer(session, messages.length, message, `answer-${messages.length}`, '')
      },
    }, true)

    test.stdin.write('first')
    await new Promise(resolve => setTimeout(resolve, 10))
    test.stdin.write('\r')
    await waitUntil(() => messages.length === 1, 'first running turn')
    test.stdin.write('second')
    await new Promise(resolve => setTimeout(resolve, 10))
    test.stdin.write('\r')
    await waitUntil(() => test.output().includes('Enter queue (1)'), 'queued message status')
    releaseFirst()
    await waitUntil(() => messages.length === 2, 'queued second turn')
    test.stdin.end()

    await expect(test.exited).resolves.toBe(0)
    expect(messages).toEqual(['first', 'second'])
  })

  it('renders one compact row for a successful tool call', async () => {
    const callId = CallId('call-1')
    const test = await bench({
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{"path":"a.ts"}' })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    })

    test.stdin.write('inspect\n')
    await waitUntil(() => test.output().endsWith('\n> '), 'post-tool prompt')
    test.stdin.end()

    await expect(test.exited).resolves.toBe(0)
    expect(test.output()).toContain('[tool] read {"path":"a.ts"}')
    expect(test.output()).not.toContain('completed call-1')
  })

  it('routes approval and exact-label questions through the shared input', async () => {
    let approval: string | undefined
    let answer: unknown
    const test = await bench({
      async afterPrompt(session, message, agent) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        approval = await test.ctx.approval.request({
          agent,
          toolName: 'pwsh',
          reason: 'run the command',
        })
        answer = await test.ctx.userQuestions.ask({
          agent,
          questions: [{
            id: 'release',
            question: 'Choose a release action',
            options: [{ label: 'Ship' }, { label: 'Hold' }],
          }],
        })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    })

    test.stdin.write('interact\n')
    await waitUntil(() => test.output().includes('Allow pwsh?'), 'approval prompt')
    test.stdin.write('yes\n')
    await waitUntil(() => test.output().includes('1) Ship'), 'question options')
    test.stdin.write('Ship\n')
    await waitUntil(() => test.output().endsWith('\n> '), 'post-interaction prompt')
    test.stdin.end()

    await expect(test.exited).resolves.toBe(0)
    expect(approval).toBe('allowed-once')
    expect(answer).toEqual({ answers: [{ id: 'release', selected: ['Ship'] }] })
    expect(test.error()).toBe('')
  })

  it('maps a Ctrl+C during a running turn to Agent cancellation and keeps the REPL alive', async () => {
    let release!: () => void
    let started = false
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const test = await bench({
      afterPrompt: () => {
        started = true
        return blocked
      },
      cancel: () => { release() },
    }, true)

    test.stdin.write('slow')
    await new Promise(resolve => setTimeout(resolve, 10))
    test.stdin.write('\r')
    await waitUntil(() => started, 'running turn')
    test.stdin.write('\x03')
    await waitUntil(() => test.cancellations() === 1, 'Agent cancellation')
    await waitUntil(() => test.output().split('>').length > 2, 'prompt after cancellation')
    test.stdin.end()

    await expect(test.exited).resolves.toBe(0)
    expect(test.cancellations()).toBe(1)
    expect(test.order.at(-2)).toBe('dispose')
    expect(test.order.at(-1)).toBe('exit')
  })

  it('reports Agent creation failures and exits nonzero', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const stdin = new PassThrough()
    let err = ''
    internals.stdin = stdin
    internals.stdout = { write: () => true } as never
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } } as never
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('approval', {} as never)
    ctx.provide('userQuestions', {} as never)
    ctx.provide('agents', { create: () => Promise.reject(new Error('factory exploded')) } as never)
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })

    apply(ctx, { cwd: process.cwd() })
    await expect(exited).resolves.toBe(1)
    expect(err).toBe('deepseek: factory exploded\n')
  })
})
