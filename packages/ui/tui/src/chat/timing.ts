/**
 * Per-step timing model and running-status glyph animation for the terminal
 * front door. Timing buckets are replayed from the session event stream; the
 * running glyph fades in on turn start, throbs while the turn runs, and fades
 * out on turn end.
 * @module @deepseek-ai/dsh-tui/chat/timing
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Palette } from '../components/theme.ts'

/**
 * Render cadence of the running prompt while active, and while the glyph fades
 * out after a turn ends. ~20 fps so the truecolor glyph fade reads smoothly;
 * the same tick keeps the elapsed-time text (0.1 s resolution) current. Only
 * changed terminal cells are re-emitted, so the faster tick stays cheap.
 */
export const STATUS_ANIMATION_INTERVAL_MS = 50

/**
 * Milliseconds over which the running glyph fades in when a turn starts and
 * fades out after it ends. The fade is an envelope over the running pulse:
 * inside it the glyph throbs (see {@link STATUS_PULSE_PERIOD_MS}).
 */
export const STATUS_FADE_MS = 300

/** Milliseconds for one full brightness throb of the running glyph. */
export const STATUS_PULSE_PERIOD_MS = 1400

/**
 * Brightness floor of the running throb, as a fraction of the settled gray. At
 * 0 the pulse swells from the near-background trough up to full and back. The
 * trough is still rendered as the dimmest gray, not clipped to a blank, so the
 * cosine breathes symmetrically bold→dim→bold.
 */
export const STATUS_PULSE_FLOOR = 0

/**
 * Muted-gray foreground the truecolor running glyph fades through, from the
 * near-background trough (opacity 0) to the settled dim gray (opacity 1). Same
 * hue-free gray as the idle caret, so the glyph reads as the caret dimly
 * appearing rather than a colored indicator. Foreground-only, matching the
 * brand gradient, so it stays legible on any terminal background.
 */
const STATUS_FADE_GRAY = {
  trough: [43, 43, 43],
  settled: [136, 136, 136],
} as const

/** The active phase of a running step, one bucket of accumulated wall time. */
export type TimingBucket = 'ttft' | 'thinking' | 'responding' | 'tools'

/** Turn/step coordinates of one assistant step. */
export type StepPosition = { turn: number; step: number }

/** Accumulated wall time per phase for one step or session slice. */
export interface TimingTotals {
  ttft: number
  thinking: number
  responding: number
  tools: number
}

interface TimingState {
  totals: TimingTotals
  active: { bucket: TimingBucket; since: number } | undefined
}

const TIMING_BUCKET_LABELS: Record<TimingBucket, string> = {
  ttft: 'Model wait',
  thinking: 'Thinking',
  responding: 'Response',
  tools: 'Tools',
}

const TIMING_BUCKETS: readonly TimingBucket[] = ['ttft', 'thinking', 'responding', 'tools']

function emptyTimingTotals(): TimingTotals {
  return { ttft: 0, thinking: 0, responding: 0, tools: 0 }
}

function timingState(startedAt?: number): TimingState {
  return {
    totals: emptyTimingTotals(),
    /* v8 ignore next -- production timing state always begins at a logged step timestamp. */
    active: startedAt === undefined ? undefined : { bucket: 'ttft', since: startedAt },
  }
}

function sameStep(event: SessionEvent, position: StepPosition): boolean {
  return typeof event.data === 'object'
    && 'turn' in event.data && 'step' in event.data
    && event.data.turn === position.turn && event.data.step === position.step
}

function closeTimingBucket(state: TimingState, at: number): void {
  if (state.active === undefined) return
  state.totals[state.active.bucket] += Math.max(0, at - state.active.since)
  state.active = undefined
}

function enterTimingBucket(state: TimingState, bucket: TimingBucket | undefined, at: number): void {
  if (state.active?.bucket === bucket) return
  closeTimingBucket(state, at)
  if (bucket !== undefined) state.active = { bucket, since: at }
}

function advanceStepTiming(
  state: TimingState,
  event: Extract<SessionEvent, { type: 'assistant/chunk' | 'tool/call' | 'step/end' }>,
): void {
  if (event.type === 'assistant/chunk') {
    const chunk = event.data.chunk
    if (state.active?.bucket === 'ttft') enterTimingBucket(state, undefined, event.time)
    if (chunk.type === 'reasoning-delta' || (chunk.type === 'block-start' && chunk.blockType === 'reasoning')) {
      enterTimingBucket(state, 'thinking', event.time)
    } else if (chunk.type === 'text-delta' || (chunk.type === 'block-start' && chunk.blockType === 'text')) {
      enterTimingBucket(state, 'responding', event.time)
    }
  } else if (event.type === 'tool/call') {
    enterTimingBucket(state, 'tools', event.time)
  } else {
    closeTimingBucket(state, event.time)
  }
}

