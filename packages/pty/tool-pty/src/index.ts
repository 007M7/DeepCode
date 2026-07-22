/**
 * Six model-facing persistent terminal tools. Owner identity comes from the exact
 * tool execution Agent; generic `ctx.tasks` owns background ids and collection.
 * @module @deepseek-ai/dsh-tool-pty
 */

import { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { PtySessionId } from '@deepseek-ai/dsh-pty'
import type { PtySendResult, PtySessionId as PtySessionIdType, PtySignal } from '@deepseek-ai/dsh-pty'
import type {} from '@deepseek-ai/dsh-tasks'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult, ToolResult } from '@deepseek-ai/dsh-tools'
import { renderList, renderRead, renderSend, renderSendRead, renderSpawn } from './render.ts'

declare module '@deepseek-ai/dsh-tasks' {
  interface TaskKindMap {
    'pty-send': 'pty-send'
  }
}

/** Cordis plugin name. */
export const name = 'tool-pty'
/** Required capability, registry, and prompt services. */
export const inject = ['pty', 'tools', 'systemPrompt']

interface SpawnArgs {
  type: string
  name?: string
  cwd?: string
}

interface SessionArgs {
  sessionId: string
}

interface SendArgs extends SessionArgs {
  text: string
  submit?: boolean
  run_in_background?: boolean
}

interface ReadArgs extends SessionArgs {
  offset?: number
  count?: number
}

interface SignalArgs extends SessionArgs {
  signal: PtySignal
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('terminal tools require an initiating agent')
  return agent
}

function sessionId(args: SessionArgs): PtySessionIdType {
  if (args.sessionId.length === 0) {
    throw new Error('sessionId must be a non-empty string')
  }
  return PtySessionId(args.sessionId)
}

