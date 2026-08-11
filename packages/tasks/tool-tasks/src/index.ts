/**
 * Model-facing `task_output`, `task_list`, and `task_kill` tools over
 * `ctx.tasks`. Loading the plugin attaches the controller required by
 * producers. It also delivers unreported completions to the owning agent:
 * injected into a busy owner's next step, or opening a turn on an idle one
 * under the default `wakeup` delivery, bounded per owner.
 * @module @deepseek-ai/dsh-tool-tasks
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-retention'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { TaskId } from '@deepseek-ai/dsh-tasks'
import type { TaskSnapshot } from '@deepseek-ai/dsh-tasks'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'

export const name = 'tool-tasks'
export const inject = ['tools', 'tasks', 'systemPrompt']

/**
 * How an unreported completion reaches an owner that is already idle: `wakeup`
 * opens a turn for it, `quiet` leaves it pending until something else wakes the
 * owner. A busy owner is injected either way.
 */
export type CompletionDelivery = 'quiet' | 'wakeup'

/** Configures bounded `task_output` waits and completion-notice delivery. */
export interface Config {
  /** Wait duration applied when `task_output` sets `wait` without `timeout_ms` (default 30s). */
  waitTimeoutMs?: number
  /** Hard cap on any single wait; a larger model-supplied `timeout_ms` is clamped down to it (default 10min). */
  maxWaitTimeoutMs?: number
  /** Whether a completion opens a turn on an idle owner (default `wakeup`). */
  completionDelivery?: CompletionDelivery
  /**
   * Turns one owner may have opened by completion wakes before the next
   * notice degrades to injection, reset by any user-authored input (default 3).
   * Bounds the self-exciting chain where a woken turn starts the task whose
   * completion wakes it again.
   */
  maxConsecutiveWakes?: number
}

export const Config: z<Config> = z.object({
  waitTimeoutMs: z.number().min(1).default(30_000),
  maxWaitTimeoutMs: z.number().min(1).default(600_000),
  completionDelivery: z.union(['quiet', 'wakeup'] as const).default('wakeup'),
  maxConsecutiveWakes: z.number().min(1).default(3),
})

/** Task state safe for model-authored programs; ownership/bookkeeping fields are omitted. */
export interface PublicTaskSnapshot {
  id: string
  kind: string
  label: string
  status: TaskSnapshot['status']
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** Shared schema for task-control outputs. */
const PUBLIC_TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    label: { type: 'string', required: true },
    status: {
      type: 'string',
      required: true,
      enum: ['running', 'stopping', 'completed', 'killed', 'failed'],
    },
    detail: { type: 'string' },
    startedAt: { type: 'integer', required: true },
    finishedAt: { type: 'integer' },
  },
} as const

/** Remove task ownership and notification bookkeeping from a registry snapshot. */
function publicTask(snapshot: TaskSnapshot): PublicTaskSnapshot {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...snapshot.detail !== undefined ? { detail: snapshot.detail } : {},
    startedAt: snapshot.startedAt,
    ...snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {},
  }
}

/**
 * Render generic status with optional producer detail.
 * @param snapshot - task state to render.
 * @returns a bracketed status line.
 */
export function statusLine(snapshot: Pick<TaskSnapshot, 'status' | 'detail'>): string {
  return snapshot.detail !== undefined
    ? `[status: ${snapshot.status}, ${snapshot.detail}]`
    : `[status: ${snapshot.status}]`
}

const encoder = new TextEncoder()

