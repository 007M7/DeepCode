import { Readable, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import { createStdioChat, mountStdio, type Config, type StdioRuntime } from '../src/index.ts'

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
    // A minimal session stub with the agent's shared durable identity.
    session: { id, header: { id } },
    send: (content: ContentBlock[]) => void sent.push(content),
    steer: (content: ContentBlock[]) => void steered.push(content),
  } as never
}

/** Register a fake configured agent and cross the supported startup-work boundary. */
function registerReady(ctx: Context, agent: Agent, source: 'startup' | 'resume' = 'startup'): () => void {
  const dispose = ctx.agents.register(agent)
  ctx.emit('agent/session-start', agent, source)
  return dispose
}

/** A session stub whose `header.id` matches an agent's, for `session/event` emits. */
function makeSession(id: string): Session {
  return { id, header: { id } } as Session
}

/** An `assistant/chunk` session event carrying one raw stream chunk. */
function chunkEvent(chunk: StreamChunk): SessionEvent {
  return { type: 'assistant/chunk', seq: 0, time: 0, data: { turn: 1, step: 0, chunk } }
}

const CONFIG: Config = { welcome: 'hi there', sessionId: 'main' }

function unrenderableFailure(): unknown {
  return { [Symbol.toPrimitive](): never { throw new Error('coercion escaped') } }
}

async function setup(config: Config = CONFIG, runtimeOver: Partial<StdioRuntime> = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserInteractionService)
  const { runtime, input, out, exit } = makeRuntime(runtimeOver)
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    createStdioChat(inner, config, runtime)
  }, { inject: ['agents', 'userInteraction'] }))
  return { ctx, fiber, input, out, exit }
}

/** Drive a fake idle timer past the 200ms flush delay. */
function flushExit(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 250))
}

describe('mountStdio readiness', () => {
  it('opens before the configured agent is created so startup input can queue', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserInteractionService)
    const { runtime, out } = makeRuntime()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      mountStdio(inner, CONFIG, runtime)
    }, { inject: ['agents', 'userInteraction'] }))

    expect(out.text()).toBe('hi there\n> ')
    ctx.agents.register(makeAgent('other'))
    expect(out.text()).toBe('hi there\n> ')
    ctx.agents.register(makeAgent('main'))
    expect(out.text()).toBe('hi there\n> ')
    await fiber.dispose()
  })

  it('opens immediately when the configured agent already exists', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserInteractionService)
    ctx.agents.register(makeAgent('main'))
    const { runtime, out } = makeRuntime()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      mountStdio(inner, CONFIG, runtime)
    }, { inject: ['agents', 'userInteraction'] }))

    expect(out.text()).toBe('hi there\n> ')
    await fiber.dispose()
  })

  it('opens for the default main identity when no target is configured', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserInteractionService)
    const { runtime, out } = makeRuntime()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      mountStdio(inner, { welcome: 'ready' }, runtime)
    }, { inject: ['agents', 'userInteraction'] }))

    expect(out.text()).toBe('ready\n> ')
    ctx.agents.register(makeAgent('other'))
    expect(out.text()).toBe('ready\n> ')
    ctx.agents.register(makeAgent('main'))
    expect(out.text()).toBe('ready\n> ')
    await fiber.dispose()
  })
})

