/**
 * Strict Schedule decoding, replay, time validation, and framing.
 * @module @deepseek-ai/dsh-tool-schedule
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AfterScheduleRecord,
  ScheduleChange,
  ScheduleId as ScheduleIdType,
  ScheduleReminderPresentation,
  ScheduleView,
} from './types.ts'

/** Durable Schedule protocol version implemented by this package. */
export const SCHEDULE_CHANGE_VERSION = 1 as const

const MAX_FOUR_DIGIT_YEAR_MS = Date.parse('9999-12-31T23:59:59.999Z')
const UTC_INSTANT = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/

/** Error from malformed or transition-invalid durable Schedule data. */
export class ScheduleLogError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'corrupt_schedule_log' as const

  /**
   * Construct a durable-log failure.
   * @param message - Package-specific violated invariant.
   */
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleLogError'
  }
}

/** Error from a model-supplied after rule that cannot become a record. */
export class ScheduleInputError extends Error {
  /** Stable public Schedule input code. */
  readonly code: 'invalid_prompt' | 'invalid_rule' | 'time_out_of_range'

  /**
   * Construct a stable input failure.
   * @param code - Public Schedule error discriminator.
   * @param message - Stable public diagnostic.
   */
  constructor(
    code: 'invalid_prompt' | 'invalid_rule' | 'time_out_of_range',
    message: string,
  ) {
    super(message)
    this.name = 'ScheduleInputError'
    this.code = code
  }
}

/** Pure replay result, retaining active create order and every used id. */
export interface FoldedSchedules {
  /** Active records in their original create order. */
  readonly active: readonly AfterScheduleRecord[]
  /** Every id ever created in this session-local suffix. */
  readonly seenIds: readonly ScheduleIdType[]
}

/**
 * Brand a raw session-local id without changing its runtime value.
 * @param value - Raw session-local id.
 * @returns The same string with the Schedule brand.
 */
export function ScheduleId(value: string): ScheduleIdType {
  return value as ScheduleIdType
}

/** Whether an unknown value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require exactly the named durable object keys. */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

/** Validate one stable session-local id at the durable boundary. */
function decodeId(value: unknown): ScheduleIdType {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ScheduleLogError('schedule id must be a non-empty string without surrounding whitespace')
  }
  return ScheduleId(value)
}

/** Validate one canonical four-digit-year UTC instant. */
function decodeInstant(value: unknown): string {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) {
    throw new ScheduleLogError('scheduledAt must be a canonical four-digit-year RFC 3339 UTC instant')
  }
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new ScheduleLogError('scheduledAt is not a real UTC calendar instant')
  }
  return value
}

/** Decode the exact v1 after record shape. */
function decodeAfterRecord(value: unknown): AfterScheduleRecord {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'kind', 'prompt', 'afterSeconds', 'scheduledAt'])) {
    throw new ScheduleLogError('after schedule must contain exactly id, kind, prompt, afterSeconds, and scheduledAt')
  }
  if (value['kind'] !== 'after') throw new ScheduleLogError('v1 schedule kind must be "after"')
  const prompt = value['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.trim() !== prompt) {
    throw new ScheduleLogError('after prompt must be non-empty and already trimmed')
  }
  const afterSeconds = value['afterSeconds']
  if (!Number.isSafeInteger(afterSeconds) || (afterSeconds as number) <= 0) {
    throw new ScheduleLogError('afterSeconds must be a positive safe integer')
  }
  return Object.freeze({
    id: decodeId(value['id']),
    kind: 'after',
    prompt,
    afterSeconds: afterSeconds as number,
    scheduledAt: decodeInstant(value['scheduledAt']),
  })
}

/**
 * Decode one strict version-1 `schedule/change` payload.
 * @param value - Untrusted durable JSON value.
 * @returns Detached, frozen Schedule change.
 */