function textResult(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function rawResultText(result: ToolResult): string | undefined {
  if (result.content.length !== 1) return undefined
  const block = result.content[0]
  return block?.type === 'text' ? block.text : undefined
}

function sendDetail(result: PtySendResult): string {
  return result.sessionStatus.kind === 'running'
    ? `wait: ${result.waitReason}`
    : `session exited: ${result.sessionStatus.exitCode ?? result.sessionStatus.signal ?? 'unknown'}`
}

/** Register all terminal tools and the minimal usage guidance. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:pty',
    order: 106,
    text: 'Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer bash/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited.',
  })

  ctx.tools.register(defineTool({
    name: 'terminal_open',
    description: 'Create a persistent, owner-isolated terminal session from a registered backend type. Use this for shell or REPL state that must survive across tool calls.',
    parameters: {
      type: { type: 'string', required: true, description: 'Registered terminal backend type, usually "shell".' },
      name: { type: 'string', description: 'Optional owner-local display name such as "main" or "gdb".' },
      cwd: { type: 'string', description: 'Initial working directory. Defaults to the deployment workspace root.' },
    },
    async execute(args: SpawnArgs, exec) {
      if (args.type.length === 0) throw new Error('type must be a non-empty string')
      const result = await ctx.pty.spawn(requireAgent(exec.agent), {
        type: args.type,
        ...args.name !== undefined ? { name: args.name } : {},
        ...args.cwd !== undefined ? { cwd: args.cwd } : {},
      }, exec.signal)
      return textResult(renderSpawn(result))
    },
    presentCall: (args) => {
      const parsed = args
      return { card: 'generic', title: `Open terminal ${parsed.name ?? parsed.type}`, kind: 'execute' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_send',
    description: 'Send text to a persistent terminal. By default Enter is submitted and the call waits for a prompt, stdin wait, output silence, timeout, or session exit. Background mode returns a task id for task_output/task_kill.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id returned by terminal_open or terminal_list.' },
      text: { type: 'string', required: true, description: 'UTF-8 text to write to the terminal.' },
      submit: { type: 'boolean', description: 'Submit Enter after text (default true). Set false for control characters or incomplete REPL input.' },
      run_in_background: { type: 'boolean', description: 'Return a task id immediately; collect with task_output or stop with task_kill.' },
    },
    async execute(args: SendArgs, exec): Promise<ToolExecutionResult> {
      const owner = requireAgent(exec.agent)
      const id = sessionId(args)
      const request = { text: args.text, submit: args.submit ?? true }
      if (args.run_in_background === true) {
        const tasks = ctx.get('tasks')
        if (tasks === undefined) throw new Error('background terminal sends require @deepseek-ai/dsh-tasks and @deepseek-ai/dsh-tool-tasks')
        let cancelRequested = false
        const taskId = tasks.start({
          kind: 'pty-send',
          label: `${id}: ${args.text || '(input)'}`,
          owner,
          run: () => {
            const operation = ctx.pty.startSend(owner, id, request)
            return {
              cancel: () => {
                cancelRequested = true
                operation.cancel()
              },
              done: operation.done.then(
                result => ({ status: cancelRequested ? 'killed' as const : 'completed' as const, detail: sendDetail(result) }),
                (error: unknown) => ({ status: 'failed' as const, detail: String(error) }),
              ),
              readOutput: () => renderSendRead(operation.readOutput()),
            }
          },
        })
        return { content: textResult(`started background task ${taskId}`), isError: false }
      }
      const operation = ctx.pty.startSend(owner, id, { ...request, signal: exec.signal })
      const result = await operation.done
      if (exec.signal.aborted) throw new Error('terminal send aborted')
      return { content: textResult(renderSend(result)), isError: false, meta: result }
    },
    presentCall(args) {
      const parsed = args as Partial<SendArgs>
      if (parsed.run_in_background === true) {
        return { card: 'generic', title: `Send to terminal ${parsed.sessionId as string} in background`, kind: 'execute', rawInput: parsed.text }
      }
      return { card: 'terminal', title: parsed.text || '(send input)', description: `Terminal ${parsed.sessionId as string}` }
    },
    presentResult(args, result) {
      if ((args as Partial<SendArgs>).run_in_background === true || result.isError) return undefined
      const raw = rawResultText(result)
      return raw === undefined ? undefined : { card: 'terminal', output: raw }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_read',
    description: 'Read a bounded page of retained output from a persistent terminal without sending input.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
      offset: { type: 'number', description: 'Newest-relative line offset (default 0).' },
      count: { type: 'number', description: 'Requested line count (default 500; backend caps apply).' },
    },
    execute(args: ReadArgs, exec) {
      const result = ctx.pty.read(requireAgent(exec.agent), sessionId(args), {
        ...args.offset !== undefined ? { offset: args.offset } : {},
        ...args.count !== undefined ? { count: args.count } : {},
      })
      return Promise.resolve(textResult(renderRead(result)))
    },
    presentCall: args => ({ card: 'generic', title: `Read terminal ${(args).sessionId}`, kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_signal',
    description: 'Send an allowed signal to the current foreground process group of a persistent terminal.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
      signal: { type: 'string', required: true, enum: ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'], description: 'Signal to deliver. Shell-targeted SIGKILL is rejected; use terminal_close.' },
    },
    async execute(args: SignalArgs, exec) {
      const result = await ctx.pty.signal(requireAgent(exec.agent), sessionId(args), args.signal)
      return textResult(`delivered ${args.signal} to foreground process group ${result.targetPgid}`)
    },
    presentCall: args => ({ card: 'generic', title: `Signal terminal ${(args as SignalArgs).sessionId}`, kind: 'execute', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_close',
    description: 'Close one persistent terminal and wait until its captured owned process tree is gone.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
    },
    async execute(args: SessionArgs, exec) {
      const id = sessionId(args)
      const closed = await ctx.pty.kill(requireAgent(exec.agent), id)
      return textResult(closed ? `closed terminal session ${id}` : `terminal session ${id} was already closing`)
    },
    presentCall: args => ({ card: 'generic', title: `Close terminal ${(args).sessionId}`, kind: 'delete' }),
  }))

  ctx.tools.register(defineTool({
    name: 'terminal_list',
    description: 'List persistent terminal sessions owned by the current agent.',
    parameters: {},
    execute(_args: Record<string, never>, exec) {
      return Promise.resolve(textResult(renderList(ctx.pty.list(requireAgent(exec.agent)))))
    },
    presentCall: () => ({ card: 'generic', title: 'List terminal sessions', kind: 'read' }),
  }))
}