describe('createStdioChat rendering', () => {
  it('writes the welcome banner and prompt on start', async () => {
    const { out } = await setup()
    expect(out.text()).toBe('hi there\n> ')
  })

  it('falls back to the default welcome when called with empty config', async () => {
    // createStdioChat is exported and may be driven directly (bypassing the
    // Loader's schemastery validation), so it must default the welcome itself.
    const { out } = await setup({})
    expect(out.text()).toBe('ready.\n> ')
  })

  it('detects readline terminal mode from both stream TTY flags', async () => {
    for (const [inputTTY, outputTTY] of [[true, false], [true, true]] as const) {
      const ctx = new Context()
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(UserInteractionService)
      let text = ''
      const output = new Writable({
        write(chunk, _encoding, callback) {
          text += String(chunk)
          callback()
        },
      }) as Writable & { isTTY?: boolean }
      const { runtime } = makeRuntime({ output })
      ;(runtime.input as Readable & { isTTY?: boolean }).isTTY = inputTTY
      output.isTTY = outputTTY
      const fiber = await ctx.plugin(Object.assign((inner: Context) => {
        createStdioChat(inner, CONFIG, runtime)
      }, { inject: ['agents', 'userInteraction'] }))

      expect(text).toContain('hi there')
      await fiber.dispose()
    }
  })

  it('renders text-delta chunks verbatim', async () => {
    const { ctx, out } = await setup()
    ctx.emit('session/event', makeSession('main'), chunkEvent({ type: 'text-delta', index: 0, text: 'hello' }))
    expect(out.text()).toContain('hello')
  })

  it('wraps reasoning-delta in the dim SGR and resets on the following text-delta', async () => {
    const { ctx, out } = await setup()
    const session = makeSession('main')
    ctx.emit('session/event', session, chunkEvent({ type: 'reasoning-delta', index: 0, text: 'think' }))
    ctx.emit('session/event', session, chunkEvent({ type: 'reasoning-delta', index: 0, text: 'more' }))
    ctx.emit('session/event', session, chunkEvent({ type: 'text-delta', index: 0, text: 'answer' }))
    expect(out.text()).toContain('\x1B[2mthinkmore\x1B[0m\nanswer')
  })

  it('ignores stream-chunk types it does not render', async () => {
    const { ctx, out } = await setup()
    const before = out.text()
    ctx.emit('session/event', makeSession('main'), chunkEvent({ type: 'block-start', index: 0, blockType: 'text' }))
    expect(out.text()).toBe(before)
  })

  it('renders turn/start and turn/end markers from the session feed', async () => {
    const { ctx, out } = await setup()
    const agent = makeAgent('main')
    ctx.agents.register(agent)
    const session = agent.session
    ctx.emit('session/event', session, {
      type: 'turn/start', seq: 1, time: 0, data: { turn: 3, trigger: { kind: 'message' } },
    } as SessionEvent)
    expect(out.text()).toContain('[main turn 3] ')
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 2, time: 0, data: { turn: 3, reason: { kind: 'completed' } },
    } as SessionEvent)
    expect(out.text()).toContain('\n> ')
  })

  it('renders failure turn/end reasons so a failed turn is not silent', async () => {
    const { ctx, out } = await setup()
    const session = makeSession('main')
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 1, time: 0,
      data: { turn: 1, reason: { kind: 'error', step: 1, message: 'fetch failed: connect ECONNREFUSED', code: 'NETWORK' } },
    } as SessionEvent)
    expect(out.text()).toContain('[turn failed NETWORK] fetch failed: connect ECONNREFUSED')
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 2, time: 0,
      data: { turn: 2, reason: { kind: 'error', step: 1, message: 'uncoded failure' } },
    } as SessionEvent)
    expect(out.text()).toContain('[turn failed] uncoded failure')
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 3, time: 0, data: { turn: 3, reason: { kind: 'aborted', reason: 'user cancelled' } },
    } as SessionEvent)
    expect(out.text()).toContain('[turn aborted] user cancelled')
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 4, time: 0, data: { turn: 4, reason: { kind: 'aborted' } },
    } as SessionEvent)
    expect(out.text()).toContain('[turn aborted]\n> ')
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 5, time: 0, data: { turn: 5, reason: { kind: 'rejected', reason: 'policy veto' } },
    } as SessionEvent)
    expect(out.text()).toContain('[turn rejected] policy veto')
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 6, time: 0, data: { turn: 6, reason: { kind: 'max-tokens' } },
    } as SessionEvent)
    expect(out.text()).toContain('[turn hit the output-token limit]')
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 7, time: 0, data: { turn: 7, reason: { kind: 'interrupted' } },
    } as SessionEvent)
    expect(out.text()).toContain('[turn interrupted by a previous process exit]')
  })

  it('uses the session id as the label for a non-target session', async () => {
    const { ctx, out } = await setup()
    // No target exists, so the event's durable identity is the label.
    ctx.emit('session/event', makeSession('orphan'), {
      type: 'turn/start', seq: 1, time: 0, data: { turn: 1, trigger: { kind: 'message' } },
    } as SessionEvent)
    expect(out.text()).toContain('[orphan turn 1] ')
  })

  it('uses an agent already registered before the UI installs as its target', async () => {
    // The pre-created `main` agent (and any agent surviving an HMR reload of just
    // this fiber) fired its `agent/created` before the UI's listener existed, so
    // the live listener alone would miss it. Seeding from `ctx.agents.list()` at
    // install time preserves the terminal's fixed `[main turn N]` label.
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserInteractionService)
    const agent = makeAgent('main')
    // Durable lineage does not imply runtime child ownership: the stdio app
    // may explicitly resume a persisted fork as its one configured agent.
    ;(agent.session.header as { parentSession?: string }).parentSession = 'persisted-parent'
    ctx.agents.register(agent) // registered BEFORE the UI plugin below
    const { runtime, out } = makeRuntime()
    await ctx.plugin(Object.assign((inner: Context) => {
      createStdioChat(inner, CONFIG, runtime)
    }, { inject: ['agents', 'userInteraction'] }))
    ctx.emit('session/event', agent.session, {
      type: 'turn/start', seq: 1, time: 0, data: { turn: 5, trigger: { kind: 'message' } },
    } as SessionEvent)
    expect(out.text()).toContain('[main turn 5] ')
  })

  it('buffers input for a lineage-bearing configured agent until its session starts', async () => {
    const { ctx, input } = await setup({ welcome: 'hi there', sessionId: 'resumed' })
    input.feed('continue')
    await new Promise(resolve => setImmediate(resolve))

    const unrelated = makeAgent('unrelated')
    ctx.agents.register(unrelated)
    ctx.emit('agent/session-start', unrelated, 'startup')
    const resumed = makeAgent('resumed')
    ;(resumed.session.header as { parentSession?: string }).parentSession = 'persisted-parent'
    ctx.agents.register(resumed)
    await new Promise(resolve => setImmediate(resolve))
    expect(resumed.sent).toEqual([])

    ctx.emit('agent/session-start', resumed, 'resume')
    await new Promise(resolve => setImmediate(resolve))

    expect(unrelated.sent).toEqual([])
    expect(resumed.sent).toEqual([[{ type: 'text', text: 'continue' }]])
  })

  it('resets dim styling at turn/end if a turn ends mid-reasoning', async () => {
    const { ctx, out } = await setup()
    const session = makeSession('main')
    ctx.emit('session/event', session, chunkEvent({ type: 'reasoning-delta', index: 0, text: 'mid' }))
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)
    expect(out.text()).toContain('\x1B[2mmid\x1B[0m')
  })

  it('drops the target object on agent/disposed', async () => {
    const { ctx, out } = await setup()
    const agent = makeAgent('main')
    const dispose = ctx.agents.register(agent)
    dispose()
    // After disposal the event belongs to a non-target session, so its durable
    // identity is rendered directly.
    ctx.emit('session/event', agent.session, {
      type: 'turn/start', seq: 1, time: 0, data: { turn: 1, trigger: { kind: 'message' } },
    } as SessionEvent)
    expect(out.text()).toContain('[main turn 1] ')
  })

  it('keeps the target when a different agent is disposed', async () => {
    const { ctx, out } = await setup()
    const target = makeAgent('main')
    ctx.agents.register(target)
    ctx.emit('agent/disposed', makeAgent('other'))
    ctx.emit('session/event', target.session, {
      type: 'turn/start', seq: 1, time: 0, data: { turn: 1, trigger: { kind: 'message' } },
    } as SessionEvent)
    expect(out.text()).toContain('[main turn 1] ')
  })

  it('retargets only the exact identity after loop HMR recreation', async () => {
    const { ctx, input } = await setup({ welcome: 'hi there', sessionId: 'main-session-fixed' })
    const oldRoot = makeAgent('main-session-fixed')
    const prefixCollision = makeAgent('main-session-unrelated')
    const disposeOld = ctx.agents.register(oldRoot)
    ctx.agents.register(prefixCollision)
    disposeOld()
    const replacement = makeAgent('main-session-fixed')
    ctx.agents.register(replacement)
    input.feed('after hmr')
    await new Promise(resolve => setImmediate(resolve))
    expect(replacement.sent).toEqual([])
    ctx.emit('agent/session-start', replacement, 'resume')
    await new Promise(resolve => setImmediate(resolve))

    expect(prefixCollision.sent).toEqual([])
    expect(replacement.sent).toEqual([[{ type: 'text', text: 'after hmr' }]])
  })

  it('does not retarget stdin to an unrelated root after the configured agent is disposed', async () => {
    const { ctx, input } = await setup()
    const unrelated = makeAgent('unrelated')
    ctx.agents.register(unrelated)
    const configured = makeAgent('main')
    const disposeConfigured = registerReady(ctx, configured)
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})

    disposeConfigured()
    input.feed('must not leak')
    await new Promise(resolve => setImmediate(resolve))

    expect(unrelated.sent).toEqual([])
    expect(error).toHaveBeenCalledWith('ui-stdio: main agent is not running')
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

  it('renders one full-fidelity result whether the event feed is live or replayed', async () => {
    const { ctx, out } = await setup()
    const session = makeSession('main')
    const original = {
      type: 'tool/result',
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        callId: 'c1',
        content: [{ type: 'text', text: 'full terminal output' }],
        isError: false,
        meta: { terminal: { output: 'full terminal output' } },
      },
      surfaceOp: 'append',
    } as SessionEvent
    const replacement = {
      ...original,
      seq: 3,
      data: {
        ...original.data,
        content: [{ type: 'text', text: '[... tool result middle pruned ...]' }],
      },
      surfaceOp: { op: 'replace', start: 2, end: 2 },
      sourceEventSeqs: [2],
    } as SessionEvent

    // Stdio consumes the same session/event shape whether a host forwards a
    // live append or replays a stored log through the rendering feed.
    for (const event of [original, replacement]) ctx.emit('session/event', session, event)

    expect(out.text().match(/\[tool result\]/g)).toHaveLength(1)
    expect(out.text()).toContain('full terminal output')
    expect(out.text()).not.toContain('tool result middle pruned')
  })

  it('renders a todo/write session event as a glyphed checklist', async () => {
    const { ctx, out } = await setup()
    const session = {} as Session
    ctx.emit('session/event', session, {
      type: 'todo/write', seq: 1, time: 0,
      data: { todos: [
        { content: 'read the code', status: 'completed' },
        { content: 'write the fix', status: 'in_progress' },
        { content: 'run the tests', status: 'pending' },
      ] },
    } as SessionEvent)
    const text = out.text()
    expect(text).toContain('[todos]')
    expect(text).toContain('[x] read the code')
    expect(text).toContain('[~] write the fix')
    expect(text).toContain('[ ] run the tests')
  })

  it('resets dim styling when a todo/write interrupts reasoning', async () => {
    const { ctx, out } = await setup()
    ctx.emit('session/event', {} as Session, chunkEvent({ type: 'reasoning-delta', index: 0, text: 'r' }))
    ctx.emit('session/event', {} as Session, {
      type: 'todo/write', seq: 1, time: 0,
      data: { todos: [{ content: 'a task', status: 'pending' }] },
    } as SessionEvent)
    expect(out.text()).toContain('\x1B[2mr\x1B[0m')
  })

  it('resets dim styling when a tool/call interrupts reasoning', async () => {
    const { ctx, out } = await setup()
    const session = {} as Session
    ctx.emit('session/event', session, chunkEvent({ type: 'reasoning-delta', index: 0, text: 'r' }))
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
      type: 'user/message', seq: 1, time: 0,
      data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    } as SessionEvent)
    expect(out.text()).toBe(before)
  })
})