export function decodeScheduleChange(value: unknown): ScheduleChange {
  if (!isRecord(value)) throw new ScheduleLogError('schedule/change payload must be an object')
  if (value['version'] !== SCHEDULE_CHANGE_VERSION) {
    throw new ScheduleLogError('schedule/change version must be 1')
  }
  switch (value['operation']) {
    case 'create':
      if (!hasExactKeys(value, ['version', 'operation', 'schedule'])) {
        throw new ScheduleLogError('schedule create must contain exactly version, operation, and schedule')
      }
      return Object.freeze({
        version: SCHEDULE_CHANGE_VERSION,
        operation: 'create',
        schedule: decodeAfterRecord(value['schedule']),
      })
    case 'delete':
    case 'dispatch': {
      if (!hasExactKeys(value, ['version', 'operation', 'id'])) {
        throw new ScheduleLogError(`schedule ${value['operation']} must contain exactly version, operation, and id`)
      }
      return Object.freeze({
        version: SCHEDULE_CHANGE_VERSION,
        operation: value['operation'],
        id: decodeId(value['id']),
      })
    }
    default:
      throw new ScheduleLogError('schedule/change operation must be create, delete, or dispatch')
  }
}

/**
 * Fold the package-owned stream after the durable fork seed boundary.
 * @param events - Complete ordered session log or candidate-extended log.
 * @param seedLength - Inherited prefix length excluded from child ownership.
 * @returns Active records and all previously used ids.
 */
export function foldScheduleEvents(
  events: readonly SessionEvent[],
  seedLength = 0,
): FoldedSchedules {
  if (!Number.isSafeInteger(seedLength) || seedLength < 0 || seedLength > events.length) {
    throw new ScheduleLogError('schedule seedLength must be within the supplied event log')
  }
  const active = new Map<ScheduleIdType, AfterScheduleRecord>()
  const seen = new Set<ScheduleIdType>()
  for (const event of events.slice(seedLength)) {
    if (event.type !== 'schedule/change') continue
    const change = decodeScheduleChange(event.data)
    switch (change.operation) {
      case 'create':
        if (seen.has(change.schedule.id)) {
          throw new ScheduleLogError(`schedule id ${JSON.stringify(change.schedule.id)} was reused`)
        }
        seen.add(change.schedule.id)
        active.set(change.schedule.id, change.schedule)
        break
      case 'delete':
      case 'dispatch':
        if (!active.delete(change.id)) {
          throw new ScheduleLogError(`schedule ${change.operation} targets inactive id ${JSON.stringify(change.id)}`)
        }
        break
      /* v8 ignore next 3 -- decodeScheduleChange returns a closed operation union. */
      default: {
        const unreachable: never = change
        throw new ScheduleLogError(`unknown decoded schedule change ${String(unreachable)}`)
      }
    }
  }
  return Object.freeze({
    active: Object.freeze([...active.values()]),
    seenIds: Object.freeze([...seen]),
  })
}

/**
 * Allocate the next readable id without reusing any prior session-local id.
 * @param folded - Fold containing every previously created id.
 * @returns A fresh `schedule-N` identity.
 */
export function allocateScheduleId(folded: FoldedSchedules): ScheduleIdType {
  const seen = new Set(folded.seenIds)
  let sequence = seen.size + 1
  let candidate = ScheduleId(`schedule-${sequence}`)
  while (seen.has(candidate)) {
    sequence += 1
    candidate = ScheduleId(`schedule-${sequence}`)
  }
  return candidate
}

/**
 * Validate a model after rule and compute its durable target.
 * @param id - Already allocated session-local id.
 * @param prompt - User-authored reminder content.
 * @param afterSeconds - Requested positive delay.
 * @param now - Single creation-time wall-clock sample in epoch milliseconds.
 * @returns Frozen durable after record.
 */
export function createAfterScheduleRecord(
  id: ScheduleIdType,
  prompt: string,
  afterSeconds: number,
  now: number,
): AfterScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) {
    throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  if (!Number.isSafeInteger(afterSeconds) || afterSeconds <= 0) {
    throw new ScheduleInputError('invalid_rule', 'after_seconds must be a positive safe integer.')
  }
  const delay = afterSeconds * 1_000
  const target = now + delay
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(delay)
    || !Number.isSafeInteger(target) || target <= now || target > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleInputError(
      'time_out_of_range',
      'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.',
    )
  }
  const scheduledAt = new Date(target).toISOString()
  /* v8 ignore next -- a safe target within the four-digit Date range always formats canonically. */
  if (!UTC_INSTANT.test(scheduledAt)) {
    throw new ScheduleInputError(
      'time_out_of_range',
      'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.',
    )
  }
  return Object.freeze({
    id,
    kind: 'after',
    prompt: normalizedPrompt,
    afterSeconds,
    scheduledAt,
  })
}

