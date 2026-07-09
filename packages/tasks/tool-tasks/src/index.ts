/**
 * The model-facing background task control tools: `task_output`, `task_list`,
 * `task_kill`. Kind-agnostic — a background bash command and a background
 * subagent read, list, and die through the same three schemas — with every
 * task concern (ids, isolation, cursors, settlement) behind the `ctx.tasks`
 * registry (`@deepseek-ai/dsh-tasks`).
 *
 * This plugin IS the control surface: it calls `ctx.tasks.attachSurface()` on
 * load, which is what arms producers' `ctx.tasks.start()` (the runtime's
 * preflight refuses background work while no surface could collect or stop it).
 *
 * Completion notices: when a task settles, a short notice is injected into
 * the owning agent's session (`agent.inject()` — durable context for the NEXT
 * model request, not a wake-up). A task whose terminal state the model
 * already saw (`snapshot.reported` — an explicit kill, or a read/wait that
 * returned the end) is suppressed, so the model never gets a redundant
 * "finished" for work it just collected.
 *
 * @module @deepseek-ai/dsh-tool-tasks
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { TaskId } from '@deepseek-ai/dsh-tasks'
import type { TaskSnapshot } from '@deepseek-ai/dsh-tasks'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-tasks'
export const inject = ['tools', 'tasks', 'systemPrompt']

/** Config: the `task_output` wait bounds (defaulted, capped — never hardcoded). */
export interface Config {
  /** Wait duration applied when `task_output` sets `wait` without `timeout_ms` (default 30s). */
  waitTimeoutMs?: number
  /** Hard cap on any single wait; a larger model-supplied `timeout_ms` is clamped down to it (default 10min). */
  maxWaitTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  waitTimeoutMs: z.number().min(1).default(30_000),
  maxWaitTimeoutMs: z.number().min(1).default(600_000),
})

/**
 * Render a snapshot's status line — generic status plus the producer's
 * kind-specific detail: `[status: completed, exit code: 0]`,
 * `[status: failed, max-tokens]`, `[status: running]`. Exported for tests
 * and for producers that want a consistent line in their own results.
 * @param snapshot - the task state to render.
 * @returns the bracketed status line.
 */
export function statusLine(snapshot: TaskSnapshot): string {
  return snapshot.detail !== undefined
    ? `[status: ${snapshot.status}, ${snapshot.detail}]`
    : `[status: ${snapshot.status}]`
}

/**
 * Reject an empty `task_id`. Type/presence come from the SchemaSpec
 * validation; only the non-empty constraint, which the DSL cannot express,
 * is checked here.
 */
