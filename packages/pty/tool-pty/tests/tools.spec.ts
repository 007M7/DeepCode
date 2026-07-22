import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { renderToolsSdk } from '@deepseek-ai/dsh-tools'
import type { ToolSdkSchema } from '@deepseek-ai/dsh-tools/src/ts-types.ts'
import PtyService, { PtySessionId } from '@deepseek-ai/dsh-pty'
import type { PtyBackend, PtyBackendSession, PtySendOperation, PtySendRequest, PtySessionStatus, PtySignal } from '@deepseek-ai/dsh-pty'
import TaskService from '@deepseek-ai/dsh-tasks'
import * as ToolTasks from '@deepseek-ai/dsh-tool-tasks'
import * as ToolPty from '@deepseek-ai/dsh-tool-pty'

function fakeAgent(ctx: Context, rawId: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(rawId)
  const agent: Agent = {
    id, options: {}, session: new Session(id), status: 'idle', ctx: scope.ctx,
    send() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

class StubSession implements PtyBackendSession {
  readonly motd = 'stub prompt'
  readonly pid = 42
  statusValue: PtySessionStatus = { kind: 'running' }
  operation: PtySendOperation | undefined
  autoSettle = true
  rejectOperation = false
  closeGate: PromiseWithResolvers<undefined> | undefined

  startSend(_request: PtySendRequest): PtySendOperation {
    let settle!: () => void
    let reject!: (error: unknown) => void
    let cancelled = false
    const done = new Promise<void>((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise }).then(() => ({
      viewport: cancelled ? '^C' : 'command output',
      waitReason: 'stdin_read' as const,
      sessionStatus: this.statusValue,
      truncated: false,
    }))
    const operation: PtySendOperation = {
      done,
      readOutput: () => ({ delta: 'live output', truncated: false }),
      cancel: () => {
        if (cancelled) return false
        cancelled = true
        settle()
        return true
      },
    }
    this.operation = operation
    if (this.rejectOperation) queueMicrotask(() => { reject(new Error('operation failed')) })
    else if (this.autoSettle) queueMicrotask(settle)
    return operation
  }

  read() {
    return { text: 'history', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false }
  }

  async signal(signal: PtySignal) {
    return { delivered: true as const, targetPgid: signal === 'SIGINT' ? 10 : 11 }
  }

  status() { return this.statusValue }

  async close() {
    if (this.closeGate !== undefined) await this.closeGate.promise
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
  }
}

function stubBackend() {
  const sessions: StubSession[] = []
  const backend: PtyBackend = {
    type: 'stub',
    async spawn() {
      const session = new StubSession()
      sessions.push(session)
      return session
    },
  }
  return { backend, sessions }
}

async function setup(tasks: boolean) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(PtyService)
  const stub = stubBackend()
  ctx.pty.registerBackend(stub.backend)
  if (tasks) {
    await ctx.plugin(TaskService)
    await ctx.plugin(ToolTasks)
  }
  await ctx.plugin(ToolPty)
  return { ctx, stub, agent: fakeAgent(ctx, tasks ? 'with-tasks' : 'foreground') }
}

let callNumber = 0
const TOOL_NAMES = ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'] as const
const testToolSignal = new AbortController().signal
function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({ signal: testToolSignal, callId: CallId(`pty-call-${++callNumber}`), name, arguments: args, ...agent ? { agent } : {} })
}