function timingTotalsAt(state: TimingState, at?: number): TimingTotals {
  const totals = { ...state.totals }
  if (state.active !== undefined && at !== undefined) {
    totals[state.active.bucket] += Math.max(0, at - state.active.since)
  }
  return totals
}

/**
 * Replay one step's accumulated per-phase timing up to clock `at`.
 * @param events - Session events to replay.
 * @param position - Turn/step coordinates of the step.
 * @param at - Render clock to accumulate the open bucket up to.
 * @returns The step's per-phase totals.
 */
export function stepTimingAt(
  events: readonly SessionEvent[],
  position: StepPosition,
  at: number,
): TimingTotals {
  const startIndex = events.findIndex(event => event.type === 'step/start' && sameStep(event, position))
  if (startIndex < 0) return emptyTimingTotals()
  const start = events[startIndex] as Extract<SessionEvent, { type: 'step/start' }>
  const state = timingState(start.time)
  for (let index = startIndex + 1; index < events.length; index += 1) {
    const event = events[index] as SessionEvent
    if (event.time > at) break
    if ((event.type === 'assistant/chunk' || event.type === 'tool/call' || event.type === 'step/end')
      && sameStep(event, position)) {
      advanceStepTiming(state, event)
      if (event.type === 'step/end') break
    }
  }
  return timingTotalsAt(state, at)
}

/**
 * The turn index of the currently open turn, or `undefined` when none is open.
 * @param events - Session events to scan from the tail.
 * @returns The open turn index, or `undefined`.
 */
export function openTurn(events: readonly SessionEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/end') return undefined
    if (event.type === 'turn/start') return event.data.turn
  }
  return undefined
}

/**
 * Phase-specific status glyph, keyed by the running step's active timing bucket.
 * `ttft` is the pre-first-token wait a running turn falls back to between steps.
 */
export const TIMING_BUCKET_GLYPHS: Record<TimingBucket, string> = {
  ttft: '◍',
  thinking: '✻',
  responding: '●',
  tools: '⚙',
}

/**
 * Derive the currently open step's active timing bucket, or `undefined` when no
 * step is open. The open step is the last `step/start` with no later matching
 * `step/end`; its bucket is replayed with the same rules as {@link stepTimingAt}.
 * @param events - Session events to scan.
 * @returns The open step's active bucket, or `undefined`.
 */
export function openStepPhase(events: readonly SessionEvent[]): TimingBucket | undefined {
  let startIndex = -1
  let start: Extract<SessionEvent, { type: 'step/start' }> | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'step/end') return undefined
    if (event.type === 'step/start') {
      startIndex = index
      start = event
      break
    }
    if (event.type === 'turn/end') return undefined
  }
  if (start === undefined) return undefined
  const position = start.data
  const state = timingState(start.time)
  for (let index = startIndex + 1; index < events.length; index += 1) {
    const event = events[index] as SessionEvent
    if ((event.type === 'assistant/chunk' || event.type === 'tool/call' || event.type === 'step/end')
      && sameStep(event, position)) {
      advanceStepTiming(state, event)
    }
  }
  return state.active?.bucket
}

/**
 * The running agent's phase glyph, or `undefined` when idle. A running turn
 * with no open step falls back to the pre-first-token wait so a glyph is always
 * available while the agent works; it fades in on turn start, throbs while the
 * turn runs, and fades out on turn end (see {@link fadeGlyph}).
 * @param events - Session events to derive the phase from.
 * @param running - Whether the agent is currently running.
 * @returns The phase glyph, or `undefined` when idle.
 */
export function runningPhaseGlyph(events: readonly SessionEvent[], running: boolean): string | undefined {
  if (!running) return undefined
  const bucket = openStepPhase(events) ?? 'ttft'
  return TIMING_BUCKET_GLYPHS[bucket]
}

/**
 * The running throb's brightness at continuous clock `nowMs`: a cosine between
 * {@link STATUS_PULSE_FLOOR} and 1 over {@link STATUS_PULSE_PERIOD_MS}, so the
 * dim glyph breathes bold→dim→bold without ever blinking off. Multiplied by the
 * fade envelope, which alone drives appear/disappear at turn boundaries.
 *
 * @param nowMs - Monotonic render clock in milliseconds.
 * @returns Brightness fraction in [{@link STATUS_PULSE_FLOOR}, 1].
 */