function validateTaskId(value: string): TaskId {
  if (value.length === 0) {
    throw new Error(`invalid task_id: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return TaskId(value)
}

/** Pending-state presentation shared by the three control tools (generic cards by design — a task read/kill is not a terminal). */
function presentTaskCall(title: string, kind: 'read' | 'execute', rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput !== undefined ? { rawInput } : {} }
}

export function apply(ctx: Context, config: Config): void {
  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 600_000
  if (waitDefault > waitCap) {
    throw new Error(`tool-tasks: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`)
  }

  // The registry's misconfiguration fence: producers can register background
  // work only while a surface capable of collecting/stopping it is attached.
  ctx.tasks.attachSurface('tool-tasks')

  // The cross-call HABIT the per-tool descriptions cannot carry. Order 106:
  // right after tool:bash (105), before deployment product sections.
  ctx.systemPrompt.section({
    name: 'tool:tasks',
    order: 106,
    text: 'Track every background task id you start. You are notified in-session when a task finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running task\'s work. Before giving a final answer, collect every still-relevant task with task_output (set wait: true only when you are genuinely blocked on it), and task_kill tasks that stopped mattering.',
  })

  // Background completion → inject a notice into the owning agent's session.
  // `ctx.get('agents')` (not static inject): this listener runs from a
  // detached settlement continuation on the tasks fiber — a foreign fiber —
  // where the `ctx.agents` property proxy would throw; `ctx.get` is the
  // topology-independent lookup. No registry mounted → drop the notice.
  ctx.tasks.onTaskDone((snapshot) => {
    // A reported terminal state was already surfaced by an explicit
    // read/wait/kill response — a notice would be a redundant "finished".
    if (snapshot.reported || snapshot.ownerSession === undefined) return
    const agent = ctx.get('agents')?.list().find(a => a.session.header.id === snapshot.ownerSession)
    if (!agent) return
    try {
      agent.inject(
        [{ type: 'text', text: `background task ${snapshot.id} (${snapshot.kind}: ${snapshot.label}) finished ${statusLine(snapshot)}. Read its output with task_output.` }],
        { source: { kind: 'plugin', plugin: 'tool-tasks' } },
      )
    } catch (error: unknown) {
      // The ONE expected failure: the agent was disposed between settlement
      // and this injection (inject throws `agent "<id>" is disposed`). That
      // race is benign — drop the notice. Anything else must surface.
      if (error instanceof Error && error.message.includes('is disposed')) return
      throw error
    }
  })

  ctx.tools.register(defineTool({
    name: 'task_output',
    description: 'Read output/status from a background task (started by a tool with `run_in_background`). '
      + 'Stream tasks (bash) return only output produced since your previous task_output call; '
      + 'final-output tasks (subagent) return the final answer once the task finishes. '
      + 'Every response ends with a [status: ...] line. Non-blocking by default; '
      + 'set `wait: true` to block until the task finishes (bounded by a capped timeout) when you are genuinely blocked on its result.',
    // Deliberately NO ToolDefinition.timeoutMs: the timeout-policy plugin
    // replaces a timed-out call with a structured TOOL_TIMEOUT failure, but a
    // timed-out wait here is a SUCCESS that reports [status: running] — the
    // task's state must reach the model either way, so the wait bounds its
    // own deadline (waitTimeoutMs/maxWaitTimeoutMs) via ctx.tasks.wait.
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by the tool that started the background work.' },
      wait: { type: 'boolean', description: 'Block until the task reaches a terminal status or the timeout expires. A timed-out wait returns [status: running] and leaves the task alive.' },
      timeout_ms: { type: 'number', description: 'Max wait in milliseconds (only meaningful with wait: true). Defaults to the configured wait timeout; capped by the configured maximum.' },
    },
    async execute(args, exec) {
      const id = validateTaskId(args.task_id)
      if (args.wait === true) {
        const timeout = Math.min(args.timeout_ms ?? waitDefault, waitCap)
        await ctx.tasks.wait(id, timeout, exec.agent, exec.signal)
      }
      const read = ctx.tasks.read(id, exec.agent)
      const body = read.text.length > 0 ? read.text : '(no new output)'
      const separator = body.endsWith('\n') ? '' : '\n'
      return [{ type: 'text', text: `${body}${separator}${statusLine(read.snapshot)}` }]
    },
    presentCall: args => presentTaskCall(`Read output from background task ${args.task_id}`, 'read', args.task_id),
  }))

  ctx.tools.register(defineTool({
    name: 'task_list',
    description: 'List your background tasks (running and finished) with their ids, kinds, and statuses.',
    parameters: {},
    // execute is synchronous (registry reads + string shaping) but the
    // ToolDefinition contract wants a Promise — hence resolve(), not async.
    execute(_args, exec) {
      const tasks = ctx.tasks.list(exec.agent)
      const text = tasks.length === 0
        ? '(no background tasks)'
        : tasks.map(t => `${t.id} [${t.kind}] ${t.status} — ${t.label}`).join('\n')
      return Promise.resolve([{ type: 'text', text }])
    },
    presentCall: () => presentTaskCall('List background tasks', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'task_kill',
    description: 'Request cancellation of a running background task by task id. Returns immediately; the task settles as killed once its work actually stops.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by the tool that started the background work.' },
      reason: { type: 'string', description: 'Optional short reason, recorded in the log and forwarded to the task.' },
    },
    execute(args, exec) {
      const id = validateTaskId(args.task_id)
      const result = ctx.tasks.kill(id, exec.agent, args.reason)
      if (result === 'already-terminal') {
        // ctx.tasks.get, NOT .read: a read would consume a stream task's
        // pending delta just to describe the terminal state.
        const snapshot = ctx.tasks.get(id, exec.agent)
        return Promise.resolve([{ type: 'text', text: `task ${id} had already finished ${statusLine(snapshot)}` }])
      }
      return Promise.resolve([{ type: 'text', text: `requested cancellation of task ${id}` }])
    },
    presentCall: args => presentTaskCall(`Kill background task ${args.task_id}`, 'execute', args.task_id),
  }))
}
