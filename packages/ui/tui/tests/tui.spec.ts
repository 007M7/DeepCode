import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Terminal } from '@earendil-works/pi-tui'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
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

describe('TUI config', () => {
  it('defaults every direct-call TUI option', () => {
    expect(resolveTuiConfig(undefined)).toEqual({
      showReasoning: true,
      maxToolOutputLines: 12,
      maxQuestionOptions: 8,
      questionDialogWidth: 72,
      questionDialogMaxHeight: 20,
      showHardwareCursor: false,
      color: true,
      title: 'DeepSeek Harness',
    })
    expect(resolveTuiConfig({
      showReasoning: false,
      maxToolOutputLines: 2,
      maxQuestionOptions: 3,
      questionDialogWidth: 60,
      questionDialogMaxHeight: 14,
      showHardwareCursor: true,
      color: false,
      title: 'DSH',
    })).toEqual({
      showReasoning: false,
      maxToolOutputLines: 2,
      maxQuestionOptions: 3,
      questionDialogWidth: 60,
      questionDialogMaxHeight: 14,
      showHardwareCursor: true,
      color: false,
      title: 'DSH',
    })
  })
})

describe('pi-tui chat lifecycle and transcript', () => {
  it('renders its header, footer, replay, streaming answer, todos, and status', async () => {
    const result = await setup({
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

    result.agent.status = 'running'
    result.ctx.emit('agent/status', result.agent, 'running')
    result.session.append('user/message', { content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('steering/message', { turn: 2, content: [{ type: 'text', text: 'steering note' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('steering/message', { turn: 2, content: [{ type: 'text', text: '' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('context/message', { content: [{ type: 'text', text: 'user context' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('context/message', { content: [{ type: 'text', text: '' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('prompt/blocked', { content: [{ type: 'text', text: 'blocked' }], source: { kind: 'user' }, reason: 'test policy' })
    appendAssistant(result.session, [])
    result.session.append('turn/end', { turn: 9, reason: { kind: 'aborted' } })
    result.session.append('turn/end', { turn: 10, reason: { kind: 'completed' } })
    result.session.append('step/start', { turn: 11, step: 0 })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'reasoning-delta', index: 0, text: 'live thought' },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'reasoning-delta', index: 9, text: 'unannounced thought' },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'live thought complete' } },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'block-start', index: 1, blockType: 'text' },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'text-delta', index: 1, text: 'live answer' },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'live answer done' } },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'block-start', index: 2, blockType: 'tool-call' },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'stream-tool' as never, name: 'tool', arguments: '{}' } },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'tool-call-delta', index: 2, id: 'stream-tool' as never, argumentsDelta: '{}' },
    })
    result.session.append('assistant/chunk', {
      turn: 2,
      step: 0,
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
      { turn: 2, step: 0 },
    )
    await tick()

    expect(result.terminal.output).toContain('Working')
    expect(result.terminal.output).toContain('Steering')
    expect(result.terminal.output).toContain('user context')
    expect(result.terminal.output).toContain('Prompt blocked')
    expect(result.terminal.output).toContain('Turn cancelled')
    expect(result.terminal.output).toContain('final live answer')
    expect(result.terminal.output).toContain('↑1.8k ↓50')
    expect(result.terminal.progress).toContain(true)

    result.session.append('assistant/chunk', {
      turn: 3,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'cleared stream' },
    })
    result.terminal.send('/clear')
    result.terminal.send('\r')
    appendAssistant(result.session, [{ type: 'text', text: 'answer after clear' }])
    await tick()
    expect(result.terminal.output).toContain('answer after clear')

    result.agent.status = 'idle'
    result.ctx.emit('agent/status', result.agent, 'idle')
    await tick()
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
          turn: 2,
          step: 0,
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
    unrelatedSession.append('todo/write', { todos: [{ content: 'hidden', status: 'pending' }] })
    events.ctx.emit('agent/status', unrelatedAgent, 'running')
    events.ctx.emit('agent/error', unrelatedAgent, 1, 1, new Error('hidden error'))
    events.ctx.emit('agent/disposed', unrelatedAgent)
    events.ctx.emit('agent/error', events.agent, 3, 2, new Error('live failure'))
    events.session.append('turn/end', { turn: 3, reason: { kind: 'error', step: 2, message: 'live failure' } })
    events.session.append('turn/end', { turn: 4, reason: { kind: 'error', step: 1, message: 'durable failure' } })
    events.session.append('turn/end', { turn: 5, reason: { kind: 'aborted', reason: 'stopped' } })
    events.session.append('turn/end', { turn: 6, reason: { kind: 'max-tokens' } })
    events.session.append('turn/end', { turn: 7, reason: { kind: 'rejected', reason: 'policy' } })
    events.session.append('turn/end', { turn: 8, reason: { kind: 'interrupted' } })
    events.session.append('turn/end', {
      turn: 9,
      reason: { kind: 'error', step: 1, failure: { message: 'structured provider failure', code: 'SERVER' } },
    })
    events.ctx.emit('agent/disposed', events.agent)
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
    const result = await setup({ tools, config: { maxToolOutputLines: 1 } })
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
      result.session.append('tool/call', { turn: 1, step: 0, callId: id as never, name, arguments: args })
    }
    await tick()
    expect(result.terminal.output).toContain('$ raw command')
    result.terminal.send('/reasoning')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('call presenter boom')
    expect(result.terminal.output).toContain('Symbol(input)')
    result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'c1' as never, content: [{ type: 'text', text: 'raw bash' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'c2' as never, content: [{ type: 'text', text: 'stopped' }], isError: true,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'c3' as never, content: [{ type: 'text', text: 'done' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'c4' as never, content: [{ type: 'text', text: 'raw generic' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'c5' as never, content: [{ type: 'text', text: 'raw throwing' }], isError: false,
      meta: { value: 1 },
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'c7' as never,
      content: [
        { type: 'tool-call', id: 'inner' as never, name: 'inner', arguments: '{}' },
        { type: 'tool-result', toolCallId: 'inner' as never, content: [{ type: 'text', text: 'nested output' }] },
        { type: 'future-result' } as never,
      ],
      isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'c8' as never, content: [{ type: 'text', text: '\nundefined presenter output\n\nkept tail\n' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'c11' as never, content: [{ type: 'text', text: '\nconverted terminal\n\nfinished\n' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'orphan' as never, content: [{ type: 'text', text: 'orphan result' }], isError: false,
    }, { surfaceOp: 'append' })
    await tick()

    const output = result.terminal.output
    expect(output).toContain('Run command')
    expect(output).toContain('printf hello')
    expect(output).toContain('more lines')
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
      step: 0,
      provenance: { provider: 'mock', model: 'deepseek-v4-flash' },
      content: [{ type: 'tool-call', id: 'old-call' as never, name: 'bash', arguments: '{}' }],
    }, { surfaceOp: 'append' })
    result.session.append('tool/call', {
      turn: 1, step: 0, callId: 'old-call' as never, name: 'bash', arguments: '{}',
    })
    const toolResult = result.session.append('tool/result', {
      turn: 1, step: 0, callId: 'old-call' as never, content: [{ type: 'text', text: 'old output' }], isError: false,
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
    result.terminal.send('c')
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
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Second?')
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
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
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
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
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
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
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
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
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
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const session = ctx.sessions.create(SessionId('failed-start-session'))
    ctx.agents.register({
      id: session.id, options: {}, session, status: 'running', ctx,
      send() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    })
    const terminal = new FakeTerminal()
    terminal.start = () => { throw new Error('terminal startup failed') }

    expect(() => createTuiChat(ctx, { sessionId: 'failed-start-session', color: false }, { terminal, exit: vi.fn() }))
      .toThrow('terminal startup failed')
    expect(terminal.stopped).toBe(1)
    expect(terminal.progress).toEqual([false, true, false])
    await expect(ctx.userInteraction.ask({ questions: [{ id: 'late', question: 'Late?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    session.append('assistant/chunk', {
      turn: 1,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'must not render' },
    })
    await tick()
    expect(terminal.output).not.toContain('must not render')
    await ctx.fiber.dispose()
  })

  it('throws when createTuiChat is called without the configured agent', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const runtime: TuiRuntime = { terminal: new FakeTerminal(), exit: vi.fn() }
    expect(() => createTuiChat(ctx, { sessionId: 'missing' }, runtime)).toThrow('is not running')
    await ctx.fiber.dispose()
  })
})