export function pulseLevel(nowMs: number): number {
  const phase = (nowMs % STATUS_PULSE_PERIOD_MS) / STATUS_PULSE_PERIOD_MS
  const wave = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase)
  return STATUS_PULSE_FLOOR + (1 - STATUS_PULSE_FLOOR) * wave
}

/**
 * One frame of the running glyph at fade `opacity` (0 = near-background trough
 * gray, 1 = settled dim gray). The character and its width never change — only
 * the gray fades — so the prompt caret column stays fixed and the glyph reads as
 * the caret dimly breathing, never a colored indicator.
 *
 * With truecolor the glyph's 24-bit gray foreground interpolates continuously
 * between {@link STATUS_FADE_GRAY}'s trough and settled stops, so both the fade
 * and the running throb render as a smooth, symmetric brightness swing with no
 * hard cutoff to clip the trough into a blank. Without truecolor there is no
 * per-frame gray, so `visible` (driven by the fade envelope, not the opacity)
 * shows the glyph in the palette's muted role or leaves a blank column — a
 * single dim appear/disappear at fixed width, still dim rather than accent, and
 * no throb-driven blink. With color off entirely a visible glyph is bare,
 * holding the caret column on a monochrome terminal.
 *
 * @param glyph - The phase glyph to paint.
 * @param palette - Active palette supplying the muted (dim gray) role.
 * @param colorEnabled - Whether ANSI is emitted at all.
 * @param truecolor - Whether the terminal accepts 24-bit foreground codes.
 * @param opacity - Brightness fraction in [0, 1] for the truecolor gray.
 * @param visible - Whether the non-truecolor fallback shows the glyph at all.
 * @returns The gray glyph at this opacity, or a single space when hidden.
 */
export function fadeGlyph(
  glyph: string,
  palette: Palette,
  colorEnabled: boolean,
  truecolor: boolean,
  opacity: number,
  visible: boolean,
): string {
  if (truecolor && colorEnabled) {
    const o = Math.min(Math.max(opacity, 0), 1)
    const [tr, tg, tb] = STATUS_FADE_GRAY.trough
    const [sr, sg, sb] = STATUS_FADE_GRAY.settled
    const r = Math.round(tr + (sr - tr) * o)
    const g = Math.round(tg + (sg - tg) * o)
    const b = Math.round(tb + (sb - tb) * o)
    return `\x1b[38;2;${r};${g};${b}m${glyph}\x1b[39m`
  }
  if (!visible) return ' '
  return colorEnabled ? palette.dim(glyph) : glyph
}

/**
 * Format a non-negative elapsed span at 100 ms resolution.
 * @param elapsedMs - Elapsed milliseconds.
 * @returns The formatted duration (e.g. `1.5s`, `2m03.4s`).
 */
export function formatStatusDuration(elapsedMs: number): string {
  const tenths = Math.floor(Math.max(0, elapsedMs) / 100)
  const seconds = tenths / 10
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}s`
}

/**
 * Format the non-zero timing buckets of one step as a middot-joined summary.
 * @param totals - Per-phase totals to format.
 * @param includeModelWait - Whether to always include the model-wait bucket.
 * @returns The formatted timing summary.
 */
export function formatTimingTotals(totals: TimingTotals, includeModelWait = false): string {
  return TIMING_BUCKETS
    .filter(bucket => totals[bucket] > 0 || (includeModelWait && bucket === 'ttft'))
    .map(bucket => `${TIMING_BUCKET_LABELS[bucket]} ${formatStatusDuration(totals[bucket])}`)
    .join(' · ')
}

/**
 * Format the queued-steering badge shown on the running status line.
 * @param queued - Number of queued steering messages.
 * @returns The badge text, or `undefined` when nothing is queued.
 */
export function formatQueuedStatus(queued: number): string | undefined {
  return queued > 0 ? `${queued} queued` : undefined
}

/**
 * Format a completion timestamp as `YYYY-MM-DD HH:MM:SS` in local time.
 * @param time - Epoch milliseconds.
 * @returns The formatted local timestamp.
 */
export function formatCompletionTime(time: number): string {
  const date = new Date(time)
  const parts = [
    date.getFullYear().toString().padStart(4, '0'),
    (date.getMonth() + 1).toString().padStart(2, '0'),
    date.getDate().toString().padStart(2, '0'),
  ]
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => value.toString().padStart(2, '0'))
    .join(':')
  return `${parts.join('-')} ${clock}`
}