function retainTail(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function retainHead(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function fitWithSuffix(
  content: string,
  suffix: string,
  maxBytes: number | undefined,
  omitted: string,
): string {
  const complete = `${content}${suffix}`
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const fixed = `${content.endsWith(omitted.trimStart()) ? '' : omitted}${suffix}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes >= maxBytes) return retainTail(fixed, maxBytes)
  return `${retainTail(content, maxBytes - fixedBytes)}${fixed}`
}

/**
 * One-line account of a settled task for the `notice` form's collapsed row.
 * @param snapshot - the settled task.
 * @returns its kind, label, and status, bounded like every notice summary.
 */
function completionSummary(snapshot: TaskSnapshot): string {
  return boundContextSummary(`${snapshot.kind} ${snapshot.label} ${statusLine(snapshot)}`)
}

function fitCompletionNotice(snapshot: TaskSnapshot): string {
  const prefix = `background task ${snapshot.id}`
  const detail = ` (${snapshot.kind}: ${snapshot.label}) finished ${statusLine(snapshot)}`
  const action = '\nDone; task_output.'
  const complete = `${prefix}${detail}. Read its output with task_output.`
  const maxBytes = snapshot.outputLimitBytes
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const omitted = '\n[notice truncated]'
  const fixed = `${prefix}${omitted}${action}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes <= maxBytes) {
    return fixedBytes === maxBytes
      ? fixed
      : `${prefix}${retainHead(detail, maxBytes - fixedBytes)}${omitted}${action}`
  }
  const compact = `${prefix}${action}`
  const compactBytes = encoder.encode(compact).byteLength
  if (compactBytes <= maxBytes) return compact
  const actionBytes = encoder.encode(action).byteLength
  if (actionBytes >= maxBytes) return retainTail(action, maxBytes)
  return `${retainHead(prefix, maxBytes - actionBytes)}${action}`
}

function rawSingleText(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  if (block?.type !== 'text') return undefined
  return block.text
}

function boundSingleText(content: readonly ContentBlock[], maxBytes: number): ContentBlock[] | undefined {
  const text = rawSingleText(content)
  if (text === undefined) return undefined
  return [{
    type: 'text',
    text: fitWithSuffix(text, '', maxBytes, '\n[result truncated]'),
  }]
}

function visibleOutputLimit(ctx: Context, exec: ToolExecution): number | undefined {
  if (exec.name !== 'task_output' && exec.name !== 'task_kill') return undefined
  const taskId = (exec.arguments as { task_id?: unknown } | null | undefined)?.task_id
  if (typeof taskId !== 'string' || taskId.length === 0) return undefined
  return ctx.tasks.list(exec.agent).find(snapshot => snapshot.id === taskId)?.outputLimitBytes
}

/** Validate the non-empty constraint that ParameterSchemaSpec cannot express. */
function validateTaskId(value: string): TaskId {
  if (value.length === 0) {
    throw new Error(`invalid task_id: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return TaskId(value)
}

/** Pending presentation shared by the three generic task controls. */
function presentTaskCall(title: string, kind: 'read' | 'execute', rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput !== undefined ? { rawInput } : {} }
}

export function apply(ctx: Context, config: Config): void {
  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 600_000
  const delivery = config.completionDelivery ?? 'wakeup'
  const wakeBudget = config.maxConsecutiveWakes ?? 3

  // Turns this plugin opened on each owner since that owner last consumed
  // human input. Keyed by the exact Agent, so a same-session replacement
  // starts with a full budget.
  const spentWakes = new WeakMap<Agent, number>()
  if (waitDefault > waitCap) {
    throw new Error(`tool-tasks: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`)
  }
  // A budget is a count of turns. `Infinity` would leave the runaway chain this
  // field exists to bound unbounded, and a fraction never names a turn at all.
  if (!Number.isSafeInteger(wakeBudget)) {
    throw new Error(`tool-tasks: maxConsecutiveWakes (${wakeBudget}) must be a whole number of turns`)
  }
  // Nothing spends the budget under quiet delivery, so nothing needs to refill it.
  if (delivery === 'wakeup') {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      // Claiming is the point the human's input actually enters a step; a notice
      // this plugin itself queued must not refill the budget it just spent.
      if (message.source.kind === 'user') spentWakes.delete(agent)
    })
  }

  const outputLimits = new WeakMap<ToolExecution, number>()
  ctx.on('tools/pre-execute', (exec, next) => {
    const maxBytes = visibleOutputLimit(ctx, exec)
    if (maxBytes !== undefined) outputLimits.set(exec, maxBytes)
    return next()
  }, { prepend: true })
  const finalizeTaskContent: NonNullable<ToolDefinition['finalizeContent']> = (exec, result) => {
    const maxBytes = outputLimits.get(exec) ?? visibleOutputLimit(ctx, exec)
    outputLimits.delete(exec)
    if (maxBytes === undefined) return undefined
    if (exec.name === 'task_output' && !result.isError) {
      // This definition owns and schema-validates the canonical value. Preserve
      // its output/status split only while policy left the default rendering intact.
      const value = result.value as unknown as { text: string; task: PublicTaskSnapshot }
      const body = value.text.length > 0 ? value.text : '(no new output)'
      const content = body.endsWith('\n') ? body.slice(0, -1) : body
      const suffix = `\n${statusLine(value.task)}`
      if (rawSingleText(result.content) === `${content}${suffix}`) {
        return [{
          type: 'text',
          text: fitWithSuffix(content, suffix, maxBytes, '\n[output truncated]'),
        }]
      }
    }
    return boundSingleText(result.content, maxBytes)
  }

  // Producers may start work only while a controller is attached.
  ctx.tasks.attachController('tool-tasks')

  // Cross-call guidance follows the bash section and precedes product sections.
  ctx.systemPrompt.section({
    name: 'tool:tasks',
    order: 106,
    text: 'Track every background task id you start. You are notified in-session when a task finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running task\'s work. Before giving a final answer, collect every still-relevant task with task_output (set wait: true only when you are genuinely blocked on it), and task_kill tasks that stopped mattering.',
  })

  // Use the exact lifecycle owner; reusable ids could resolve to a replacement.
  // A busy owner is injected: the notice waits in its next-step inbox, which
  // the turn cannot close over, so tasks settling together cost one step. An
  // idle owner is woken instead, because an unclaimed notice is a completion
  // the model never learns about. Either way, disposal before the claim
  // discards it with the owner, and teardown settlements arrive `reported`.
  //
  // The registry routes each settlement to the listeners its owner's scope
  // chain reaches, so a mount under one preset never sees another preset's
  // agents; this listener owns delivery, not the choice of whom to deliver to.
  ctx.tasks.onTaskDone((snapshot, owner) => {
    if (snapshot.reported || owner === undefined) return
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: fitCompletionNotice(snapshot),
      }],
      source: {
        kind: 'plugin',
        plugin: 'tool-tasks',
        form: 'notice',
        summary: completionSummary(snapshot),
      },
    })
    const spent = spentWakes.get(owner) ?? 0
    if (delivery === 'wakeup' && owner.status === 'idle' && spent < wakeBudget) {
      spentWakes.set(owner, spent + 1)
      owner.followup(message)
      return
    }
    owner.inject(message)
  })

  ctx.tools.register(defineTool({
    name: 'task_output',
    description: 'Read a background task. Stream tasks return only output since the previous read; '
      + 'final-output tasks return their result after settlement. Every response ends with '
      + '`[status: ...]`. Reads are non-blocking unless `wait: true`, which waits up to the configured cap.',
    // A timed-out wait returns task state rather than a TOOL_TIMEOUT error, so
    // this tool owns its deadline instead of using ToolDefinition.timeoutMs.
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by the tool that started the background work.' },
      wait: { type: 'boolean', description: 'Block until the task reaches a terminal status or the timeout expires. A timed-out wait returns [status: running] and leaves the task alive.' },
      timeout_ms: { type: 'number', description: 'Max wait in milliseconds (only meaningful with wait: true). Defaults to the configured wait timeout; capped by the configured maximum.' },
    },
    finalizeContent: finalizeTaskContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          task: { ...PUBLIC_TASK_SCHEMA, required: true },
        },
      },
      render: (_args, value) => {
        const body = value.text.length > 0 ? value.text : '(no new output)'
        const separator = body.endsWith('\n') ? '' : '\n'
        return [{ type: 'text', text: `${body}${separator}${statusLine(value.task)}` }]
      },
    },
    async execute(args, exec) {
      const id = validateTaskId(args.task_id)
      if (args.wait === true) {
        const timeout = Math.min(args.timeout_ms ?? waitDefault, waitCap)
        await ctx.tasks.wait(id, timeout, exec.agent, exec.signal)
      }
      const read = ctx.tasks.read(id, exec.agent)
      return { text: read.text, task: publicTask(read.snapshot) }
    },
    presentCall: args => presentTaskCall(`Read output from background task ${args.task_id}`, 'read', args.task_id),
  }))

  ctx.tools.register(defineTool({
    name: 'task_list',
    description: 'List your background tasks (running and finished) with their ids, kinds, and statuses.',
    parameters: {},
    output: {
      schema: { type: 'array', items: PUBLIC_TASK_SCHEMA },
      render: (_args, tasks) => [{
        type: 'text',
        text: tasks.length === 0
          ? '(no background tasks)'
          : tasks.map(t => `${t.id} [${t.kind}] ${t.status} — ${t.label}`).join('\n'),
      }],
    },
    execute(_args, exec) {
      const tasks = ctx.tasks.list(exec.agent)
      return Promise.resolve(tasks.map(publicTask))
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
    finalizeContent: finalizeTaskContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: {
            type: 'string',
            required: true,
            enum: ['cancellation-requested', 'already-finished'],
          },
          task: { ...PUBLIC_TASK_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'already-finished'
          ? `task ${value.task.id} had already finished ${statusLine(value.task)}`
          : `requested cancellation of task ${value.task.id}`,
      }],
    },
    execute(args, exec) {
      const id = validateTaskId(args.task_id)
      const result = ctx.tasks.kill(id, exec.agent, args.reason)
      // A snapshot describes current state without consuming pending output.
      const snapshot = publicTask(ctx.tasks.get(id, exec.agent))
      return Promise.resolve({
        outcome: result === 'already-finished' ? 'already-finished' as const : 'cancellation-requested' as const,
        task: snapshot,
      })
    },
    presentCall: args => presentTaskCall(`Kill background task ${args.task_id}`, 'execute', args.task_id),
  }))
}