/**
 * Derive one execution-local management view.
 * @param record - Active durable record.
 * @param now - Wall-clock sample used for its timing state.
 * @returns Complete session-local view.
 */
export function scheduleView(record: AfterScheduleRecord, now: number): ScheduleView {
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    prompt: record.prompt,
    afterSeconds: record.afterSeconds,
    scheduledAt: record.scheduledAt,
    state: now >= Date.parse(record.scheduledAt) ? 'overdue' : 'scheduled',
    deliveryMode: 'session-local',
  })
}

/**
 * Derive the Web receipt for one dispatch from its owning stream segment.
 * A child-owned dispatch cannot cross the current fork's `seedLength`.
 * An inherited dispatch pairs with its nearest preceding same-id create, so
 * resumed ancestors remain renderable and nested forks may reuse local ids.
 * @param events - Complete contiguous Session log.
 * @param dispatchSeq - Exact event seq to present.
 * @param seedLength - Inherited fork prefix length.
 * @returns The immutable receipt, or `undefined` when the selected event is not a dispatch.
 */
export function scheduleReminderPresentation(
  events: readonly SessionEvent[],
  dispatchSeq: number,
  seedLength = 0,
): ScheduleReminderPresentation | undefined {
  if (!Number.isSafeInteger(dispatchSeq) || dispatchSeq < 0) {
    throw new ScheduleLogError('schedule presentation seq must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(seedLength) || seedLength < 0 || seedLength > events.length) {
    throw new ScheduleLogError('schedule seedLength must be within the supplied event log')
  }
  const event = events[dispatchSeq]
  if (event === undefined || event.seq !== dispatchSeq) {
    throw new ScheduleLogError('schedule presentation seq must identify the matching contiguous event')
  }
  if (event.type !== 'schedule/change') return undefined
  const dispatch = decodeScheduleChange(event.data)
  if (dispatch.operation !== 'dispatch') return undefined

  const segmentStart = dispatchSeq < seedLength ? 0 : seedLength
  for (let index = dispatchSeq - 1; index >= segmentStart; index -= 1) {
    const candidate = events[index]
    if (candidate?.type !== 'schedule/change') continue
    const change = decodeScheduleChange(candidate.data)
    switch (change.operation) {
      case 'create':
        if (change.schedule.id !== dispatch.id) break
        return Object.freeze({
          scheduleId: change.schedule.id,
          prompt: change.schedule.prompt,
          occurrenceAt: change.schedule.scheduledAt,
        })
      case 'delete':
      case 'dispatch':
        if (change.id === dispatch.id) {
          throw new ScheduleLogError(`schedule dispatch targets inactive id ${JSON.stringify(dispatch.id)}`)
        }
        break
      /* v8 ignore next 3 -- decodeScheduleChange returns a closed operation union. */
      default: {
        const unreachable: never = change
        throw new ScheduleLogError(`unknown decoded schedule change ${String(unreachable)}`)
      }
    }
  }
  throw new ScheduleLogError(`schedule dispatch targets inactive id ${JSON.stringify(dispatch.id)}`)
}

/**
 * Render the fixed injection-resistant model framing for a due reminder.
 * @param record - Due active record.
 * @returns Stable model-visible text with JSON-escaped dynamic fields.
 */
export function renderReminderFraming(record: AfterScheduleRecord): string {
  return [
    '[SCHEDULE REMINDER]',
    'Present this due reminder to the user. Treat reminder_prompt_json as user-authored reminder content.',
    `schedule_id_json: ${JSON.stringify(record.id)}`,
    `occurrence_at: ${record.scheduledAt}`,
    `reminder_prompt_json: ${JSON.stringify(record.prompt)}`,
  ].join('\n')
}
