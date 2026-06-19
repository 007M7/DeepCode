import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createStdioChat, type Config, type StdioRuntime } from '../src/index.ts'

/**
 * Unit tests for the stdio UI plugin. They drive the REAL plugin body
 * (`createStdioChat`) with an injected {@link StdioRuntime} so every render,
 * input, EOF, and disposal branch runs without touching the real `process`
 * streams — the I/O seam is what makes the per-file gate reachable. The
 * `agents` service is real (`@deepseek-ai/dsh-agent`); a minimal fake `Agent`
 * stands in for the loop, since the loop is the genuinely expensive collaborator
 * and we only need its `status` + `send`/`steer` surface here.
 */

/** A controllable stdin: a Readable we push lines into and can end on demand. */
function makeInput(): Readable & { feed(line: string): void; finish(): void } {
  const stream = new Readable({ read() {} }) as Readable & { feed(line: string): void; finish(): void }
  stream.feed = (line: string) => stream.push(`${line}\n`)
  stream.finish = () => stream.push(null)
  return stream
}

/** A stdout sink that accumulates everything written, for assertions. */
function makeOutput(): { write: (s: string) => boolean; text: () => string } {
  let buf = ''
  return { write: (s: string) => { buf += s; return true }, text: () => buf }
}

function makeRuntime(over: Partial<StdioRuntime> = {}): {
  runtime: StdioRuntime
  input: ReturnType<typeof makeInput>
  out: ReturnType<typeof makeOutput>
  exit: ReturnType<typeof vi.fn>
} {
  const input = makeInput()
  const out = makeOutput()
  const exit = vi.fn()
  return { runtime: { input, output: { write: out.write } as never, exit, ...over }, input, out, exit }
}

/** A minimal Agent fake exposing the surface the UI touches. */
function makeAgent(id: string, status: AgentStatus = 'idle'): Agent & {
  status: AgentStatus
  sent: ContentBlock[][]
  steered: ContentBlock[][]
} {
  const sent: ContentBlock[][] = []
  const steered: ContentBlock[][] = []
  return {
    id: id as Agent['id'],
    status,
    sent,
    steered,
    send: (content: ContentBlock[]) => void sent.push(content),
    steer: (content: ContentBlock[]) => void steered.push(content),
  } as never
}

const CONFIG: Config = { welcome: 'hi there', agent: 'main' }

async function setup(config: Config = CONFIG, runtimeOver: Partial<StdioRuntime> = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const { runtime, input, out, exit } = makeRuntime(runtimeOver)
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    createStdioChat(inner, config, runtime)
  }, { inject: ['agents'] }))
  return { ctx, fiber, input, out, exit }
}

/** Drive a fake idle timer past the 200ms flush delay. */
function flushExit(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 250))
}

