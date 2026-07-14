/**
 * Opt-in request-time clock context. Active turns receive the current zoned
 * time and elapsed time since the preceding model-visible message. The loop
 * logs each rendered value as request-header state rather than conversation
 * history.
 *
 * @module @deepseek-ai/dsh-time-context
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'time-context'

/** The system-prompt registry that owns the dynamic request section. */
export const inject = ['systemPrompt']

/** Request-time clock formatting and refresh policy. Invalid values fail plugin load. */
export interface Config {
  /** IANA time zone used for the rendered timestamp. Omit to resolve the Node process's system zone at plugin load. */
  timeZone?: string
  /** Maximum age of a reading within one turn, in milliseconds (default 60,000; `0` refreshes every step). */
  refreshIntervalMs?: number
}

/** Schemastery validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  timeZone: z.string(),
  refreshIntervalMs: z.number().default(60_000),
})

interface OpenTurn {
  turn: number
  startSeq: number
}

/** Cached text and the fixed inter-turn baseline used by one agent's open turn. */
interface RenderState {
  turn: number
  renderedAt: number
  previousMessageTime: number | undefined
  text: string
}

type TimestampPart = 'day' | 'hour' | 'minute' | 'month' | 'second' | 'timeZoneName' | 'year'

function openTurn(agent: Agent): OpenTurn | undefined {
  for (const event of [...agent.session.events].reverse()) {
    switch (event.type) {
      case 'turn/end':
        return undefined
      case 'turn/start':
        return { turn: event.data.turn, startSeq: event.seq }
      default:
        // Merge-extensible session events: only turn boundaries matter here.
        break
    }
  }
  return undefined
}

/** Find the latest model-visible timestamp strictly before one turn boundary. */
function previousMessageTime(agent: Agent, turnStartSeq: number): number | undefined {
  for (const event of [...agent.session.events].reverse()) {
    if (event.seq >= turnStartSeq) continue
    switch (event.type) {
      case 'user/message':
      case 'assistant/message':
      case 'tool/result':
      case 'context/message':
      case 'steering/message':
        return event.time
      default:
        // Merge-extensible session events: non-surface records are not messages.
        break
    }
  }
  return undefined
}

/** Format an epoch millisecond value as an ISO-shaped timestamp with offset and IANA zone. */
function formatTimestamp(now: number, formatter: Intl.DateTimeFormat, timeZone: string): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(part => [part.type, part.value]),
  ) as Record<TimestampPart, string>
  const offset = parts.timeZoneName.replace(/^GMT$/, 'GMT+00:00').slice(3)
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}${offset}[${timeZone}]`
}

/** Format a non-negative elapsed millisecond count as compact whole-second units. */
function formatDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

function renderText(
  now: number,
  previous: number | undefined,
  formatter: Intl.DateTimeFormat,
  timeZone: string,
): string {
  const elapsed = previous === undefined
    ? 'unavailable (no earlier message in this session)'
    : formatDuration(now - previous)
  return `Current time: ${formatTimestamp(now, formatter, timeZone)}\nTime since previous message: ${elapsed}.`
}

/**
 * Register the request-time clock section for the lifetime of `ctx`.
 * @param ctx - plugin context; the section registration is disposed with it.
 * @param config - validated time zone and intra-turn refresh interval.
 * @throws when the time zone or refresh interval is invalid.
 */
export function apply(ctx: Context, config: Config): void {
  const timeZone = config.timeZone
  const refreshIntervalMs = config.refreshIntervalMs as number
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 0) {
    throw new Error(`time-context: refreshIntervalMs must be a non-negative safe integer, got ${refreshIntervalMs}`)
  }

  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      ...(timeZone === undefined ? {} : { timeZone }),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
  } catch (error: unknown) {
    const message = timeZone === undefined
      ? 'time-context: failed to resolve the system time zone'
      : `time-context: invalid IANA timeZone ${JSON.stringify(timeZone)}`
    throw new Error(message, { cause: error })
  }
  const resolvedTimeZone = formatter.resolvedOptions().timeZone
  const states = new WeakMap<Agent, RenderState>()

  ctx.systemPrompt.section({
    name: 'context:time',
    order: 10,
    text(context: AssembleContext): string {
      const agent = context.agent
      if (agent === undefined) return ''
      const currentTurn = openTurn(agent)
      if (currentTurn === undefined) return ''

      const now = Date.now()
      const prior = states.get(agent)
      if (prior !== undefined
        && prior.turn === currentTurn.turn
        && now >= prior.renderedAt
        && now - prior.renderedAt < refreshIntervalMs) {
        return prior.text
      }

      const previous = prior?.turn === currentTurn.turn
        ? prior.previousMessageTime
        : previousMessageTime(agent, currentTurn.startSeq)
      const text = renderText(now, previous, formatter, resolvedTimeZone)
      states.set(agent, { turn: currentTurn.turn, renderedAt: now, previousMessageTime: previous, text })
      return text
    },
  })
}