describe('createStdioChat input', () => {
  it('answers a pending user question instead of sending the line to the agent', async () => {
    const { ctx, input, out } = await setup()
    const agent = makeAgent('main', 'idle')
    ctx.agents.register(agent)

    const answer = ctx.userInteraction.ask({
      questions: [{
        id: 'confirm',
        header: 'Confirm',
        question: 'Proceed with the edit?',
        options: [{ label: 'Yes', description: 'Apply the edit now.' }],
      }],
    })
    await new Promise(r => setImmediate(r))
    input.feed('Use a smaller change')

    await expect(answer).resolves.toEqual({ answers: [{ id: 'confirm', selected: [], custom: 'Use a smaller change' }] })
    expect(agent.sent).toEqual([])
    expect(out.text()).toContain('[Confirm] Proceed with the edit?')
    expect(out.text()).toContain('1. Yes')
    expect(out.text()).toContain('Apply the edit now.')
  })

  it('answers a pending user question by numeric option selection', async () => {
    const { ctx, input } = await setup()
    const answer = ctx.userInteraction.ask({
      questions: [{
        id: 'mode',
        question: 'Which mode?',
        options: [
          { label: 'Safe' },
          { label: 'Fast' },
        ],
      }],
    })
    await new Promise(r => setImmediate(r))
    input.feed('2')

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'mode', selected: ['Fast'] }],
    })
  })

  it('renders options in input order and selects by displayed number', async () => {
    const { ctx, input, out } = await setup()
    const answer = ctx.userInteraction.ask({
      questions: [{
        id: 'topic',
        question: 'Which topic?',
        options: [
          { label: 'Hobbies' },
          { label: 'Work', description: 'Questions about current projects.' },
          { label: 'Casual', description: 'Easy conversation.' },
        ],
      }],
    })
    await new Promise(r => setImmediate(r))

    expect(out.text()).toContain([
      'Which topic?',
      '  1. Hobbies',
      '  2. Work',
      '     Questions about current projects.',
      '  3. Casual',
      '     Easy conversation.',
    ].join('\n'))
    input.feed('3')

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'topic', selected: ['Casual'] }],
    })
  })

  it('answers a multi-select question with multiple numeric selections', async () => {
    const { ctx, input } = await setup()
    const answer = ctx.userInteraction.ask({
      questions: [{
        id: 'targets',
        question: 'What should I update?',
        options: [{ label: 'Tests' }, { label: 'Docs' }, { label: 'Code' }],
        multiSelect: true,
      }],
    })
    await new Promise(r => setImmediate(r))
    input.feed('1 1, 3')

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'targets', selected: ['Tests', 'Code'] }],
    })
  })

  it('accepts non-numeric multi-select input as a custom answer', async () => {
    const { ctx, input } = await setup()
    const answer = ctx.userInteraction.ask({
      questions: [{
        id: 'targets',
        question: 'What should I update?',
        options: [{ label: 'Tests' }, { label: 'Docs' }],
        multiSelect: true,
      }],
    })
    await new Promise(r => setImmediate(r))
    input.feed('the release notes')

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'targets', selected: [], custom: 'the release notes' }],
    })
  })

  it('asks every question in a batch and returns answers by id', async () => {
    const { ctx, input, out } = await setup()
    const answer = ctx.userInteraction.ask({
      questions: [
        { id: 'language', question: 'Which language?', options: [{ label: 'Python' }, { label: 'TypeScript' }] },
        { id: 'note', question: 'Any note?' },
      ],
    })
    await new Promise(r => setImmediate(r))
    input.feed('2')
    await new Promise(r => setImmediate(r))
    expect(out.text()).toContain('\nAny note?\n')
    input.feed('ship today')

    await expect(answer).resolves.toEqual({
      answers: [
        { id: 'language', selected: ['TypeScript'] },
        { id: 'note', selected: [], custom: 'ship today' },
      ],
    })
  })

  it('re-prompts when option input is invalid', async () => {
    const { ctx, input, out } = await setup()
    const answer = ctx.userInteraction.ask({
      questions: [{
        id: 'mode',
        question: 'Which mode?',
        options: [{ label: 'Safe' }],
        multiSelect: true,
      }],
    })
    await new Promise(r => setImmediate(r))
    input.feed('2')
    await new Promise(r => setImmediate(r))
    expect(out.text()).toContain('Please enter one of the option numbers (comma or space separated) or a custom answer.')
    input.feed('1')

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'mode', selected: ['Safe'] }],
    })
  })

  it('re-prompts when single-select option input is out of range', async () => {
    const { ctx, input, out } = await setup()
    const answer = ctx.userInteraction.ask({
      questions: [{
        id: 'mode',
        question: 'Which mode?',
        options: [{ label: 'Safe' }],
      }],
    })
    await new Promise(r => setImmediate(r))
    input.feed('2')
    await new Promise(r => setImmediate(r))
    expect(out.text()).toContain('Please enter one of the option numbers or a custom answer.')
    input.feed('1')

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'mode', selected: ['Safe'] }],
    })
  })

  it('re-prompts when multi-select input contains no option numbers', async () => {
    const { ctx, input, out } = await setup()
    const answer = ctx.userInteraction.ask({
      questions: [{
        id: 'mode',
        question: 'Which mode?',
        options: [{ label: 'Safe' }],
        multiSelect: true,
      }],
    })
    await new Promise(r => setImmediate(r))
    input.feed(',')
    await new Promise(r => setImmediate(r))
    expect(out.text()).toContain('Please enter one of the option numbers (comma or space separated) or a custom answer.')
    input.feed('1')

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'mode', selected: ['Safe'] }],
    })
  })

  it('re-prompts when an option question receives an empty answer', async () => {
    const { ctx, input, out } = await setup()
    const answer = ctx.userInteraction.ask({
      questions: [{
        id: 'mode',
        question: 'Which mode?',
        options: [{ label: 'Safe' }],
      }],
    })
    await new Promise(r => setImmediate(r))
    input.feed('')
    await new Promise(r => setImmediate(r))
    expect(out.text()).toContain('Please enter one of the option numbers or a custom answer.')
    input.feed('1')

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'mode', selected: ['Safe'] }],
    })
  })

  it('re-prompts when a question receives an empty answer', async () => {
    const { ctx, input, out } = await setup()
    const answer = ctx.userInteraction.ask({ questions: [{ id: 'path', question: 'What should I use?' }] })
    await new Promise(r => setImmediate(r))
    input.feed('')
    await new Promise(r => setImmediate(r))
    expect(out.text()).toContain('Please enter an answer.')
    input.feed('Use defaults')

    await expect(answer).resolves.toEqual({ answers: [{ id: 'path', selected: [], custom: 'Use defaults' }] })
  })

  it('rejects an active question when its signal aborts', async () => {
    const { ctx } = await setup()
    const controller = new AbortController()
    const answer = ctx.userInteraction.ask({ questions: [{ id: 'continue', question: 'Continue?' }], signal: controller.signal })
    const rejected = expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await new Promise(r => setImmediate(r))

    controller.abort()

    await rejected
  })

  it('continues to the next queued question when the active question aborts', async () => {
    const { ctx, input, out } = await setup()
    const controller = new AbortController()
    const first = ctx.userInteraction.ask({ questions: [{ id: 'first', question: 'First?' }], signal: controller.signal })
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const second = ctx.userInteraction.ask({ questions: [{ id: 'second', question: 'Second?' }] })
    await new Promise(r => setImmediate(r))

    controller.abort()
    await firstRejected
    await new Promise(r => setImmediate(r))
    expect(out.text()).toContain('\nSecond?\n')
    input.feed('second answer')

    await expect(second).resolves.toEqual({ answers: [{ id: 'second', selected: [], custom: 'second answer' }] })
  })

  it('skips a queued question whose signal aborted before it became active', async () => {
    const { ctx, input, out } = await setup()
    const controller = new AbortController()
    const first = ctx.userInteraction.ask({ questions: [{ id: 'first', question: 'First?' }] })
    const second = ctx.userInteraction.ask({ questions: [{ id: 'second', question: 'Second?' }], signal: controller.signal })
    await new Promise(r => setImmediate(r))

    controller.abort()

    await expect(Promise.race([
      second.then(
        () => 'resolved',
        (error: unknown) => (error as { code?: string }).code,
      ),
      new Promise<string>((resolve) => { setImmediate(() => { resolve('pending') }) }),
    ])).resolves.toBe('ASK_ABORTED')
    expect(out.text()).not.toContain('\nSecond?\n')
    input.feed('first answer')
    await expect(first).resolves.toEqual({ answers: [{ id: 'first', selected: [], custom: 'first answer' }] })
  })

  it('removes an aborted queued question without promoting later queued work early', async () => {
    const { ctx, input, out } = await setup()
    const controller = new AbortController()
    const first = ctx.userInteraction.ask({ questions: [{ id: 'first', question: 'First?' }] })
    const second = ctx.userInteraction.ask({ questions: [{ id: 'second', question: 'Second?' }], signal: controller.signal })
    const third = ctx.userInteraction.ask({ questions: [{ id: 'third', question: 'Third?' }] })
    await new Promise(r => setImmediate(r))

    controller.abort()

    await expect(second).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(out.text()).toContain('\nFirst?\n')
    expect(out.text()).not.toContain('\nSecond?\n')
    expect(out.text()).not.toContain('\nThird?\n')
    input.feed('first answer')
    await new Promise(r => setImmediate(r))

    expect(out.text()).toContain('\nThird?\n')
    input.feed('third answer')

    await expect(first).resolves.toEqual({ answers: [{ id: 'first', selected: [], custom: 'first answer' }] })
    await expect(third).resolves.toEqual({ answers: [{ id: 'third', selected: [], custom: 'third answer' }] })
  })

  it('rejects active and queued questions when the UI is disposed', async () => {
    const { ctx, fiber } = await setup()
    const active = ctx.userInteraction.ask({ questions: [{ id: 'active', question: 'Active?' }] })
    const queued = ctx.userInteraction.ask({ questions: [{ id: 'queued', question: 'Queued?' }] })
    const activeRejected = expect(active).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await new Promise(r => setImmediate(r))

    await fiber.dispose()

    await activeRejected
    await queuedRejected
  })

  it('rejects active and queued questions when stdin closes before the user answers', async () => {
    const { ctx, input, exit } = await setup()
    const active = ctx.userInteraction.ask({ questions: [{ id: 'active', question: 'Active?' }] })
    const queued = ctx.userInteraction.ask({ questions: [{ id: 'queued', question: 'Queued?' }] })
    const activeRejected = expect(active).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await new Promise(r => setImmediate(r))

    input.finish()
    await new Promise(r => setImmediate(r))

    await activeRejected
    await queuedRejected
    expect(exit).not.toHaveBeenCalled()
  })

  it('rejects new questions immediately after stdin has closed', async () => {
    const { ctx, input, out } = await setup()
    input.finish()
    await new Promise(r => setImmediate(r))
    const before = out.text()

    const answer = ctx.userInteraction.ask({ questions: [{ id: 'late', question: 'Too late?' }] })

    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(out.text()).toBe(before)
  })

  it('sends a typed line to an idle agent', async () => {
    const { ctx, input } = await setup()
    const agent = makeAgent('main', 'idle')
    registerReady(ctx, agent)
    input.feed('do a thing')
    await new Promise(r => setImmediate(r))
    expect(agent.sent).toEqual([[{ type: 'text', text: 'do a thing' }]])
    expect(agent.steered).toEqual([])
  })

  it('steers a typed line into a running agent', async () => {
    const { ctx, input } = await setup()
    const agent = makeAgent('main', 'running')
    registerReady(ctx, agent)
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

  it('buffers a line until the initial target session starts', async () => {
    const { ctx, input } = await setup()
    const spy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    input.feed('nobody home')
    await new Promise(r => setImmediate(r))
    expect(spy).not.toHaveBeenCalled()

    const agent = makeAgent('main')
    ctx.agents.register(agent)
    await new Promise(r => setImmediate(r))
    expect(agent.sent).toEqual([])
    ctx.emit('agent/session-start', agent, 'startup')
    await new Promise(r => setImmediate(r))
    expect(agent.sent).toEqual([[{ type: 'text', text: 'nobody home' }]])
  })

  it('drops later input after the configured startup fails', async () => {
    const { ctx, input } = await setup()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const failure = unrenderableFailure()
    ctx.emit('agent-loop/config-start-failed', SessionId('main'), failure)

    input.feed('cannot run')
    await new Promise(r => setImmediate(r))

    expect(error).toHaveBeenCalledWith(
      'ui-stdio: main agent failed to start; dropped queued stdin (1 line(s)): <unrenderable value>',
    )
  })

  it('ignores a stale config-start failure after the exact target is ready', async () => {
    const { ctx, input } = await setup()
    const agent = makeAgent('main')
    registerReady(ctx, agent)
    ctx.emit('agent-loop/config-start-failed', SessionId('main'), new Error('stale'))

    input.feed('still live')
    await new Promise(r => setImmediate(r))

    expect(agent.sent).toEqual([[{ type: 'text', text: 'still live' }]])
  })

  it('drives the exact app-configured resumed session', async () => {
    const { ctx, input } = await setup({ welcome: 'w', sessionId: 'worker' })
    const agent = makeAgent('worker')
    registerReady(ctx, agent, 'resume')
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
    registerReady(ctx, agent)
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

  it('keeps piped EOF pending until buffered startup input runs', async () => {
    const { ctx, input, exit } = await setup()
    input.feed('work')
    input.finish()
    await flushExit()
    expect(exit).not.toHaveBeenCalled()

    const agent = makeAgent('main', 'idle')
    ctx.agents.register(agent)
    await new Promise(r => setImmediate(r))
    expect(agent.sent).toEqual([])
    ctx.emit('agent/session-start', agent, 'startup')
    await new Promise(r => setImmediate(r))
    expect(agent.sent).toEqual([[{ type: 'text', text: 'work' }]])
    ctx.emit('agent/status', agent, 'running')
    ;(agent as { status: AgentStatus }).status = 'idle'
    ctx.emit('agent/status', agent, 'idle')
    await flushExit()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('drains buffered piped input and exits when configured startup fails', async () => {
    const { ctx, input, exit } = await setup()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    input.feed('work')
    input.finish()
    await new Promise(r => setImmediate(r))
    ctx.emit('agent-loop/config-start-failed', SessionId('other'), new Error('unrelated'))
    await flushExit()
    expect(exit).not.toHaveBeenCalled()

    ctx.emit('agent-loop/config-start-failed', SessionId('main'), unrenderableFailure())
    await flushExit()

    expect(error).toHaveBeenCalledWith(
      'ui-stdio: main agent failed to start; dropped queued stdin (1 line(s)): <unrenderable value>',
    )
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('schedules the exit only once when idle fires repeatedly', async () => {
    const { ctx, input, exit } = await setup()
    const agent = makeAgent('main', 'running')
    registerReady(ctx, agent)
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
    registerReady(ctx, agent)
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
    registerReady(ctx, agent)
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
    registerReady(ctx, agent)
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
