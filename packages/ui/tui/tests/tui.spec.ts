import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Terminal } from '@earendil-works/pi-tui'
import AgentRegistry, { agentEvents, assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import CommandService, { type CommandInvocation } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type {} from '@deepseek-ai/dsh-llm-retry'
import {
  createTuiChat,
  mountTui,
  resolveTuiConfig,
  type TuiRuntime,
} from '../src/index.ts'
import {
  appendAssistant,
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  type TuiHarnessOptions,
} from './harness.ts'

class FakeTerminal implements Terminal {
  columns = 88
  rows = 32
  kittyProtocolActive = false
  output = ''
  title = ''
  progress: boolean[] = []
  started = 0
  stopped = 0
  drainInput = vi.fn(() => Promise.resolve())
  private onInput: (data: string) => void = () => {}
  private onResize: () => void = () => {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started += 1
    this.onInput = onInput
    this.onResize = onResize
  }

  stop(): void {
    this.stopped += 1
  }

  write(data: string): void {
    this.output += data
  }

  moveBy(lines: number): void {
    this.output += `[move:${lines}]`
  }

  hideCursor(): void {
    this.output += '[hide]'
  }

  showCursor(): void {
    this.output += '[show]'
  }

  clearLine(): void {
    this.output += '[clear-line]'
  }

  clearFromCursor(): void {
    this.output += '[clear-rest]'
  }

  clearScreen(): void {
    this.output += '[clear-screen]'
  }

  setTitle(title: string): void {
    this.title = title
  }

  setProgress(active: boolean): void {
    this.progress.push(active)
  }

  send(data: string): void {
    this.onInput(data)
  }

  resize(columns: number, rows = this.rows): void {
    this.columns = columns
    this.rows = rows
    this.onResize()
  }
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

async function setup(options: TuiHarnessOptions = {}) {
  const terminal = new FakeTerminal()
  const exit = vi.fn()
  const result = await createTuiTestHarness(terminal, exit, {
    ...options,
    cwd: options.cwd === undefined ? process.cwd() : options.cwd,
  })
  await tick()
  return result
}

async function dispose(setupResult: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await disposeTuiTestHarness(setupResult)
}

function provideTokenMeter(ctx: Context): void {
  ctx.provide('tokenMeter', {
    contextWindow: 128_000,
    measure() {
      return { totalTokens: 0 }
    },
  } as never)
}

describe('TUI config', () => {
  it('defaults every direct-call TUI option', () => {
    expect(resolveTuiConfig(undefined)).toEqual({
      showReasoning: true,
      maxToolOutputLines: 6,
      maxQuestionOptions: 8,
      maxModelOptions: 8,
      questionDialogWidth: 200,
      questionDialogMaxHeight: 20,
      modelDialogWidth: 72,
      modelDialogMaxHeight: 20,
      showHardwareCursor: false,
      color: true,
      title: 'DeepSeek Harness',
    })
    expect(resolveTuiConfig({
      showReasoning: false,
      maxToolOutputLines: 2,
      maxQuestionOptions: 3,
      maxModelOptions: 4,
      questionDialogWidth: 60,
      questionDialogMaxHeight: 14,
      modelDialogWidth: 64,
      modelDialogMaxHeight: 16,
      showHardwareCursor: true,
      color: false,
      title: 'DSH',
    })).toEqual({
      showReasoning: false,
      maxToolOutputLines: 2,
      maxQuestionOptions: 3,
      maxModelOptions: 4,
      questionDialogWidth: 60,
      questionDialogMaxHeight: 14,
      modelDialogWidth: 64,
      modelDialogMaxHeight: 16,
      showHardwareCursor: true,
      color: false,
      title: 'DSH',
    })
  })
})

describe('pi-tui chat lifecycle and transcript', () => {
  it('renders its header, footer, replay, streaming answer, todos, and status', async () => {
    let now = 0
    const result = await setup({
      contextWindow: 100,
      contextTokens: 42,
      now: () => now,
      beforeMount(session) {
        appendUser(session, 'restored prompt')
        appendAssistant(session, [
          { type: 'reasoning', text: 'restored thought' },
          { type: 'text', text: '**restored answer**' },
        ], { inputTokens: 1_250, outputTokens: 42 })
        session.append('todo/write', {
          todos: [
            { content: 'read code', status: 'completed' },
            { content: 'write tests', status: 'in_progress' },
            { content: 'ship', status: 'pending' },
          ],
        })
      },
    })

    expect(result.terminal.started).toBe(1)
    expect(result.terminal.title).toBe('DeepSeek Harness')
    expect(result.terminal.output).toContain('DEEPSEEK')
    expect(result.terminal.output).toContain('Coding agent ready.')
    expect(result.terminal.output).toContain('restored prompt')
    expect(result.terminal.output).toContain('restored thought')
    expect(result.terminal.output).toContain('restored answer')
    expect(result.terminal.output).toContain('write tests')
    expect(result.terminal.output).toContain('↑1.3k ↓42')
    expect(result.terminal.output).toContain('42% context  tools:compact  deepseek-v4-flash(reasoning:on)')
    result.terminal.resize(52)
    await tick()
    expect(result.terminal.output).toContain('42% context  deepseek-v4-flash(reasoning:on)')
    result.terminal.resize(65)
    await tick()
    expect(result.terminal.output).toContain('↑1.3k ↓42 42% context  deepseek-v4-flash(reasoning:on)')
    result.terminal.resize(88)
    await tick()

    result.agent.status = 'running'
    agentEvents(result.ctx, result.agent).emit('agent/status', 'running')
    now = 8_000
    result.session.append('user/message', { content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('steering/message', { turn: 2, content: [{ type: 'text', text: 'steering note' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('steering/message', { turn: 2, content: [{ type: 'text', text: '' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('context/message', { content: [{ type: 'text', text: 'user context' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('context/message', { content: [{ type: 'text', text: '' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('prompt/blocked', { content: [{ type: 'text', text: 'blocked' }], source: { kind: 'user' }, reason: 'test policy' })
    appendAssistant(result.session, [])
    result.session.append('step/end', { turn: 1, step: 1 })
    result.session.append('turn/end', { turn: 1, reason: { kind: 'aborted' } })
    result.session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    result.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    result.session.append('turn/start', { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } })
    result.session.append('step/start', { turn: 3, step: 1 })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'live thought' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 9, text: 'unannounced thought' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'live thought complete' } },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-start', index: 1, blockType: 'text' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'text-delta', index: 1, text: 'live answer' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'live answer done' } },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-start', index: 2, blockType: 'tool-call' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'stream-tool' as never, name: 'tool', arguments: '{}' } },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'tool-call-delta', index: 2, id: 'stream-tool' as never, argumentsDelta: '{}' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    })
    await tick()
    expect(result.terminal.output).toContain('live thought')
    result.terminal.send('\x12')
    await tick()
    appendAssistant(
      result.session,
      [{ type: 'text', text: 'final live answer' }],
      { inputTokens: 500, outputTokens: 8 },
      { turn: 3, step: 1 },
    )
    await tick()

    expect(result.terminal.output).toContain('◒ Working · 8s')
    expect(result.terminal.output).toContain('esc interrupt')
    expect(result.terminal.output).toContain('Steering')
    expect(result.terminal.output).toContain('user context')
    expect(result.terminal.output).toContain('Prompt blocked')
    expect(result.terminal.output).toContain('Turn cancelled')
    expect(result.terminal.output).toContain('final live answer')
    expect(result.terminal.progress).toContain(true)

    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'cleared stream' },
    })
    result.terminal.send('/clear')
    result.terminal.send('\r')
    appendAssistant(result.session, [{ type: 'text', text: 'answer after clear' }], undefined, { turn: 3, step: 1 })
    await tick()
    expect(result.terminal.output).toContain('answer after clear')

    result.agent.status = 'idle'
    agentEvents(result.ctx, result.agent).emit('agent/status', 'idle')
    await tick()
    expect(result.terminal.output).toContain('↑1.8k ↓50')
    expect(result.terminal.output).toContain('deepseek-v4-flash(reasoning:off)')
    expect(result.terminal.progress.at(-1)).toBe(false)
    await dispose(result)
    expect(result.terminal.stopped).toBe(1)
    expect(result.terminal.drainInput).toHaveBeenCalledWith(100, 20)
  })

  it('counts failed and recovered request usage once per step', async () => {
    const result = await setup()
    result.session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    })
    result.session.append('llm/retry', {
      turn: 1,
      step: 1,
      retry: 1,
      maxRetries: 2,
      delayMs: 500,
      failure: { message: 'temporary', code: 'SERVER' },
    })
    result.session.append('assistant/chunk', {
      turn: 1,
      step: 2,
      chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
    })
    appendAssistant(
      result.session,
      [{ type: 'text', text: 'recovered' }],
      { inputTokens: 7, outputTokens: 3 },
      { turn: 1, step: 2 },
    )
    await tick()

    expect(result.terminal.output).toContain('↑17 ↓5')
    await dispose(result)
  })

  it('retracts a failed live stream and renders its durable retry status', async () => {
    const result = await setup()
    result.session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'discarded partial answer' },
    })
    result.session.append('llm/retry', {
      turn: 1,
      step: 1,
      retry: 1,
      maxRetries: 2,
      delayMs: 500,
      failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
    })
    result.session.append('llm/retry', {
      turn: 1,
      step: 2,
      retry: 2,
      maxRetries: 2,
      delayMs: 1_000,
      failure: { message: 'failed before chunks', code: 'SERVER', status: 503 },
    })
    await tick()

    expect(result.terminal.output).toContain('Retrying model request (1/2) in 500ms: rate limited')
    expect(result.terminal.output).toContain('Retrying model request (2/2) in 1000ms: failed before chunks')
    await dispose(result)
  })

  it('renders the ANSI palette and every markdown/content style', async () => {
    const result = await setup({
      config: { color: true },
      beforeMount(session) {
        session.append('user/message', {
          content: [
            { type: 'text', text: '# Heading\n\n[link](https://example.com) `code`\n\n```ts\nconst x = 1\n```\n\n> quote\n\n---\n\n- item\n\n**bold** *italic* ~~strike~~' },
            { type: 'tool-call', id: 'nested' as never, name: 'nested_tool', arguments: '{}' },
            { type: 'tool-result', toolCallId: 'nested' as never, content: [{ type: 'reasoning', text: 'nested result' }] },
            { type: 'future-block' } as never,
            {} as never,
          ],
          source: { kind: 'user' },
        }, { surfaceOp: 'append' })
        appendAssistant(session, [
          { type: 'reasoning', text: 'styled reasoning' },
          { type: 'text', text: 'styled answer' },
        ], { inputTokens: 2_000_000, outputTokens: 1_500_000 })
        session.append('todo/write', { todos: [
          { content: 'done', status: 'completed' },
          { content: 'active', status: 'in_progress' },
          { content: 'later', status: 'pending' },
        ] })
      },
    })
    result.terminal.send('/')
    await tick()
    result.terminal.send('zz')
    await tick()
    result.terminal.send('\x0c')
    await tick()

    expect(result.terminal.output).toContain('\x1b[')
    expect(result.terminal.output).toContain('Heading')
    expect(result.terminal.output).toContain('nested_tool({})')
    expect(result.terminal.output).toContain('nested result')
    expect(result.terminal.output).toContain('[future-block]')
    expect(result.terminal.output).toContain('[content]')
    expect(result.terminal.output).toContain('↑2.0m ↓1.5m')
    await dispose(result)
  })

  it('suppresses stale replay chunks and does not duplicate editor history on rebuild', async () => {
    const result = await setup({
      beforeMount(session) {
        appendUser(session, 'first prompt')
        appendUser(session, 'second prompt')
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'stale partial response' },
        })
      },
    })

    expect(result.terminal.output).not.toContain('stale partial response')
    result.terminal.send('/reasoning')
    result.terminal.send('\r')
    result.terminal.send('\x1b[A')
    result.terminal.send('\x1b[A')
    result.terminal.send('\x1b[A')
    result.terminal.send('\r')
    expect(result.agent.sent).toEqual([[{ type: 'text', text: 'first prompt' }]])
    await dispose(result)
  })

  it('formats large token totals and cwd variants', async () => {
    const home = homedir()
    const homeResult = await setup({
      cwd: home,
      beforeMount(session) {
        appendAssistant(session, [{ type: 'text', text: 'home' }], { inputTokens: 25_000, outputTokens: 10_000 })
      },
    })
    expect(homeResult.terminal.output).toContain('~  ↑25k ↓10k')
    await dispose(homeResult)

    const childResult = await setup({ cwd: join(home, 'projects', 'dsh-tui') })
    expect(childResult.terminal.output).toContain(join('~', 'projects', 'dsh-tui'))
    await dispose(childResult)

    const unsetResult = await setup({ cwd: null })
    expect(unsetResult.terminal.output).toContain('cwd unset')
    await dispose(unsetResult)

    const outsideResult = await setup({ cwd: '/opt' })
    expect(outsideResult.terminal.output).toContain('/opt')
    await dispose(outsideResult)
  })

  it('sends, steers, handles commands, global keys, and disposed-agent input', async () => {
    const result = await setup()

    result.terminal.send('do the work')
    result.terminal.send('\r')
    expect(result.agent.sent).toEqual([[{ type: 'text', text: 'do the work' }]])

    result.terminal.send('   ')
    result.terminal.send('\r')

    result.agent.status = 'running'
    result.ctx.emit('agent/status', result.agent, 'running')
    result.terminal.send('steer it')
    result.terminal.send('\r')
    expect(result.agent.steered).toEqual([[{ type: 'text', text: 'steer it' }]])

    result.terminal.send('\x1b')
    result.terminal.send('\x04')
    result.terminal.send('\x03')
    result.terminal.send('\x12')
    result.terminal.send('\x0f')
    result.terminal.send('/cancel')
    result.terminal.send('\r')
    expect(result.agent.cancelled).toContain('cancelled from terminal')

    result.agent.status = 'idle'
    for (const command of ['/help', '/reasoning', '/tools', '/redraw']) {
      result.terminal.send(command)
      result.terminal.send('\r')
      await tick()
    }
    for (const command of ['/clear', '/cancel', '/wat']) {
      result.terminal.send(command)
      result.terminal.send('\r')
    }
    await tick()
    result.terminal.send('draft')
    result.terminal.send('\x03')
    result.terminal.send('\x04')
    await tick()

    expect(result.terminal.output).toContain('Keyboard shortcuts')
    expect(result.terminal.output).toContain('Reasoning blocks')
    expect(result.terminal.output).toContain('Tool cards')
    expect(result.terminal.output).toContain('already idle')
    expect(result.terminal.output).toContain('Unknown command')
    expect(result.exit).toHaveBeenCalledWith(0)
    await result.controller.dispose()
    await result.ctx.fiber.dispose()

    const ctrlCExit = await setup()
    ctrlCExit.terminal.send('\x03')
    await tick()
    expect(ctrlCExit.exit).toHaveBeenCalledWith(0)
    await ctrlCExit.controller.dispose()
    await ctrlCExit.ctx.fiber.dispose()

    const disposedAgent = await setup()
    disposedAgent.agent.status = 'disposed'
    disposedAgent.terminal.send('late input')
    disposedAgent.terminal.send('\r')
    await tick()
    expect(disposedAgent.terminal.output).toContain('is disposed')
    await dispose(disposedAgent)
  })

  it('opens a keyboard selector and switches the session model without sending slash text to the agent', async () => {
    const result = await setup({
      agentOptions: { provider: 'alpha', model: 'a1' },
      catalog: {
        providers: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
        models: [
          { provider: 'alpha', id: 'a1', name: 'Alpha One', description: 'Fast' },
          { provider: 'alpha', id: 'shared', name: 'Alpha Shared' },
          { provider: 'beta', id: 'b1', name: 'Beta One' },
          { provider: 'beta', id: 'shared', name: 'Beta Shared' },
        ],
      },
    })

    for (const command of ['/model too many model arguments', '/model missing', '/model shared', '/model alpha/a1', '/model alpha a1']) {
      result.terminal.send(command)
      result.terminal.send('\r')
      await tick()
    }
    expect(result.terminal.output).toContain('Usage: /model')
    expect(result.terminal.output).toContain('Unknown model: missing')
    expect(result.terminal.output).toContain('advertised by multiple providers')
    expect(result.terminal.output).toContain('already alpha/a1')

    result.agent.status = 'running'
    result.terminal.send('/model')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Select model')
    expect(result.terminal.output).toContain('alpha/a1')
    expect(result.terminal.output).toContain('Alpha One — Fast — current')
    result.terminal.send('\x1b[B')
    result.terminal.send('\x1b[B')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Model selected: beta/b1')
    expect(result.agent.sent).toEqual([])
    expect(result.agent.steered).toEqual([])

    result.terminal.send('/model')
    result.terminal.send('\r')
    await tick()
    result.terminal.send('\x1b')
    await tick()
    expect(result.agent.cancelled).not.toContain('cancelled from terminal')
    result.agent.status = 'idle'
    result.ctx.emit('agent/status', result.agent, 'idle')
    await tick()
    expect(result.terminal.output).toContain('tools:compact  b1(reasoning:on)')

    const assembly = await result.ctx.systemPrompt.assemble(assembleContextFor(result.agent))
    expect(assembly.variables).toMatchObject({ provider: 'beta', model: 'b1' })
    const seed: LlmCallConfig = { provider: 'alpha', model: 'a1', temperature: 0.2 }
    const request = await agentEvents(result.ctx, result.agent).waterfall(
      'agent/request', 1, 0, seed, () => Promise.resolve(seed),
    )
    expect(request).toEqual({ provider: 'beta', model: 'b1', temperature: 0.2 })
    await dispose(result)
  })

  it('restores the logged model, keeps an unlisted current model visible, and reports catalog failures', async () => {
    const resumed = await setup({
      agentOptions: { provider: 'alpha', model: 'configured' },
      catalog: { providers: [{ id: 'beta', name: 'Beta' }], models: [] },
      beforeMount(session) {
        session.append('request/header', {
          header: { config: { provider: 'beta', model: 'private' } },
          reason: 'initial',
        })
      },
    })
    resumed.terminal.send('/model')
    resumed.terminal.send('\r')
    await tick()
    expect(resumed.terminal.output).toContain('Select model')
    expect(resumed.terminal.output).toContain('beta/private')
    expect(resumed.terminal.output).toContain('private — current')
    await dispose(resumed)

    const unset = await setup({
      agentOptions: {},
      catalog: {
        providers: [{ id: 'alpha', name: 'Alpha' }],
        models: [{ provider: 'alpha', id: 'a1', name: 'Alpha One' }],
      },
    })
    unset.terminal.send('/model')
    unset.terminal.send('\r')
    await tick()
    unset.terminal.send('\r')
    await tick()
    expect(unset.terminal.output).toContain('Model selected: alpha/a1')
    await dispose(unset)

    const empty = await setup({ agentOptions: {}, catalog: { providers: [], models: [] } })
    empty.terminal.send('/model')
    empty.terminal.send('\r')
    await tick()
    expect(empty.terminal.output).toContain('Current model: unset')
    expect(empty.terminal.output).toContain('No models are advertised')
    const assembly = await empty.ctx.systemPrompt.assemble(assembleContextFor(empty.agent))
    expect(assembly.variables).toEqual({})
    const seed: LlmCallConfig = { provider: 'fallback', model: 'fallback' }
    await expect(agentEvents(empty.ctx, empty.agent).waterfall(
      'agent/request', 1, 0, seed, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await dispose(empty)

    const failed = await setup({
      catalog: {
        providers: [{ id: 'deepseek', name: 'DeepSeek' }],
        models: [],
        listModels: () => Promise.reject(new Error('catalog offline')),
      },
    })
    failed.terminal.send('/model')
    failed.terminal.send('\r')
    await tick()
    expect(failed.terminal.output).toContain('Could not read the model catalog: catalog offline')
    await dispose(failed)
  })

  it('does not render a model catalog that resolves after TUI disposal', async () => {
    const deferred = Promise.withResolvers<never[]>()
    const result = await setup({
      catalog: {
        providers: [{ id: 'deepseek', name: 'DeepSeek' }],
        models: [],
        listModels: () => deferred.promise,
      },
    })
    result.terminal.send('/model')
    result.terminal.send('\r')
    await result.controller.dispose()
    deferred.resolve([])
    await tick()
    expect(result.terminal.output).not.toContain('Available models')
    await result.ctx.fiber.dispose()

    const rejected = Promise.withResolvers<never[]>()
    const rejectedResult = await setup({
      catalog: {
        providers: [{ id: 'deepseek', name: 'DeepSeek' }],
        models: [],
        listModels: () => rejected.promise,
      },
    })
    rejectedResult.terminal.send('/model')
    rejectedResult.terminal.send('\r')
    await rejectedResult.controller.dispose()
    rejected.reject(new Error('late catalog failure'))
    await tick()
    expect(rejectedResult.terminal.output).not.toContain('late catalog failure')
    await rejectedResult.ctx.fiber.dispose()
  })

  it('discovers and executes plugin commands, then removes TUI-local commands on disposal', async () => {
    const result = await setup()
    const handler = vi.fn(({ rawInput }: CommandInvocation) => ({
      kind: 'success' as const,
      text: `PLUGIN:${rawInput}`,
    }))
    result.ctx.commands.register({
      name: 'plugin-check',
      description: 'Run a plugin command',
      input: { hint: '<value>' },
      handler,
    })
    result.ctx.commands.register({
      name: 'plugin-fail',
      description: 'Fail a plugin command',
      handler: () => { throw new Error('plugin command exploded') },
    })

    result.terminal.send('/plugin-check  value  ')
    result.terminal.send('\r')
    await tick()

    expect(handler).toHaveBeenCalledTimes(1)
    const invocation = handler.mock.calls[0]?.[0]
    expect(invocation?.agent).toBe(result.agent)
    // pi-tui's Editor owns terminal-line normalization and removes trailing
    // spaces before onSubmit; the registry preserves the adapter-delivered line.
    expect(invocation?.rawInput).toBe('  value')
    expect(result.terminal.output).toContain('PLUGIN:  value')
    result.terminal.send('/plugin-fail')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Command failed: plugin command exploded')
    result.terminal.send('/help')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('/plugin-check <value> — Run a plugin command')
    expect(result.ctx.commands.list(result.agent).map(command => command.name)).toContain('help')

    await result.controller.dispose()
    expect(result.ctx.commands.list(result.agent).map(command => command.name)).toEqual([
      'plugin-check',
      'plugin-fail',
    ])
    await result.ctx.fiber.dispose()
  })

  it('aborts an in-flight plugin command during TUI disposal', async () => {
    const result = await setup()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let commandSignal: AbortSignal | undefined
    result.ctx.commands.register({
      name: 'wait-plugin',
      description: 'Wait until disposal',
      handler: ({ signal }) => {
        commandSignal = signal
        started()
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => { resolve({ kind: 'error', text: 'late result' }) }, { once: true })
        })
      },
    })

    result.terminal.send('/wait-plugin')
    result.terminal.send('\r')
    await ready
    await result.controller.dispose()

    expect(commandSignal?.aborted).toBe(true)
    expect(result.terminal.output).not.toContain('late result')
    await result.ctx.fiber.dispose()
  })

  it('suppresses a successful plugin result that settles as TUI disposal starts', async () => {
    const result = await setup()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let resolveCommand!: (result: { kind: 'success'; text: string }) => void
    result.ctx.commands.register({
      name: 'late-success',
      description: 'Resolve while the TUI closes',
      handler: () => new Promise((resolve) => {
        resolveCommand = resolve
        started()
      }),
    })

    result.terminal.send('/late-success')
    result.terminal.send('\r')
    await ready
    resolveCommand({ kind: 'success', text: 'must not render after disposal' })
    // Let the command boundary accept the result before disposal, but leave the
    // TUI continuation queued so the success-side disposal guard owns the race.
    await Promise.resolve()
    await result.controller.dispose()
    await tick()

    expect(result.terminal.output).not.toContain('must not render after disposal')
    await result.ctx.fiber.dispose()
  })

  it('cancels before /exit while running and handles agent errors/disposal', async () => {
    const result = await setup({ status: 'running' })
    result.terminal.send('/exit')
    result.terminal.send('\r')
    await tick()
    expect(result.agent.cancelled).toContain('terminal exit requested')
    expect(result.exit).toHaveBeenCalledWith(0)

    const events = await setup()
    const unrelatedSession = events.ctx.sessions.create(SessionId('unrelated-session'))
    const unrelatedAgent = { ...events.agent, id: unrelatedSession.id, session: unrelatedSession }
    unrelatedSession.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    unrelatedSession.append('todo/write', { todos: [{ content: 'hidden', status: 'pending' }] })
    agentEvents(events.ctx, unrelatedAgent).emit('agent/status', 'running')
    agentEvents(events.ctx, unrelatedAgent).emit('agent/error', 1, 1, new Error('hidden error'))
    agentEvents(events.ctx, unrelatedAgent).emit('agent/disposed')
    agentEvents(events.ctx, events.agent).emit('agent/error', 1, 1, new Error('live failure'))
    events.session.append('step/end', { turn: 1, step: 1 })
    events.session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, message: 'live failure' } })
    events.session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 2, reason: { kind: 'error', step: 1, message: 'durable failure' } })
    events.session.append('turn/start', { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 3, reason: { kind: 'aborted', reason: 'stopped' } })
    events.session.append('turn/start', { turn: 4, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 4, reason: { kind: 'max-tokens' } })
    events.session.append('turn/start', { turn: 5, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 5, reason: { kind: 'rejected', reason: 'policy' } })
    events.session.append('turn/start', { turn: 6, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 6, reason: { kind: 'interrupted' } })
    events.session.append('turn/start', { turn: 7, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', {
      turn: 7,
      reason: { kind: 'error', step: 1, failure: { message: 'structured provider failure', code: 'SERVER' } },
    })
    agentEvents(events.ctx, events.agent).emit('agent/disposed')
    await tick()
    expect(events.terminal.output).toContain('live failure')
    expect(events.terminal.output).toContain('durable failure')
    expect(events.terminal.output).toContain('structured provider failure')
    expect(events.terminal.output).toContain('stopped')
    expect(events.terminal.output).toContain('output-token limit')
    expect(events.terminal.output).toContain('Turn rejected')
    expect(events.terminal.output).toContain('previous process ended')
    expect(events.terminal.output).toContain('was disposed')
    await dispose(events)
  })
})

