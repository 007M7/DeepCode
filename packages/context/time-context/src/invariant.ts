/** Package-owned durable clock-context invariants. @module @deepseek-ai/dsh-time-context/invariant */

import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { decodeTimeContextSource, renderTimeContextAuthority } from './authority.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-time-context'
const SOURCE_NAME = 'time-context'
const READING = new RegExp(
  '^Time sampled while preparing turn (\\d+), step (\\d+): '
  + '(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:Z|[+-]\\d{2}:\\d{2})\\[[^\\]]+\\])\\n'
  + 'Session time zone: ([^.]+)\\.\\n'
  + 'Client time zone for this request: (.+)\\.\\n'
  + 'Elapsed since the preceding (model-visible message|step context): '
  + '(?:unavailable|(?:(?:\\d+d )?(?:\\d+h )?(?:\\d+m )?\\d+s))\\.$',
)

/** Cordis companion plugin name. */
export const name = 'time-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Derive the step preparation owned by a time-context reading. A normal
 * reading follows `step/start`; a pre-step failure may settle context-only
 * output in the still-open turn before that boundary.
 */
function preparationPosition(history: readonly SessionEvent[], fail: InvariantFailure): { turn: number; step: number } {
  let openTurn: number | undefined
  let openStep: number | undefined
  let nextStep = 1
  for (const event of history) {
    switch (event.type) {
      case 'turn/start': {
        openTurn = event.data.turn
        openStep = undefined
        nextStep = 1
        break
      }
      case 'step/start': {
        openStep = event.data.step
        break
      }
      case 'step/end': {
        openStep = undefined
        nextStep = event.data.step + 1
        break
      }
      case 'turn/end': {
        openTurn = undefined
        openStep = undefined
        break
      }
      default:
        break
    }
  }
  if (openTurn === undefined) fail('time-context reading must be appended inside an open turn')
  return { turn: openTurn, step: openStep ?? nextStep }
}

/** Validate one plugin-attributed time reading against its session position and timestamp. */
function validateReading(
  history: readonly SessionEvent[],
  event: SessionEvent<'user/message'>,
  fail: InvariantFailure,
): void {
  const [block] = event.data.content
  if (event.data.content.length !== 1 || block?.type !== 'text') {
    fail('time-context messages must contain exactly one text block')
  }
  const match = READING.exec(block.text)
  if (match === null) fail('time-context message does not match the durable reading format')
  const turn = Number(match[1])
  const step = Number(match[2])
  if (!Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(step) || step < 1) {
    fail('time-context turn and step must be positive safe integers')
  }
  const expected = preparationPosition(history, fail)
  if (turn !== expected.turn || step !== expected.step) {
    fail(`time-context reading names turn ${turn}/step ${step}, expected turn ${expected.turn}/step ${expected.step}`)
  }
  let source: ReturnType<typeof decodeTimeContextSource>
  try {
    source = decodeTimeContextSource(event.data.source)
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error))
  }
  if (source.authority.turn !== turn || source.authority.step !== step) {
    fail('time-context text and source authority name different positions')
  }
  const renderedAuthority = `Session time zone: ${match[4]}.\nClient time zone for this request: ${match[5]}.`
  if (renderedAuthority !== renderTimeContextAuthority(source.authority)) {
    fail('time-context text and source authority describe different zones')
  }
  const baseline = match[6]
  if ((step === 1) !== (baseline === 'model-visible message')) {
    fail(`time-context step ${step} uses the wrong elapsed-time baseline ${JSON.stringify(baseline)}`)
  }
  const rendered = match[3]
  /* v8 ignore next -- the preceding fixed regexp always supplies capture group three. */
  if (rendered === undefined) fail('time-context reading omitted its rendered timestamp')
  const renderedTime = Date.parse(rendered.replace(/\[[^\]]+\]$/, ''))
  if (!Number.isFinite(renderedTime) || !Number.isSafeInteger(event.time)
    || event.time < renderedTime) {
    fail('time-context rendered timestamp must parse and not postdate its durable event')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate all package-owned readings already present in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) continue
    validateReading(session.events.slice(0, index), event, fail)
  }
}

/** Install validation for loaded and newly appended context readings. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) return
    validateReading(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the time-context invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