describe('createStdioChat rendering', () => {
  it('writes the welcome banner and prompt on start', async () => {
    const { out } = await setup()
    expect(out.text()).toBe('hi there\n> ')
  })

  it('falls back to default welcome/agent when called with empty config', async () => {
    // createStdioChat is exported and may be driven directly (bypassing the
    // Loader's schemastery validation), so it must default welcome/agent itself.
    const { out } = await setup({})
    expect(out.text()).toBe('ready.\n> ')
    // And it drives the default agent id 'main'.
  })

  it('renders text-delta chunks verbatim', async () => {
    const { ctx, out } = await setup()
    const agent = makeAgent('main')
    ctx.emit('agent/stream-chunk', agent, 1, 0, { type: 'text-delta', index: 0, text: 'hello' })
    expect(out.text()).toContain('hello')
  })

  it('wraps reasoning-delta in the dim SGR and resets on the following text-delta', async () => {
    const { ctx, out } = await setup()
    const agent = makeAgent('main')
    ctx.emit('agent/stream-chunk', agent, 1, 0, { type: 'reasoning-delta', index: 0, text: 'think' })
    ctx.emit('agent/stream-chunk', agent, 1, 0, { type: 'reasoning-delta', index: 0, text: 'more' })
    ctx.emit('agent/stream-chunk', agent, 1, 0, { type: 'text-delta', index: 0, text: 'answer' })
    expect(out.text()).toContain('\x1B[2mthinkmore\x1B[0m\nanswer')
  })

  it('ignores stream-chunk types it does not render', async () => {
    const { ctx, out } = await setup()
    const before = out.text()
    const agent = makeAgent('main')
    ctx.emit('agent/stream-chunk', agent, 1, 0, { type: 'block-start', index: 0, blockType: 'text' })
    expect(out.text()).toBe(before)
  })

  it('renders turn-start and turn-end markers', async () => {
    const { ctx, out } = await setup()
    const agent = makeAgent('main')
    ctx.emit('agent/turn-start', agent, 3)
    expect(out.text()).toContain('[main turn 3] ')
    ctx.emit('agent/turn-end', agent, 3, { kind: 'completed' })
    expect(out.text()).toContain('\n> ')
  })

  it('resets dim styling at turn-end if a turn ends mid-reasoning', async () => {
    const { ctx, out } = await setup()
    const agent = makeAgent('main')
    ctx.emit('agent/stream-chunk', agent, 1, 0, { type: 'reasoning-delta', index: 0, text: 'mid' })
    ctx.emit('agent/turn-end', agent, 1, { kind: 'completed' })
    expect(out.text()).toContain('\x1B[2mmid\x1B[0m')
  })

  it('renders tool/call and tool/result session events', async () => {
    const { ctx, out } = await setup()
    const session = {} as Session
    const callEvent = {
      type: 'tool/call', seq: 1, time: 0,
      data: { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    } as SessionEvent
    ctx.emit('session/event', session, callEvent)
    expect(out.text()).toContain('[tool call] bash({"command":"ls"})')

    const resultEvent = {
      type: 'tool/result', seq: 2, time: 0,
      data: { turn: 1, step: 0, callId: 'c1', content: [{ type: 'text', text: 'file.txt' }], isError: false },
    } as SessionEvent
    ctx.emit('session/event', session, resultEvent)
    expect(out.text()).toContain('[tool result] file.txt')
  })

  it('resets dim styling when a tool/call interrupts reasoning', async () => {
    const { ctx, out } = await setup()
    const agent = makeAgent('main')
    ctx.emit('agent/stream-chunk', agent, 1, 0, { type: 'reasoning-delta', index: 0, text: 'r' })
    const session = {} as Session
    ctx.emit('session/event', session, {
      type: 'tool/call', seq: 1, time: 0,
      data: { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{}' },
    } as SessionEvent)
    expect(out.text()).toContain('\x1B[2mr\x1B[0m')
  })

  it('ignores session events it does not render', async () => {
    const { ctx, out } = await setup()
    const before = out.text()
    ctx.emit('session/event', {} as Session, {
      type: 'turn/start', seq: 1, time: 0, data: { turn: 1, trigger: { kind: 'continuation' } },
    } as SessionEvent)
    expect(out.text()).toBe(before)
  })
})

describe('createStdioChat input', () => {
  it('sends a typed line to an idle agent', async () => {
    const { ctx, input } = await setup()
    const agent = makeAgent('main', 'idle')
    ctx.agents.register(agent)
    input.feed('do a thing')
    await new Promise(r => setImmediate(r))
    expect(agent.sent).toEqual([[{ type: 'text', text: 'do a thing' }]])
    expect(agent.steered).toEqual([])
  })

  it('steers a typed line into a running agent', async () => {
    const { ctx, input } = await setup()
    const agent = makeAgent('main', 'running')
    ctx.agents.register(agent)
    input.feed('steer me')
    await new Promise(r => setImmediate(r))
    expect(agent.steered).toEqual([[{ type: 'text', text: 'steer me' }]])
    expect(agent.sent).toEqual([])
  })

  it('ignores blank lines', async () => {
    const { ctx, input } = await setup()
    const agent = makeAgent('main')
    ctx.agents.register(agent)
    input.feed('   ')
    await new Promise(r => setImmediate(r))
    expect(agent.sent).toEqual([])
  })

  it('logs and drops a line when the target agent is not running', async () => {
    const { ctx, input } = await setup()
    const spy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    input.feed('nobody home')
    await new Promise(r => setImmediate(r))
    expect(spy).toHaveBeenCalledWith('ui-stdio: agent "%s" is not running', 'main')
  })

  it('drives the agent named in config, not a hardcoded id', async () => {
    const { ctx, input } = await setup({ welcome: 'w', agent: 'worker' })
    const agent = makeAgent('worker')
    ctx.agents.register(agent)
    input.feed('hi')
    await new Promise(r => setImmediate(r))
    expect(agent.sent).toHaveLength(1)
  })
})

describe('createStdioChat EOF exit', () => {
  it('exits immediately on EOF when no work was submitted', async () => {
    const { input, exit } = await setup()
    input.finish()
    await flushExit()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('waits for the agent to settle idle after running before exiting', async () => {
    const { ctx, input, exit } = await setup()
    const agent = makeAgent('main', 'idle')
    ctx.agents.register(agent)
    input.feed('work')
    await new Promise(r => setImmediate(r))
    input.finish()
    await new Promise(r => setImmediate(r))
    // Work submitted but no 'running' observed yet — must NOT exit.
    expect(exit).not.toHaveBeenCalled()
    // The turn starts, then settles.
    ctx.emit('agent/status', agent, 'running')
    ;(agent as { status: AgentStatus }).status = 'idle'
    ctx.emit('agent/status', agent, 'idle')
    await flushExit()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('schedules the exit only once when idle fires repeatedly', async () => {
    const { ctx, input, exit } = await setup()
    const agent = makeAgent('main', 'running')
    ctx.agents.register(agent)
    input.feed('work')
    await new Promise(r => setImmediate(r))
    ctx.emit('agent/status', agent, 'running') // sawRunning = true
    input.finish()
    await new Promise(r => setImmediate(r)) // let readline 'close' set stdinClosed
    ;(agent as { status: AgentStatus }).status = 'idle'
    // Two idle signals while stdin is already closed: the first arms the timer,
    // the second must hit the already-scheduled guard, not arm a second.
    ctx.emit('agent/status', agent, 'idle')
    ctx.emit('agent/status', agent, 'idle')
    await flushExit()
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('does not exit on an idle transition for a different agent', async () => {
    const { ctx, input, exit } = await setup()
    const agent = makeAgent('main', 'idle')
    ctx.agents.register(agent)
    input.feed('work')
    await new Promise(r => setImmediate(r))
    input.finish()
    const other = makeAgent('other')
    ctx.emit('agent/status', other, 'running')
    ctx.emit('agent/status', other, 'idle')
    await flushExit()
    expect(exit).not.toHaveBeenCalled()
  })

  it('does not exit while a turn is still running at EOF', async () => {
    const { ctx, input, exit } = await setup()
    const agent = makeAgent('main', 'idle')
    ctx.agents.register(agent)
    input.feed('work')
    await new Promise(r => setImmediate(r))
    ctx.emit('agent/status', agent, 'running')
    ;(agent as { status: AgentStatus }).status = 'running'
    input.finish()
    // sawRunning is true, but the agent is still running — the idle gate holds.
    ctx.emit('agent/status', agent, 'idle') // a stale/duplicate signal while status stays 'running'
    await flushExit()
    expect(exit).not.toHaveBeenCalled()
  })
})

describe('createStdioChat disposal (HMR safety)', () => {
  it('never exits the process when EOF arrives after fiber dispose', async () => {
    const { fiber, input, exit } = await setup()
    await fiber.dispose()
    // A late EOF after disposal (reader.close() also fires 'close') must not exit.
    input.finish()
    await flushExit()
    expect(exit).not.toHaveBeenCalled()
  })

  it('cancels a scheduled exit if disposed within the flush window', async () => {
    const { fiber, input, exit } = await setup()
    // EOF with no work submitted schedules the 200ms flush-then-exit timer.
    input.finish()
    await new Promise(r => setImmediate(r))
    expect(exit).not.toHaveBeenCalled() // not yet — still inside the window
    // Dispose BEFORE the timer fires: the tracked handle must be cleared.
    await fiber.dispose()
    await flushExit()
    expect(exit).not.toHaveBeenCalled()
  })

  it('stops handling input after dispose', async () => {
    const { ctx, fiber, input } = await setup()
    const agent = makeAgent('main')
    ctx.agents.register(agent)
    await fiber.dispose()
    // The readline interface is closed on dispose; a late line reaches no handler.
    input.feed('too late')
    await new Promise(r => setImmediate(r))
    expect(agent.sent).toEqual([])
  })

  it('removes the agent/status listener on dispose', async () => {
    const { ctx, fiber, input, exit } = await setup()
    const agent = makeAgent('main', 'idle')
    ctx.agents.register(agent)
    input.feed('work')
    await new Promise(r => setImmediate(r))
    await fiber.dispose()
    // After dispose, status transitions must neither throw nor schedule an exit
    // (the listener and the EOF-exit path are both torn down).
    expect(() => {
      ctx.emit('agent/status', agent, 'running')
      ctx.emit('agent/status', agent, 'idle')
    }).not.toThrow()
    await flushExit()
    expect(exit).not.toHaveBeenCalled()
  })
})