function callWithSignal(ctx: Context, name: string, args: unknown, agent: Agent, signal: AbortSignal) {
  return ctx.tools.execute({ callId: CallId(`pty-call-${++callNumber}`), name, arguments: args, agent, signal })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-pty foreground surface', () => {
  it('registers exactly six schemas and drives the full owner-scoped lifecycle', async () => {
    const { ctx, agent } = await setup(false)
    expect(TOOL_NAMES.every(name => ctx.tools.get(name) !== undefined)).toBe(true)

    const spawned = await call(ctx, 'terminal_open', { type: 'stub', name: 'main' }, agent)
    expect(text(spawned)).toContain('started terminal session pty-1 (main)')
    expect(spawned).toMatchObject({
      isError: false,
      value: {
        sessionId: 'pty-1',
        name: 'main',
        type: 'stub',
        pid: 42,
        status: { kind: 'running' },
        motd: 'stub prompt',
      },
    })
    const listed = await call(ctx, 'terminal_list', {}, agent)
    expect(text(listed)).toContain('pty-1 (main) [stub] running pid=42')
    expect(listed).toMatchObject({ isError: false, value: [{ sessionId: 'pty-1', name: 'main', type: 'stub', pid: 42, status: { kind: 'running' } }] })
    const read = await call(ctx, 'terminal_read', { sessionId: 'pty-1' }, agent)
    expect(text(read)).toContain('history\n[lines: 0-1 of 1]')
    expect(read).toMatchObject({ isError: false, value: { text: 'history', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false } })
    const signalled = await call(ctx, 'terminal_signal', { sessionId: 'pty-1', signal: 'SIGINT' }, agent)
    expect(text(signalled)).toBe('delivered SIGINT to foreground process group 10')
    expect(signalled).toMatchObject({ isError: false, value: { delivered: true, targetPgid: 10 } })
    const sent = await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'echo hi' }, agent)
    expect(text(sent)).toContain('command output\n[wait: stdin_read]\n[session: running]')
    expect(sent).toMatchObject({
      isError: false,
      value: {
        kind: 'foreground',
        viewport: 'command output',
        waitReason: 'stdin_read',
        sessionStatus: { kind: 'running' },
        truncated: false,
      },
      meta: {
        viewport: 'command output',
        waitReason: 'stdin_read',
        sessionStatus: { kind: 'running' },
        truncated: false,
      },
    })
    const closed = await call(ctx, 'terminal_close', { sessionId: 'pty-1' }, agent)
    expect(text(closed)).toBe('closed terminal session pty-1')
    expect(closed).toMatchObject({ isError: false, value: { sessionId: 'pty-1', outcome: 'closed' } })
    const empty = await call(ctx, 'terminal_list', {}, agent)
    expect(text(empty)).toBe('(no terminal sessions)')
    expect(empty).toMatchObject({ isError: false, value: [] })
  })

  it('projects every terminal DTO into the generated Code Mode output map', async () => {
    const { ctx } = await setup(false)
    const schemas = TOOL_NAMES.map((toolName): ToolSdkSchema => {
      const definition = ctx.tools.get(toolName)
      if (definition === undefined) throw new Error(`missing terminal tool ${toolName}`)
      return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: definition.output.schema,
      }
    })
    const sdk = renderToolsSdk(schemas)
    const outputMapStart = sdk.indexOf('interface ToolOutputMap')
    const outputMapEnd = sdk.indexOf('\n\ntype ToolName', outputMapStart)

    expect(sdk.slice(outputMapStart, outputMapEnd)).toMatchInlineSnapshot(`
      "interface ToolOutputMap {
        terminal_close: {
          sessionId: string;
          outcome: "closed" | "already-closing";
        };
        terminal_list: ({
          sessionId: string;
          name?: string;
          type: string;
          pid?: number;
          status: {
            kind: "running";
          } | {
            kind: "exited";
            exitCode: number | null;
            signal: string | null;
          };
        })[];
        terminal_open: {
          sessionId: string;
          name?: string;
          type: string;
          pid?: number;
          status: {
            kind: "running";
          } | {
            kind: "exited";
            exitCode: number | null;
            signal: string | null;
          };
          motd: string;
        };
        terminal_read: {
          text: string;
          totalLines: number;
          lineBegin: number;
          lineEnd: number;
          truncated: boolean;
        };
        terminal_send: {
          kind: "background";
          taskId: string;
        } | {
          kind: "foreground";
          viewport: string;
          waitReason: "stdin_read" | "inferred_idle" | "timeout" | "session_exit";
          sessionStatus: {
            kind: "running";
          } | {
            kind: "exited";
            exitCode: number | null;
            signal: string | null;
          };
          truncated: boolean;
        };
        terminal_signal: {
          delivered: true;
          targetPgid: number;
        };
      }"
    `)
  })

  it('fails without an initiating agent and rejects background before writing', async () => {
    const { ctx, agent, stub } = await setup(false)
    expect((await call(ctx, 'terminal_open', { type: 'stub' })).isError).toBe(true)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    const result = await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'sleep 1', run_in_background: true }, agent)
    expect(result.isError).toBe(true)
    expect(stub.sessions[0]?.operation).toBeUndefined()
  })

  it('validates required values and forwards optional spawn/read arguments', async () => {
    const { ctx, agent } = await setup(false)
    expect((await call(ctx, 'terminal_open', { type: '' }, agent)).isError).toBe(true)
    expect((await call(ctx, 'terminal_send', { sessionId: '', text: 'x' }, agent)).isError).toBe(true)
    expect((await call(ctx, 'terminal_send', { sessionId: 1, text: 'x' }, agent)).isError).toBe(true)
    expect((await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 1 }, agent)).isError).toBe(true)
    await call(ctx, 'terminal_open', { type: 'stub', name: 'named', cwd: '/tmp' }, agent)
    expect(text(await call(ctx, 'terminal_read', { sessionId: 'pty-1', offset: 2, count: 3 }, agent))).toContain('history')
  })

  it('declares terminal presentation only for foreground sends', async () => {
    const { ctx } = await setup(false)
    const definition = ctx.tools.get('terminal_send')
    expect(definition?.presentCall?.({ sessionId: 'pty-1', text: 'python3' })).toMatchObject({ card: 'terminal', title: 'python3' })
    expect(definition?.presentCall?.({ sessionId: 'pty-1', text: 'make', run_in_background: true })).toMatchObject({ card: 'generic' })
    expect(definition?.presentCall?.({ sessionId: 'pty-1', text: '' })).toMatchObject({ card: 'terminal', title: '(send input)' })
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x', run_in_background: true }, { content: [], isError: false })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [], isError: true })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [], isError: false })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [undefined as never], isError: false })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [{ type: 'text', text: 'ok' }], isError: false })).toEqual({ card: 'terminal', output: 'ok' })

    expect(ctx.tools.get('terminal_open')?.presentCall?.({ type: 'stub' })).toMatchObject({ card: 'generic', title: 'Open terminal stub' })
    expect(ctx.tools.get('terminal_open')?.presentCall?.({ type: 'stub', name: 'main' })).toMatchObject({ card: 'generic', title: 'Open terminal main' })
    expect(ctx.tools.get('terminal_read')?.presentCall?.({ sessionId: 'pty-1' })).toMatchObject({ card: 'generic', title: 'Read terminal pty-1' })
    expect(ctx.tools.get('terminal_signal')?.presentCall?.({ sessionId: 'pty-1', signal: 'SIGINT' })).toMatchObject({ card: 'generic', title: 'Signal terminal pty-1' })
    expect(ctx.tools.get('terminal_close')?.presentCall?.({ sessionId: 'pty-1' })).toMatchObject({ card: 'generic', title: 'Close terminal pty-1' })
    expect(ctx.tools.get('terminal_list')?.presentCall?.({})).toMatchObject({ card: 'generic', title: 'List terminal sessions' })
  })
})

