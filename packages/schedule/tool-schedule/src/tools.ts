/**
 * Agent-scoped Schedule management tools over the durable session fold.
 * @module @deepseek-ai/dsh-tool-schedule
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  allocateScheduleId,
  createAfterScheduleRecord,
  foldScheduleEvents,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  scheduleView,
} from './domain.ts'
import { flushSchedulePersistence } from './persistence.ts'
import { runScheduleTransaction } from './transaction.ts'
import type {
  AfterScheduleRecord,
  PersistenceUncertainError,
  ScheduleCreateValue,
  ScheduleDeleteValue,
  ScheduleId as ScheduleIdType,
  ScheduleListValue,
  SchedulePersistenceOperation,
  ScheduleToolError,
} from './types.ts'

const VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true, const: 'after' },
    prompt: { type: 'string', required: true },
    afterSeconds: { type: 'integer', required: true },
    scheduledAt: { type: 'string', required: true },
    state: { type: 'string', required: true, enum: ['scheduled', 'overdue'] },
    deliveryMode: { type: 'string', required: true, const: 'session-local' },
  },
} as const

/** Build one exact two-field error schema while preserving its literal code. */
function basicErrorSchema<const C extends string>(code: C) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const BASIC_ERROR_SCHEMAS = [
  basicErrorSchema('invalid_prompt'),
  basicErrorSchema('invalid_selector'),
  basicErrorSchema('invalid_rule'),
  basicErrorSchema('time_out_of_range'),
  basicErrorSchema('corrupt_schedule_log'),
  basicErrorSchema('internal_error'),
] as const

const PERSISTENCE_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, const: 'persistence_uncertain' },
    message: { type: 'string', required: true },
    operation: { type: 'string', required: true, enum: ['create', 'list', 'delete', 'dispatch'] },
    id: { type: 'string' },
  },
} as const

const ERROR_SCHEMAS = [...BASIC_ERROR_SCHEMAS, PERSISTENCE_ERROR_SCHEMA] as const

const CREATE_OUTPUT_SCHEMA = { oneOf: [VIEW_SCHEMA, ...ERROR_SCHEMAS] } as const
const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: VIEW_SCHEMA },
    ...ERROR_SCHEMAS,
  ],
} as const
const DELETE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: false },
        code: { type: 'string', required: true, const: 'schedule_not_found' },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

const CREATE_DESCRIPTION =
  'Create one reminder in the current session. v1 accepts only a non-empty prompt and a positive '
  + 'safe-integer after_seconds delay. Delivery is session-local: the reminder runs on time only '
  + 'while this session is live and otherwise becomes overdue until the session is resumed.'

const LIST_DESCRIPTION =
  'List every active reminder in the current session in creation order, including its exact id, '
  + 'UTC target, scheduled or overdue state, and session-local delivery mode.'

const DELETE_DESCRIPTION =
  'Delete one active reminder in the current session by the exact id returned by schedule_create '
  + 'or schedule_list. Unknown or already-finished ids return deleted false.'

/** Deterministic model content for every canonical Schedule value. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  // The ToolRegistry has already validated the value against the lossless-JSON output schema.
  const text = JSON.stringify(value)
  return [{ type: 'text', text }]
}

/** Pure generic pending card. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Stable error for failures not safe to expose. */
function internalError(): ScheduleToolError {
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}

/** Stable durable-log failure. */
function corruptLogError(): ScheduleToolError {
  return { code: 'corrupt_schedule_log', message: 'The session schedule log is corrupt.' }
}

/** Stable persistence uncertainty with the known operation identity. */
function persistenceError(
  operation: SchedulePersistenceOperation,
  id?: ScheduleIdType,
): PersistenceUncertainError {
  return {
    code: 'persistence_uncertain',
    message: 'Schedule persistence is uncertain; retry with schedule_list before relying on this result.',
    operation,
    ...id === undefined ? {} : { id },
  }
}

/** Translate a contained input failure to the closed tool union. */
function inputError(error: ScheduleInputError): ScheduleToolError {
  return { code: error.code, message: error.message }
}

/** Fold only after a successful preflight, mapping corruption to a stable value. */
function foldForTool(agent: Agent): ReturnType<typeof foldScheduleEvents> | ScheduleToolError {
  try {
    return foldScheduleEvents(agent.session.events, agent.session.header.seedLength ?? 0)
  } catch (error: unknown) {
    return error instanceof ScheduleLogError ? corruptLogError() : internalError()
  }
}

/** Whether a fold attempt produced an error rather than replay state. */
function isToolError(
  value: ReturnType<typeof foldScheduleEvents> | ScheduleToolError,
): value is ScheduleToolError {
  return 'code' in value
}

