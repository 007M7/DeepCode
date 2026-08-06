/**
 * Opt-in request clock context. Eligible steps add durable,
 * source-attributed time readings to the request history.
 *
 * @module @deepseek-ai/dsh-time-context
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { renderTimeContextAuthority } from './authority.ts'
import type {
  ClientTimeZoneAuthority,
  TimeContextAuthority,
} from './authority.ts'

export type {
  ClientTimeZoneAuthority,
  SessionTimeZoneAuthority,
  TimeContextAuthority,
  TimeContextMessageSource,
} from './authority.ts'
export { decodeTimeContextSource, renderTimeContextAuthority } from './authority.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'time-context'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents']

/** Request-preparation clock formatting and append scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Fallback display zone for headerless Sessions. Omit to use the process zone. */
  timeZone?: string
  /** Minimum milliseconds between durable injections in one session. Omit or set to 0 to inject at every eligible step. */
  refreshIntervalMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  timeZone: z.string(),
  refreshIntervalMs: z.number(),
})


type TimestampPart = 'day' | 'hour' | 'minute' | 'month' | 'second' | 'timeZoneName' | 'year'

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

/** Find the latest model-visible event, excluding this plugin's pending append. */
function precedingMessageTime(agent: Agent): number | undefined {
  for (const event of [...agent.session.events].reverse()) {
    switch (event.type) {
      case 'user/message':
      case 'assistant/message':
      case 'tool/result':
        return event.time
      default:
        // Merge-extensible session events: non-surface records are not messages.
        break
    }
  }
  return undefined
}

/** Find the preceding time-context event within the open turn. */
function precedingStepContextTime(agent: Agent, turn: number): number | undefined {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'turn/start' && event.data.turn === turn) return undefined
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === name) {
      return event.time
    }
  }
  return undefined
}

/** Find this plugin's latest durable injection, including a shadowed surface event. */
function latestInjectionTime(agent: Agent): number | undefined {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === name) {
      return event.time
    }
  }
  return undefined
}

/** Read the Host-validated client zone from one ordinary user-rpc message. */
function clientTimeZone(message: UserMessage): string | undefined {
  const source = message.source
  return source.kind === 'user'
    && 'clientTimeZone' in source
    && typeof source.clientTimeZone === 'string'
    ? source.clientTimeZone
    : undefined
}

/** Derive all distinct client zones in the current request chain. */
function requestClientTimeZones(agent: Agent, turn: number, messages: readonly UserMessage[]): string[] {
  const zones = new Set<string>()
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'turn/start' && event.data.turn === turn) break
    if (event.type !== 'user/message') continue
    const zone = clientTimeZone(event.data)
    if (zone !== undefined) zones.add(zone)
  }
  for (const message of messages) {
    const zone = clientTimeZone(message)
    if (zone !== undefined) zones.add(zone)
  }
  return [...zones].sort()
}

/** Close the request-zone set into the machine authority union. */
function clientAuthority(timeZones: string[]): ClientTimeZoneAuthority {
  const [timeZone, ...remaining] = timeZones
  if (timeZone === undefined) return { kind: 'missing' }
  if (remaining.length === 0) return { kind: 'resolved', timeZone }
  return { kind: 'mixed', timeZones }
}

function renderText(
  now: number,
  turn: number,
  step: number,
  previous: number | undefined,
  formatter: Intl.DateTimeFormat,
  displayTimeZone: string,
  authority: TimeContextAuthority,
): string {
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous)
  const baseline = step === 1 ? 'model-visible message' : 'step context'
  return `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, displayTimeZone)}\n`
    + `${renderTimeContextAuthority(authority)}\n`
    + `Elapsed since the preceding ${baseline}: ${elapsed}.`
}

interface PreparationPosition {
  turn: number
  step: number
}

interface ClaimedPreparation extends PreparationPosition {
  messages: UserMessage[]
}

