;(function () {
// interact-cards.js — pure helpers for §2 "交互卡两型" unified visuals.
//
// Boss rule (strategy-feature-list v2 §2.1):
//   Blocking cards (approval / form / exit_plan_mode) all wear the SAME
//   thick border + top status strip (黄=等你 / 绿=已确认 / 灰=已跳过).
//   This module owns the state machine + label table so the DOM code and
//   the tests read one truth. It does not touch the DOM itself.
//
// Boss rule (v2 §2.2):
//   Non-blocking steer cards have NO status strip, wear a lighter border,
//   render a top-right ×, and on click drop a "💡 steer" chip into the
//   chat flow. This module owns the chip summarizer so tests can pin it.
//
// The pure module runs under `node --test` and is imported by both the
// renderer (attached to `window.__dshInteractCards`) and the test suite.

'use strict'

// -- blocking status states --------------------------------------------------

const STATUS = Object.freeze({
  waiting: {
    key: 'waiting',
    label: 'AWAITING YOU',
    hint: 'The agent is paused until you answer this card.',
    color: 'warn',
  },
  confirmed: {
    key: 'confirmed',
    label: 'CONFIRMED',
    hint: 'Your answer was recorded and the agent resumed.',
    color: 'ok',
  },
  skipped: {
    key: 'skipped',
    label: 'SKIPPED',
    hint: 'You dismissed this prompt; the agent moved on without an answer.',
    color: 'muted',
  },
})

const STATUS_KEYS = Object.freeze(['waiting', 'confirmed', 'skipped'])

/**
 * Given a resolve-outcome ({outcome: 'accepted' | 'rejected' | 'cancelled' | ...})
 * return the state the card should transition to. Anything unmapped stays
 * on 'waiting' — the safe default keeps the yellow strip up so the user
 * can retry. Kept as a simple table so a reviewer can eyeball the fan-in.
 */
function statusFromOutcome(outcome) {
  switch (outcome) {
    case 'accepted':
    case 'confirmed':
      return STATUS.confirmed
    case 'rejected':
    case 'cancelled':
    case 'skipped':
    case 'dismissed':
      return STATUS.skipped
    default:
      return STATUS.waiting
  }
}

// -- exit-plan-mode detection ------------------------------------------------
//
// A form-kind interrupt is treated as `exit_plan_mode` when EITHER:
//   (a) spec.kind === 'exit_plan_mode', OR
//   (b) spec.plan is a non-empty string (the plan document body).
// Anything else falls through to the generic form renderer.

function isExitPlanModeSpec(spec) {
  if (!spec || typeof spec !== 'object') return false
  if (spec.kind === 'exit_plan_mode') return true
  if (typeof spec.plan === 'string' && spec.plan.trim() !== '') return true
  return false
}

/**
 * Compute the plan diff preview lines from a plan document. Very small
 * heuristic: each numbered line "1. …" or "- …" becomes a diff entry;
 * anything else joins as context. This is a DEMO preview, not a real
 * diff — the boss ruled "右栏 diff 可以简化为只读预览" (v2 §2.1).
 * Returns `[{sigil, text}]`; empty on non-plan input.
 */
function previewLinesFromPlan(plan) {
  if (typeof plan !== 'string' || plan.trim() === '') return []
  const out = []
  for (const raw of plan.split('\n')) {
    const line = raw.trimEnd()
    if (!line) continue
    const m = line.match(/^\s*(?:\d+\.|[-*])\s+(.*)$/)
    if (m) {
      out.push({ sigil: '+', text: m[1].trim() })
    } else {
      out.push({ sigil: ' ', text: line.trim() })
    }
  }
  return out
}

// -- steer chip --------------------------------------------------------------
//
// Summarize a steer card's spec into a compact chip label. We prefer the
// producer-authored title/label, fall back to the message body, and only
// then synthesize a generic label so the chat flow never carries a chip
// that says "steer" and nothing else.

function chipLabelFromSteerSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'steer'
  const src = firstString([
    spec.chipLabel,
    spec.title,
    spec.label,
    spec.message,
    spec.hint,
  ])
  if (!src) return 'steer'
  return truncate(src, 60)
}

// Shared with trace-aggregator + trigger-templates — see text-truncate.js.
const truncate = ((typeof window !== 'undefined' && window.__dshTextTruncate)
  || (typeof module !== 'undefined' && require('./text-truncate.js'))
).truncate

function firstString(list) {
  if (!Array.isArray(list)) return ''
  for (const v of list) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

// -- exports -----------------------------------------------------------------

const api = {
  STATUS,
  STATUS_KEYS,
  statusFromOutcome,
  isExitPlanModeSpec,
  previewLinesFromPlan,
  chipLabelFromSteerSpec,
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.InteractCards = api
if (typeof window !== 'undefined') window.__dshInteractCards = api
})()