describe('tool-pty task integration', () => {
  it('registers a generic task and exposes incremental output', async () => {
    const { ctx, agent } = await setup(true)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    const started = await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'build', run_in_background: true }, agent)
    expect(text(started)).toBe('started background task pty-send-1')
    expect(started).toMatchObject({ isError: false, value: { kind: 'background', taskId: 'pty-send-1' } })
    const output = await call(ctx, 'task_output', { task_id: 'pty-send-1', wait: true }, agent)
    expect(text(output)).toContain('live output')
    expect(text(output)).toContain('[status: completed, wait: stdin_read]')
  })

  it('rejects pre-aborted background calls, maps task cancellation, and contains operation failure', async () => {
    const { ctx, agent, stub } = await setup(true)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    const controller = new AbortController()
    controller.abort()
    expect((await callWithSignal(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'x', run_in_background: true }, agent, controller.signal)).isError).toBe(true)

    stub.sessions[0]!.autoSettle = false
    expect(text(await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: '', run_in_background: true }, agent))).toContain('pty-send-1')
    expect(text(await call(ctx, 'task_kill', { task_id: 'pty-send-1' }, agent))).toContain('requested cancellation')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(text(await call(ctx, 'task_output', { task_id: 'pty-send-1' }, agent))).toContain('[status: killed')

    stub.sessions[0]!.rejectOperation = true
    stub.sessions[0]!.autoSettle = false
    expect(text(await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'bad', run_in_background: true }, agent))).toContain('pty-send-2')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(text(await call(ctx, 'task_output', { task_id: 'pty-send-2' }, agent))).toContain('[status: failed')
  })

  it('reports foreground cancellation after the terminal operation settles', async () => {
    const { ctx, agent, stub } = await setup(false)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    stub.sessions[0]!.autoSettle = false
    const controller = new AbortController()
    const pending = callWithSignal(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'sleep' }, agent, controller.signal)
    await Promise.resolve()
    controller.abort()
    stub.sessions[0]!.operation?.cancel()
    expect((await pending).isError).toBe(true)
  })

  it('renders the already-closing kill result', async () => {
    const { ctx, agent, stub } = await setup(false)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    stub.sessions[0]!.closeGate = Promise.withResolvers<undefined>()
    const first = ctx.pty.kill(agent, PtySessionId('pty-1'))
    const second = call(ctx, 'terminal_close', { sessionId: 'pty-1' }, agent)
    stub.sessions[0]!.closeGate?.resolve(undefined)
    await first
    const result = await second
    expect(text(result)).toBe('terminal session pty-1 was already closing')
    expect(result).toMatchObject({ isError: false, value: { sessionId: 'pty-1', outcome: 'already-closing' } })
  })

  it('renders an exited session detail for background completion', async () => {
    const { ctx, agent, stub } = await setup(true)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    stub.sessions[0]!.statusValue = { kind: 'exited', exitCode: null, signal: null }
    await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'exit', run_in_background: true }, agent)
    const output = await call(ctx, 'task_output', { task_id: 'pty-send-1', wait: true }, agent)
    expect(text(output)).toContain('session exited: unknown')
  })
})

describe('tool-pty plugin shape', () => {
  it('is a named function plugin with no default export', () => {
    expect('default' in ToolPty).toBe(false)
    expect(ToolPty.name).toBe('tool-pty')
    expect(ToolPty.inject).toEqual(['pty', 'tools', 'systemPrompt'])
  })
})