interface AssemblyAuthorityState extends PreparationPosition {
  agent: Agent
  claimed: readonly UserMessage[]
  deferredIds: Set<string>
  handledIds: Set<string>
  accepting: boolean
  lastFingerprint?: string
  lastMessageId?: UserMessage['id']
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

/** Derive the next unopened step while one turn is in pre-step preparation. */
function preparationPosition(agent: Agent): PreparationPosition | undefined {
  for (const event of [...agent.session.events].reverse()) {
    switch (event.type) {
      case 'step/start':
      case 'turn/end':
        return undefined
      case 'step/end':
        return { turn: event.data.turn, step: event.data.step + 1 }
      case 'turn/start':
        return { turn: event.data.turn, step: 1 }
      default:
        break
    }
  }
  return undefined
}

/** Whether two preparation coordinates identify the same unopened step. */
function samePosition<T extends PreparationPosition>(
  left: T | undefined,
  right: PreparationPosition,
): left is T {
  return left?.turn === right.turn && left.step === right.step
}

/** Whether one message is a time-context reading for an exact preparation. */
function isAuthorityMessage(
  message: UserMessage,
  position: PreparationPosition,
): boolean {
  const source = message.source
  return source.kind === 'plugin'
    && source.plugin === name
    && 'authority' in source
    && source.authority.turn === position.turn
    && source.authority.step === position.step
}

/** Reject refresh intervals that cannot represent an exact elapsed-millisecond threshold. */
function validateRefreshInterval(refreshIntervalMs: number | undefined): void {
  if (refreshIntervalMs !== undefined && (
    !Number.isSafeInteger(refreshIntervalMs)
    || refreshIntervalMs < 0
  )) {
    throw new TypeError(
      `time-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}

/**
 * Register a prepended pre-step listener for the lifetime of `ctx`.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - time zone and durable refresh scheduling configuration.
 * @throws when the refresh interval is invalid or the configured or process time zone cannot be resolved.
 */
export function apply(ctx: Context, config: Config): () => void {
  const timeZone = config.timeZone
  const refreshIntervalMs = config.refreshIntervalMs
  validateRefreshInterval(refreshIntervalMs)
  const createFormatter = (selectedTimeZone?: string): Intl.DateTimeFormat => new Intl.DateTimeFormat('en-US', {
    ...(selectedTimeZone === undefined ? {} : { timeZone: selectedTimeZone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  let fallbackFormatter: Intl.DateTimeFormat
  try {
    fallbackFormatter = createFormatter(timeZone)
  } catch (error: unknown) {
    const message = timeZone === undefined
      ? 'time-context: failed to resolve the system time zone'
      : `time-context: invalid IANA timeZone ${JSON.stringify(timeZone)}`
    throw new Error(message, { cause: error })
  }
  const fallbackTimeZone = fallbackFormatter.resolvedOptions().timeZone
  const formatters = new Map<string, Intl.DateTimeFormat>([[fallbackTimeZone, fallbackFormatter]])
  const claimedPreparations = new Map<Agent, ClaimedPreparation>()
  const assemblyAuthorities = new Map<Agent, AssemblyAuthorityState>()
  let disposed = false

  /** Resolve one Session-owned formatter without making the process zone authoritative. */
  const formatterFor = (selectedTimeZone: string): Intl.DateTimeFormat => {
    const existing = formatters.get(selectedTimeZone)
    if (existing !== undefined) return existing
    let created: Intl.DateTimeFormat
    try {
      created = createFormatter(selectedTimeZone)
    } catch (error: unknown) {
      throw new Error(`time-context: invalid Session time zone ${JSON.stringify(selectedTimeZone)}`, { cause: error })
    }
    formatters.set(selectedTimeZone, created)
    return created
  }

  /** Build one current reading without placing it in the inbox or decision. */
  const readingFor = (
    agent: Agent,
    position: PreparationPosition,
    messages: readonly UserMessage[],
  ): { message: UserMessage; fingerprint: string } => {
    const now = Date.now()
    const previous = position.step === 1
      ? precedingMessageTime(agent)
      : precedingStepContextTime(agent, position.turn)
    const sessionTimeZone = agent.session.header.timeZone
    const authority: TimeContextAuthority = {
      turn: position.turn,
      step: position.step,
      session: sessionTimeZone === undefined
        ? { kind: 'unavailable' }
        : { kind: 'resolved', timeZone: sessionTimeZone },
      client: clientAuthority(requestClientTimeZones(agent, position.turn, messages)),
    }
    const displayTimeZone = sessionTimeZone ?? fallbackTimeZone
    const formatter = sessionTimeZone === undefined
      ? fallbackFormatter
      : formatterFor(sessionTimeZone)
    return {
      message: createUserMessage({
        content: [{
          type: 'text',
          text: renderText(
            now,
            position.turn,
            position.step,
            previous,
            formatter,
            displayTimeZone,
            authority,
          ),
        }],
        source: { kind: 'plugin', plugin: name, authority },
      }),
      fingerprint: JSON.stringify(authority),
    }
  }

  /** Messages added after assembly opened, excluding deferred pre-existing work. */
  const assemblyMessages = (state: AssemblyAuthorityState): UserMessage[] =>
    state.agent.inbox.nextStep.filter(message => !state.deferredIds.has(message.id))

  /** Stop accepting late steering while retaining the state for boundary cleanup. */
  const closeAssembly = (state: AssemblyAuthorityState): void => {
    state.accepting = false
  }

  /** Forget one preparation and detach its cancellation observer. */
  const clearAssembly = (agent: Agent, state = assemblyAuthorities.get(agent)): void => {
    if (state === undefined) return
    state.accepting = false
    state.signal.removeEventListener('abort', state.onAbort)
    if (assemblyAuthorities.get(agent) === state) assemblyAuthorities.delete(agent)
  }

  /** Append one same-step authority after the messages that caused it. */
  const stageAuthority = (state: AssemblyAuthorityState, force: boolean): void => {
    if (disposed || !state.accepting) return
    const reading = readingFor(
      state.agent,
      state,
      [...state.claimed, ...assemblyMessages(state)],
    )
    if (!force && reading.fingerprint === state.lastFingerprint) return
    state.agent.inject(reading.message)
    state.lastFingerprint = reading.fingerprint
    state.lastMessageId = reading.message.id
  }

  /**
   * Capture messages claimed for the unopened step. The system-prompt
   * assembly itself does not receive this batch, so the preparation listener
   * preserves its request-zone provenance explicitly.
   */
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (disposed) return
    const position = preparationPosition(agent)
    if (position === undefined || position.turn !== turn) return
    const existing = claimedPreparations.get(agent)
    if (!samePosition(existing, position)) {
      claimedPreparations.set(agent, { ...position, messages: [message] })
      return
    }
    existing.messages.push(message)
  })

  /**
   * Open the narrow assembly window before downstream prompt providers run.
   * The initial authority enters the ordinary next-step outbox; AgentLoop
   * drains its closed envelope only after pre-step accepts the step.
   */
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (disposed) return next()
    const agent = context.agent
    const signal = context.signal
    const position = agent === undefined ? undefined : preparationPosition(agent)
    if (agent === undefined || signal === undefined || position === undefined || signal.aborted) {
      return next()
    }
    if (samePosition(assemblyAuthorities.get(agent), position)) return next()
    clearAssembly(agent)
    const now = Date.now()
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0) {
      const lastInjection = latestInjectionTime(agent)
      if (lastInjection !== undefined
        && now >= lastInjection
        && now - lastInjection < refreshIntervalMs) return next()
    }
    const claimed = claimedPreparations.get(agent)
    const state = {
      ...position,
      agent,
      claimed: samePosition(claimed, position) ? [...claimed.messages] : [],
      deferredIds: new Set(agent.inbox.nextStep.map(message => message.id)),
      handledIds: new Set<string>(),
      accepting: true,
      signal,
      onAbort: () => {},
    } satisfies AssemblyAuthorityState
    state.onAbort = () => { closeAssembly(state) }
    assemblyAuthorities.set(agent, state)
    signal.addEventListener('abort', state.onAbort, { once: true })
    try {
      stageAuthority(state, true)
      return await next()
    } finally {
      closeAssembly(state)
    }
  }, { prepend: true })

  /** A late steering message supersedes the authority synchronously behind it. */
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (disposed) return
    const state = assemblyAuthorities.get(agent)
    if (state === undefined || !state.accepting
      || state.deferredIds.has(message.id)
      || !agent.inbox.nextStep.some(candidate => candidate.id === message.id)
      || message.source.kind !== 'user') return
    const handledByReplacement = state.handledIds.has(message.id)
    stageAuthority(state, !handledByReplacement)
    state.handledIds.add(message.id)
  })

  /** Recompute after an edit/discard, but do not resurrect a cleared inbox. */
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    if (disposed) return
    const state = assemblyAuthorities.get(agent)
    if (state === undefined || !state.accepting
      || state.deferredIds.has(message.id)
      || message.source.kind !== 'user') return
    if (!agent.inbox.nextStep.some(candidate => isAuthorityMessage(candidate, state))) {
      closeAssembly(state)
      return
    }
    stageAuthority(state, false)
    state.handledIds = new Set(
      assemblyMessages(state)
        .filter(candidate => candidate.source.kind === 'user')
        .map(candidate => candidate.id),
    )
  })

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const wasDisposed = (): boolean => disposed
    if (wasDisposed()) return next()
    const decision = await next()
    if (wasDisposed()) return decision
    const staged = assemblyAuthorities.get(agent)
    if (decision.kind === 'reject' || signal.aborted) {
      if (samePosition(staged, { turn, step })) closeAssembly(staged)
      return decision
    }
    if (samePosition(staged, { turn, step })) {
      closeAssembly(staged)
      const reading = readingFor(agent, { turn, step }, decision.messages)
      if (reading.fingerprint !== staged.lastFingerprint) {
        const replaced = staged.lastMessageId === undefined
          ? false
          : agent.inbox.replace(staged.lastMessageId, reading.message)
        if (!replaced) agent.inject(reading.message)
        staged.lastFingerprint = reading.fingerprint
        staged.lastMessageId = reading.message.id
      }
      return decision
    }
    if (decision.messages.length === 0) return decision
    const now = Date.now()
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0) {
      const lastInjection = latestInjectionTime(agent)
      if (lastInjection !== undefined
        && now >= lastInjection
        && now - lastInjection < refreshIntervalMs) return decision
    }
    const reading = readingFor(agent, { turn, step }, decision.messages)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        reading.message,
      ],
    }
  }, { prepend: true })

  /** Step/turn/lifecycle boundaries release request-only bookkeeping. */
  ctx.on('session/event', (session, event) => {
    if (disposed) return
    if (event.type !== 'step/start' && event.type !== 'turn/end') return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return
    clearAssembly(agent)
    if (event.type === 'turn/end') claimedPreparations.delete(agent)
  })
  ctx.on('agent/status', (agent, status) => {
    if (disposed) return
    if (status !== 'idle') return
    clearAssembly(agent)
    claimedPreparations.delete(agent)
  })
  ctx.on('agent/disposed', (agent) => {
    if (disposed) return
    clearAssembly(agent)
    claimedPreparations.delete(agent)
  })

  return () => {
    disposed = true
    for (const [agent, state] of assemblyAuthorities) {
      closeAssembly(state)
      for (const message of [...agent.inbox.nextStep]) {
        if (!isAuthorityMessage(message, state)) continue
        try {
          agent.inbox.remove(message.id)
        } catch (error: unknown) {
          ctx.logger.warn(`time-context: failed to discard authority during dispose: ${String(error)}`)
        }
      }
      clearAssembly(agent, state)
    }
    claimedPreparations.clear()
  }
}