describe('tool cards and surface replay', () => {
  const tools: Record<string, ToolDefinition> = {
    bash: {
      name: 'bash', description: '', parameters: {}, execute: async () => [],
      presentCall: () => ({ card: 'terminal', title: 'printf hello', description: 'Run command', cwd: '/tmp' }),
      presentResult: () => ({ card: 'terminal', output: 'hello\nworld\nthird', exitCode: 0 }),
    },
    signal: {
      name: 'signal', description: '', parameters: {}, execute: async () => [],
      presentCall: () => ({ card: 'terminal', title: 'sleep 10' }),
      presentResult: () => ({ card: 'terminal', signal: 'SIGTERM' }),
    },
    edit: {
      name: 'edit', description: '', parameters: {}, execute: async () => [],
      presentCall: () => ({
        card: 'diff',
        title: 'Edit files',
        diffs: [
          { path: 'a.txt', oldText: 'old', newText: 'new' },
          { path: 'b.txt', oldText: 'before', newText: 'after' },
        ],
      }),
      presentResult: () => ({ card: 'diff', diffs: [{ path: 'a.txt', oldText: null, newText: 'created' }] }),
    },
    generic: {
      name: 'generic', description: '', parameters: {}, execute: async () => [],
      presentCall: () => ({ card: 'generic', title: 'Inspect value', rawInput: { alpha: 1 } }),
      presentResult: () => ({ card: 'generic', title: 'Inspected', content: [{ type: 'text', text: 'result text' }] }),
    },
    throwing: {
      name: 'throwing', description: '', parameters: {}, execute: async () => [],
      presentCall: () => { throw new Error('call presenter boom') },
      presentResult: () => { throw new Error('result presenter boom') },
    },
    rawTerminal: {
      name: 'rawTerminal', description: '', parameters: {}, execute: async () => [],
      presentCall: () => ({ card: 'terminal', title: 'raw command' }),
    },
    undefinedViews: {
      name: 'undefinedViews', description: '', parameters: {}, execute: async () => [],
      presentCall: () => undefined,
      presentResult: () => undefined,
    },
    empty: {
      name: 'empty', description: '', parameters: {}, execute: async () => [],
      presentCall: () => ({ card: 'generic', title: 'Empty card' }),
    },
    terminalResult: {
      name: 'terminalResult', description: '', parameters: {}, execute: async () => [],
      presentCall: () => ({ card: 'generic', title: 'Becomes terminal' }),
      presentResult: () => ({ card: 'terminal', output: 'converted terminal' }),
    },
    symbolic: {
      name: 'symbolic', description: '', parameters: {}, execute: async () => [],
      presentCall: () => ({ card: 'generic', title: 'Symbol input', rawInput: Symbol('input') }),
    },
  }

  it('uses terminal, diff, generic, fallback, and collapsed tool presentations', async () => {
    const result = await setup({ tools, config: { maxToolOutputLines: 4 } })
    const calls = [
      ['c1', 'bash', '{"command":"printf hello"}'],
      ['c2', 'signal', '{}'],
      ['c3', 'edit', '{}'],
      ['c4', 'generic', '{}'],
      ['c5', 'throwing', '{}'],
      ['c6', 'unknown', 'not-json'],
      ['c7', 'rawTerminal', '{"value":"raw"}'],
      ['c8', 'undefinedViews', '{"value":8}'],
      ['c10', 'empty', '{}'],
      ['c11', 'terminalResult', '{}'],
      ['c12', 'symbolic', '{}'],
    ] as const
    appendAssistant(result.session, [
      { type: 'text', text: 'Calling tools' },
      ...calls.map(([id, name, args]) => ({
        type: 'tool-call' as const, id: id as never, name, arguments: args,
      })),
    ])
    for (const [id, name, args] of calls) {
      result.session.append('tool/call', { turn: 1, step: 1, callId: id as never, name, arguments: args })
    }
    await tick()
    expect(result.terminal.output).toContain('$ raw command')
    result.terminal.send('/reasoning')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('call presenter boom')
    expect(result.terminal.output).toContain('Symbol(input)')
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c1' as never, content: [{ type: 'text', text: 'raw bash' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c2' as never, content: [{ type: 'text', text: 'stopped' }], isError: true,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c3' as never, content: [{ type: 'text', text: 'done' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c4' as never, content: [{ type: 'text', text: 'raw generic' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c5' as never, content: [{ type: 'text', text: 'raw throwing' }], isError: false,
      meta: { value: 1 },
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c7' as never,
      content: [
        { type: 'tool-call', id: 'inner' as never, name: 'inner', arguments: '{}' },
        { type: 'tool-result', toolCallId: 'inner' as never, content: [{ type: 'text', text: 'nested output' }] },
        { type: 'future-result' } as never,
      ],
      isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c8' as never, content: [{ type: 'text', text: '\nundefined presenter output\n\nkept tail\n' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c11' as never, content: [{ type: 'text', text: '\nconverted terminal\n\nfinished\n' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1,
      step: 1,
      callId: 'orphan' as never,
      content: [{ type: 'text', text: 'orphan result' }],
      isError: true,
      error: { name: 'InterruptedError', code: 'interrupted' },
    }, { surfaceOp: 'append' })
    await tick()

    const output = result.terminal.output
    expect(output).toContain('Run command')
    expect(output).toContain('printf hello')
    expect(output).toContain('lines (Ctrl+O to expand)')
    expect(output).toContain('SIGTERM')
    expect(output).toContain('Edit files')
    expect(output).toContain('Inspected')
    expect(output).toContain('result text')
    expect(output).toContain('Presenter failed')
    expect(output).toContain('not-json')
    expect(output).toContain('nested output')
    expect(output).toContain('[future-result]')
    expect(output).toContain('undefined presenter output')
    expect(output).toContain('Empty card')
    expect(output).toContain('converted terminal')
    expect(output).toContain('orphan result')

    result.terminal.send('/redraw')
    result.terminal.send('\r')
    await tick()
    const collapsed = result.terminal.output.slice(result.terminal.output.lastIndexOf('\x1b[2J'))
    expect(collapsed).toContain('Run command')
    expect(collapsed).toContain('[exit 0]')
    expect(collapsed).not.toContain('▌ hello')
    expect(collapsed).not.toContain('world')
    result.terminal.send('\x0f')
    await tick()
    expect(result.terminal.output).toContain('world')
    expect(result.terminal.output).toContain('+ created')
    await dispose(result)
  })

  it('rebuilds after a surface replacement and hides shadowed tool calls', async () => {
    const result = await setup({ tools })
    appendUser(result.session, 'old prompt')
    const assistant = result.session.append('assistant/message', {
      turn: 1,
      step: 1,
      provenance: { provider: 'mock', model: 'deepseek-v4-flash' },
      content: [{ type: 'tool-call', id: 'old-call' as never, name: 'bash', arguments: '{}' }],
    }, { surfaceOp: 'append' })
    result.session.append('tool/call', {
      turn: 1, step: 1, callId: 'old-call' as never, name: 'bash', arguments: '{}',
    })
    const toolResult = result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'old-call' as never, content: [{ type: 'text', text: 'old output' }], isError: false,
    }, { surfaceOp: 'append' })
    const start = result.session.surface.nodes[0] as number
    result.session.append('context/message', {
      content: [{ type: 'text', text: 'summary replacement' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }, {
      surfaceOp: { op: 'replace', start, end: toolResult.seq },
      sourceEventSeqs: [start, assistant.seq, toolResult.seq],
    })
    await tick()

    result.terminal.resize(89)
    await tick()
    const lastFullRender = result.terminal.output.slice(result.terminal.output.lastIndexOf('\x1b[2J'))
    expect(lastFullRender).toContain('summary replacement')
    expect(lastFullRender).not.toContain('old output')
    await dispose(result)
  })
})

describe('TUI user-interaction dialogs', () => {
  it('answers single-select, multi-select, custom, and optionless questions', async () => {
    const result = await setup({ config: { maxQuestionOptions: 1 } })

    const single = result.ctx.userInteraction.ask({
      questions: [{
        id: 'mode', header: 'Mode', question: 'Choose a mode',
        options: [{ label: 'Safe', description: 'Use checks' }, { label: 'Fast' }],
      }],
    })
    await tick()
    expect(result.terminal.output).toContain('Choose a mode')
    expect(result.terminal.output).toContain('Question 1/1 (1 unanswered) · Mode')
    expect(result.terminal.output).toContain('1/2')
    result.terminal.send('\x1b[B')
    result.terminal.send('\r')
    await expect(single).resolves.toEqual({ answers: [{ id: 'mode', selected: ['Fast'] }] })

    const multi = result.ctx.userInteraction.ask({
      questions: [{ id: 'targets', question: 'Pick targets', multiSelect: true, options: [{ label: 'Code' }, { label: 'Docs' }] }],
    })
    await tick()
    result.terminal.send(' ')
    result.terminal.send('\x1b[B')
    result.terminal.send(' ')
    result.terminal.send('\r')
    await expect(multi).resolves.toEqual({ answers: [{ id: 'targets', selected: ['Code', 'Docs'] }] })

    const custom = result.ctx.userInteraction.ask({
      questions: [{ id: 'other', question: 'Choose or type', options: [{ label: 'Default' }] }],
    })
    await tick()
    result.terminal.send('\t')
    result.terminal.send('my choice')
    result.terminal.send('\r')
    await expect(custom).resolves.toEqual({ answers: [{ id: 'other', selected: [], custom: 'my choice' }] })

    const free = result.ctx.userInteraction.ask({ questions: [{ id: 'note', question: 'Add a note' }] })
    await tick()
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Enter an answer before submitting')
    result.terminal.send('ship it')
    result.terminal.send('\r')
    await expect(free).resolves.toEqual({ answers: [{ id: 'note', selected: [], custom: 'ship it' }] })
    await dispose(result)
  })

  it('handles option wrapping, deselection errors, and returning from custom input', async () => {
    const result = await setup({ config: { color: true } })
    const single = result.ctx.userInteraction.ask({
      questions: [{ id: 'single', question: 'Single options', options: [{ label: 'One' }, { label: 'Two' }] }],
    })
    const singleRejected = expect(single).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    expect(result.terminal.output).toContain('Two')
    result.terminal.send('\x03')
    await singleRejected

    const answer = result.ctx.userInteraction.ask({
      questions: [{
        id: 'options',
        question: 'Exercise options',
        multiSelect: true,
        options: [{ label: 'One', description: 'first' }, { label: 'Two' }],
      }],
    })
    const rejected = expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    result.terminal.send('\x1b[A')
    result.terminal.send('\x1b[B')
    result.terminal.send('\x1b[B')
    result.terminal.send('\x1b[A')
    result.terminal.send(' ')
    await tick()
    result.terminal.send('x')
    result.terminal.send(' ')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Select at least one option')
    result.terminal.send('c')
    await tick()
    result.terminal.send('\x1b')
    await tick()
    expect(result.terminal.output).toContain('Space toggle')
    result.terminal.send('\x03')
    await rejected
    await dispose(result)
  })

  it('asks batches in order and rejects cancelled or aborted work', async () => {
    const result = await setup()
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(result.ctx.userInteraction.ask({
      questions: [{ id: 'pre-aborted', question: 'Already cancelled?' }],
      signal: preAborted.signal,
    })).rejects.toMatchObject({ code: 'ASK_ABORTED' })

    const batch = result.ctx.userInteraction.ask({
      questions: [
        { id: 'first', question: 'First?', options: [{ label: 'Yes' }] },
        { id: 'second', question: 'Second?' },
      ],
    })
    await tick()
    expect(result.terminal.output).toContain('Question 1/2 (2 unanswered)')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Second?')
    expect(result.terminal.output).toContain('Question 2/2 (1 unanswered)')
    result.terminal.send('done')
    result.terminal.send('\r')
    await expect(batch).resolves.toEqual({ answers: [
      { id: 'first', selected: ['Yes'] },
      { id: 'second', selected: [], custom: 'done' },
    ] })

    const cancelled = result.ctx.userInteraction.ask({ questions: [{ id: 'cancel', question: 'Cancel?' }] })
    const cancelledExpectation = expect(cancelled).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    result.terminal.send('\x1b')
    await cancelledExpectation

    const controller = new AbortController()
    const active = result.ctx.userInteraction.ask({ questions: [{ id: 'active', question: 'Active?' }], signal: controller.signal })
    const queuedController = new AbortController()
    const queued = result.ctx.userInteraction.ask({ questions: [{ id: 'queued', question: 'Queued?' }], signal: queuedController.signal })
    const activeExpectation = expect(active).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const queuedExpectation = expect(queued).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    queuedController.abort()
    controller.abort()
    await activeExpectation
    await queuedExpectation
    await dispose(result)
  })

  it('rejects active and queued dialogs on disposal', async () => {
    const result = await setup()
    const active = result.ctx.userInteraction.ask({ questions: [{ id: 'active', question: 'Active?' }] })
    const queued = result.ctx.userInteraction.ask({ questions: [{ id: 'queued', question: 'Queued?' }] })
    const activeExpectation = expect(active).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const queuedExpectation = expect(queued).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    await result.controller.dispose()
    await activeExpectation
    await queuedExpectation
    await expect(result.ctx.userInteraction.ask({ questions: [{ id: 'late', question: 'Late?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await result.ctx.fiber.dispose()
  })
})

describe('terminal mounting', () => {
  it('starts immediately when the configured agent already exists', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const session = ctx.sessions.create(SessionId('main'))
    ctx.agents.register({
      id: session.id, options: {}, session, status: 'idle', ctx,
      send() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    })
    const terminal = new FakeTerminal()
    mountTui(ctx, { color: false }, { terminal, exit: vi.fn() })
    await tick()
    expect(terminal.started).toBe(1)
    await ctx.fiber.dispose()
  })

  it('waits for its configured agent before starting the TUI', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const terminal = new FakeTerminal()
    mountTui(ctx, { sessionId: 'late-session', color: false }, { terminal, exit: vi.fn() })
    expect(terminal.started).toBe(0)

    const otherSession = ctx.sessions.create(SessionId('other-session'))
    ctx.agents.register({
      id: otherSession.id, options: {}, session: otherSession, status: 'idle', ctx,
      send() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    })
    expect(terminal.started).toBe(0)

    const session = ctx.sessions.create(SessionId('late-session'))
    const agent = {
      id: session.id, options: {}, session, status: 'idle', ctx,
      send() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    } as Agent
    ctx.agents.register(agent)
    await tick()
    expect(terminal.started).toBe(1)
    await ctx.fiber.dispose()
  })

  it('prints a matching live startup failure and exits instead of waiting forever', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const terminal = new FakeTerminal()
    const exit = vi.fn()
    mountTui(ctx, { sessionId: 'main-session', color: false }, { terminal, exit })

    ctx.emit('agent-loop/config-start-failed', SessionId('other-session'), new Error('other failed'))
    expect(terminal.output).toBe('')
    expect(exit).not.toHaveBeenCalled()
    ctx.emit('agent-loop/config-start-failed', SessionId('main-session'), new Error('resume \u001b]2;failure-controlled\u0007'))
    expect(terminal.output).toBe('ui-tui: session "main-session" failed to start: resume \\x1b]2;failure-controlled\\x07\n')
    expect(exit).toHaveBeenCalledWith(1)

    const session = ctx.sessions.create(SessionId('main-session'))
    ctx.agents.register({
      id: session.id, options: {}, session, status: 'idle', ctx,
      send() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    })
    await tick()
    expect(terminal.started).toBe(0)
    await ctx.fiber.dispose()
  })

  it('renders an uncoercible startup failure without escaping the display boundary', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const terminal = new FakeTerminal()
    const exit = vi.fn()

    mountTui(ctx, { sessionId: 'main-session', color: false }, { terminal, exit })
    ctx.emit('agent-loop/config-start-failed', SessionId('main-session'), {
      toString(): string { throw new Error('coercion failed') },
    })

    expect(terminal.started).toBe(0)
    expect(terminal.output).toBe('ui-tui: session "main-session" failed to start: <unrenderable value>\n')
    expect(exit).toHaveBeenCalledWith(1)
    await ctx.fiber.dispose()
  })

  it('rolls back providers, listeners, and terminal state when startup fails', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const session = ctx.sessions.create(SessionId('failed-start-session'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    ctx.agents.register({
      id: session.id, options: {}, session, status: 'running', ctx,
      send() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    })
    const terminal = new FakeTerminal()
    terminal.start = () => { throw new Error('terminal startup failed') }

    expect(() => createTuiChat(ctx, { sessionId: 'failed-start-session', color: false }, { terminal, exit: vi.fn() }))
      .toThrow('terminal startup failed')
    await tick()
    expect(ctx.commands.list(ctx.agents.get(SessionId('failed-start-session'))!)).toEqual([])
    expect(terminal.stopped).toBe(1)
    expect(terminal.progress).toEqual([false, true, false])
    await expect(ctx.userInteraction.ask({ questions: [{ id: 'late', question: 'Late?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'must not render' },
    })
    await tick()
    expect(terminal.output).not.toContain('must not render')
    await ctx.fiber.dispose()
  })

  it('throws when createTuiChat is called without the configured agent', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const runtime: TuiRuntime = { terminal: new FakeTerminal(), exit: vi.fn() }
    expect(() => createTuiChat(ctx, { sessionId: 'missing' }, runtime)).toThrow('is not running')
    await ctx.fiber.dispose()
  })
})