/** Require one persistence checkpoint without leaking the backend failure. */
async function preflight(
  rootCtx: Context,
  agent: Agent,
  operation: SchedulePersistenceOperation,
  id?: ScheduleIdType,
): Promise<PersistenceUncertainError | undefined> {
  try {
    await flushSchedulePersistence(rootCtx, agent.session)
    return undefined
  } catch {
    return persistenceError(operation, id)
  }
}

/** Validate the v1 selector constraints that the open parameter root cannot express. */
function validateCreateArgs(args: { prompt: string; after_seconds: number }): ScheduleToolError | undefined {
  const keys = Object.keys(args as unknown as Record<string, unknown>)
  if (keys.some(key => key !== 'prompt' && key !== 'after_seconds')) {
    return {
      code: 'invalid_selector',
      message: 'schedule_create accepts exactly the after_seconds selector in this version.',
    }
  }
  if (args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  if (!Number.isSafeInteger(args.after_seconds) || args.after_seconds <= 0) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  return undefined
}

/**
 * Register all three Schedule tools in one exact agent scope.
 * @param rootCtx - Global service context owning sessions and durability.
 * @param toolCtx - Exact agent-scoped context receiving the definitions.
 * @param agent - Exact live owner whose session the tools mutate.
 * @param onDurableChange - Called after every successful preflight and again after a create or actual delete barrier succeeds.
 * @returns Idempotent aggregate disposer for the three registrations.
 */
export function registerScheduleTools(
  rootCtx: Context,
  toolCtx: Context,
  agent: Agent,
  onDurableChange: () => void,
): () => void {
  const disposers: Array<() => void> = []

  /** A projection observer cannot reverse a completed durability barrier. */
  const notifyDurableChange = (): void => {
    try {
      onDurableChange()
    } catch (error: unknown) {
      rootCtx.logger.warn(`tool-schedule: durable-change observer failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'Reminder content to present when the target becomes due.',
        },
        after_seconds: {
          type: 'number',
          required: true,
          description: 'Positive safe-integer delay in seconds.',
        },
      },
      output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleCreateValue> {
        if (exec.agent !== agent) return internalError()
        const invalid = validateCreateArgs(args)
        if (invalid !== undefined) return invalid
        return runScheduleTransaction(agent, async () => {
          const uncertain = await preflight(rootCtx, agent, 'create')
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          const id = allocateScheduleId(folded)
          let record: AfterScheduleRecord
          try {
            record = createAfterScheduleRecord(id, args.prompt, args.after_seconds, Date.now())
          } catch (error: unknown) {
            return error instanceof ScheduleInputError ? inputError(error) : internalError()
          }
          try {
            agent.session.append('schedule/change', {
              version: 1,
              operation: 'create',
              schedule: record,
            })
          } catch {
            return internalError()
          }
          const barrier = await preflight(rootCtx, agent, 'create', id)
          if (barrier !== undefined) return barrier
          notifyDurableChange()
          return scheduleView(record, Date.now())
        })
      },
      presentCall: args => present('Create reminder', 'other', args.prompt),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
      async execute(_args, exec): Promise<ScheduleListValue> {
        if (exec.agent !== agent) return internalError()
        return runScheduleTransaction(agent, async () => {
          const uncertain = await preflight(rootCtx, agent, 'list')
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          const now = Date.now()
          return folded.active.map(record => scheduleView(record, now))
        })
      },
      presentCall: () => present('List reminders', 'read'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'schedule_delete',
      description: DELETE_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact session-local schedule id.' },
      },
      output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<ScheduleDeleteValue> {
        if (args.id.length === 0 || args.id.trim() !== args.id) {
          return { code: 'invalid_rule', message: 'schedule_delete id must be non-empty without surrounding whitespace.' }
        }
        const id = ScheduleId(args.id)
        if (exec.agent !== agent) return internalError()
        return runScheduleTransaction(agent, async () => {
          const uncertain = await preflight(rootCtx, agent, 'delete', id)
          if (uncertain !== undefined) return uncertain
          notifyDurableChange()
          const folded = foldForTool(agent)
          if (isToolError(folded)) return folded
          if (!folded.active.some(record => record.id === id)) {
            return { id, deleted: false, code: 'schedule_not_found' }
          }
          try {
            agent.session.append('schedule/change', { version: 1, operation: 'delete', id })
          } catch {
            return internalError()
          }
          const barrier = await preflight(rootCtx, agent, 'delete', id)
          if (barrier !== undefined) return barrier
          notifyDurableChange()
          return { id, deleted: true }
        })
      },
      presentCall: args => present('Delete reminder', 'other', args.id),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
