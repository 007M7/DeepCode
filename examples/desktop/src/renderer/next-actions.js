(function () {
// next-actions.js — predictive UI suggestion engine for the DSH composer.
//
// One-file, pure module. Takes a rolling window of session events and a bit
// of transient turn context in; emits 0-3 suggestion chips out. The renderer
// paints those chips above the composer textarea; click sends the chip's
// prompt (or fires its verb, via the same 5-verb dispatcher widgets.js uses).
// The ✕ per chip dismisses that specific suggestion for the rest of the
// session — a user who doesn't want the prediction shouldn't have to swat it
// away again after every turn.
//
// This mirrors the pattern from next-action-ui-lab/{harness-loop, harness-prompt}
// but with three deliberate departures:
//
//   1. No LLM. We watch our own event stream and match rules, so a suggestion
//      lands at turn/end without a second round-trip. Cheap by design — the
//      real predictive path is a follow-up.
//   2. Rules are data (RULES table below), not code. Reviewers see the whole
//      surface in one place; tests can round-trip synthetic events through
//      it. This is `layout-heuristics.js`'s discipline extended one lane over.
//   3. Every chip carries a verb, not just a prompt. Sending a prompt is the
//      default, but "Open the artifact" fires `open_artifact` directly; no
//      round-trip through the agent for a UI-only action. Matches the widget
//      verb catalog in widgets.js so the two systems speak the same shapes.
//
// The module is document-free — no DOM, no timers — so it runs under
// `node --test` as-is. Wiring lives in renderer.js.

'use strict'

// -- rule catalogue ----------------------------------------------------------
//
// Order matters: first match wins for a given (trigger, side-effect) pair,
// but every rule that matches contributes a chip up to MAX_CHIPS. The
// `trigger` field pattern-matches against the aggregated turn context; the
// `chip` field is the visible suggestion (verb + label + prompt/payload).
//
// Keep rules terse — a rule that fires too broadly is worse than a missing
// suggestion, because the user learns to ignore the chip row. When in doubt,
// leave the trigger empty and let a real user need coach the addition.

const RULES = Object.freeze([
  // Diff appeared → offer to run tests or re-inspect.
  {
    id: 'diff.run-tests',
    when: (ctx) => ctx.diffTools > 0,
    chip: {
      id: 'run-tests',
      label: 'Run the tests',
      hint: 'Kick off the project test command against the just-edited files.',
      verb: 'prompt',
      prompt: 'Run the tests and show me the results.',
    },
  },
  {
    id: 'diff.reshow',
    when: (ctx) => ctx.diffTools >= 2,
    chip: {
      id: 'show-diff',
      label: 'Show the combined diff',
      hint: 'Group every edit this turn into one review-friendly diff.',
      verb: 'prompt',
      prompt: 'Show me the combined diff from every file you touched this turn.',
    },
  },
  // Error/exception surfaced → offer to explain or pivot.
  {
    id: 'error.explain',
    when: (ctx) => ctx.errorSignal,
    chip: {
      id: 'explain-error',
      label: 'Explain this error',
      hint: 'Walk through the failing signal and the likely root cause.',
      verb: 'prompt',
      prompt: 'Explain the last error in plain language and point at the likely root cause.',
    },
  },
  {
    id: 'error.pivot',
    when: (ctx) => ctx.errorSignal && ctx.diffTools > 0,
    chip: {
      id: 'try-another',
      label: 'Try a different approach',
      hint: 'Back out of the current path and propose a second option.',
      verb: 'prompt',
      prompt: 'Back out of the current approach and propose a different one.',
    },
  },
  // Artifact landed → offer direct open (no round-trip).
  {
    id: 'artifact.open',
    when: (ctx) => !!ctx.lastArtifactId,
    chip: (ctx) => ({
      id: 'open-artifact',
      label: 'Open the artifact',
      hint: 'Open the artifact preview in your browser.',
      verb: 'open_artifact',
      artifactId: ctx.lastArtifactId,
    }),
  },
  // Widget/options landed → offer to fork before committing to a pick.
  {
    id: 'fork.before-pick',
    when: (ctx) => ctx.optionsWidget,
    chip: {
      id: 'fork-here',
      label: 'Fork here and try another path',
      hint: 'Branch this turn into a second session so you can compare both.',
      verb: 'note',
      note: 'user should press ⑂ on the last assistant reply to fork; nudge, not action',
      prompt: 'Fork this turn — I want to try a different answer in parallel.',
    },
  },
  // Long turn wound down with bash-heavy work → offer the smallest tests-first
  // move.
  {
    id: 'bash.smoke',
    when: (ctx) => ctx.bashTools >= 3 && !ctx.diffTools,
    chip: {
      id: 'smoke-check',
      label: 'Sanity-check the result',
      hint: 'Run the smallest smoke command to confirm the shell chain worked.',
      verb: 'prompt',
      prompt: 'Sanity-check the result with the smallest possible command.',
    },
  },
])

const MAX_CHIPS = 3

// -- context aggregation -----------------------------------------------------
//
// Fold the event window down to a compact "what happened this turn" shape.
// The rules read this and nothing else. Adding a trigger means: add a field
// here, populate it from an event kind, then reference it in `when`.

function emptyContext() {
  return {
    diffTools: 0,
    bashTools: 0,
    artifactTools: 0,
    optionsWidget: false,
    errorSignal: false,
    lastArtifactId: null,
    turnEnded: false,
  }
}

/**
 * Build a snapshot context from a flat list of session events.
 * The events must be in arrival order. Any subset of {SessionEvent}
 * shapes is accepted — missing fields silently zero out.
 */
function contextFromEvents(events) {
  const ctx = emptyContext()
  if (!Array.isArray(events)) return ctx
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const type = ev.type
    const data = ev.data || ev
    switch (type) {
      case 'tool/call': {
        const name = String(data.name || '')
        if (/^(edit|write|str_replace|apply_patch|multi_?edit|update_file|create_file|patch|notebook_?edit)/i.test(name)) {
          ctx.diffTools++
        } else if (/^(bash|shell|run(_command|_shell|_script)?|execute|terminal)$/i.test(name)) {
          ctx.bashTools++
        } else if (/^(artifact|show_artifact|create_artifact|preview|serve_artifact|render_html)/i.test(name)) {
          ctx.artifactTools++
        }
        break
      }
      case 'tool/result': {
        // Errors surface here — either a plain `isError`, or a text block with
        // a stderr-like keyword. The second is cheap and best-effort.
        if (data.isError === true) ctx.errorSignal = true
        const meta = data.meta
        if (meta && meta.card === 'widget' && meta.widget && meta.widget.kind === 'options') {
          ctx.optionsWidget = true
        }
        if (meta && (meta.card === 'artifact' || (meta.widget && meta.widget.kind === 'artifact'))) {
          // Artifact came through the widget/artifact meta.
          if (typeof meta.artifactId === 'string' && meta.artifactId) ctx.lastArtifactId = meta.artifactId
          else if (meta.widget && typeof meta.widget.id === 'string') ctx.lastArtifactId = meta.widget.id
        }
        if (data.content) {
          for (const block of Array.isArray(data.content) ? data.content : []) {
            if (block && block.type === 'text' && typeof block.text === 'string' &&
                /\b(error|exception|traceback|failed|failure|stderr)\b/i.test(block.text)) {
              ctx.errorSignal = true
            }
          }
        }
        break
      }
      case 'turn/end':
        ctx.turnEnded = true
        break
      case 'artifact/update': {
        // Alternate path: main.js may emit this outside the tool wire.
        const aid = data && data.artifactId
        if (typeof aid === 'string' && aid) ctx.lastArtifactId = aid
        break
      }
      default: break
    }
  }
  return ctx
}

// -- rule engine -------------------------------------------------------------

/**
 * Given a context (from contextFromEvents) and a set of dismissed chip ids,
 * return up to MAX_CHIPS suggestion chips. Pure — same input → same output.
 * A rule that returns a chip whose id is in `dismissed` is skipped.
 */
function suggestFromContext(ctx, dismissed) {
  const dismiss = dismissed instanceof Set ? dismissed : new Set(dismissed || [])
  const out = []
  for (const rule of RULES) {
    if (out.length >= MAX_CHIPS) break
    let matched = false
    try { matched = !!rule.when(ctx) } catch (_) { matched = false }
    if (!matched) continue
    const chip = typeof rule.chip === 'function' ? rule.chip(ctx) : rule.chip
    if (!chip || dismiss.has(chip.id)) continue
    out.push({ ...chip, ruleId: rule.id })
  }
  return out
}

/** Convenience: events → context → chips. */
function suggestFromEvents(events, dismissed) {
  return suggestFromContext(contextFromEvents(events), dismissed)
}

// -- stateful controller -----------------------------------------------------
//
// Renderer-facing: keeps a per-session sliding window of events + a dismissed
// set. `push(event)` returns the current chip list; `dismiss(id)` removes an
// id from future suggestions until the session resets. The controller is
// deliberately dumb: rewrites are the caller's job. It does not touch DOM or
// timers, so tests exercise it directly.

class NextActionTracker {
  constructor(opts = {}) {
    this.windowSize = opts.windowSize || 60
    this.events = []
    this.dismissed = new Set()
  }

  reset() {
    this.events = []
    this.dismissed.clear()
  }

  push(event) {
    if (event && typeof event === 'object') {
      this.events.push(event)
      if (this.events.length > this.windowSize) this.events.shift()
    }
    return this.suggest()
  }

  suggest() {
    return suggestFromEvents(this.events, this.dismissed)
  }

  dismiss(chipId) {
    if (typeof chipId === 'string' && chipId) this.dismissed.add(chipId)
  }
}

// -- verb catalogue (shared with widgets.js) ---------------------------------
//
// Kept here (not widgets.js) so tests can assert the same table both systems
// agree on. widgets.js re-imports this via globalThis.NextActions.VERBS at
// boot time — no ESM in this project, so we ride the same window-attach
// convention layout-heuristics uses.

const VERBS = Object.freeze({
  // REAL verbs (side-effectful).
  prompt: {
    kind: 'prompt',
    real: true,
    required: ['prompt'],
    label: 'send prompt',
  },
  open_link: {
    kind: 'open_link',
    real: true,
    required: ['url'],
    label: 'open URL',
  },
  open_artifact: {
    kind: 'open_artifact',
    real: true,
    required: ['artifactId'],
    label: 'open artifact',
  },
  switch_session: {
    kind: 'switch_session',
    real: true,
    required: ['sessionId'],
    label: 'switch session',
  },
  // RECORD-ONLY: fires a devtools event, produces no user-world change.
  // Rendered as a subtle-tinted button (visual signal that this is a log-only
  // gesture) but never disabled — a user who wants to "note it and move on"
  // can click through.
  note: {
    kind: 'note',
    real: false,
    required: [],
    label: 'note (record-only)',
  },
})

/**
 * Classify a widget action against the verb catalog. Returns:
 *   { verb: <VerbSpec>|null, broken: bool, reason: string|null }
 * `broken` is true when the verb is unknown OR the required payload fields
 * are missing/empty; the renderer surfaces this by disabling the button and
 * adding an "unsupported action" tooltip.
 *
 * Legacy actions without a `verb` field default to `prompt` (backward compat
 * with widgets shipped before the catalog existed).
 */
function classifyAction(action) {
  if (!action || typeof action !== 'object') {
    return { verb: null, broken: true, reason: 'missing action' }
  }
  const kind = typeof action.verb === 'string' && action.verb
    ? action.verb
    : 'prompt' // default for legacy actions
  const spec = VERBS[kind]
  if (!spec) {
    return { verb: null, broken: true, reason: `unknown verb: ${kind}` }
  }
  for (const field of spec.required) {
    const v = action[field]
    if (typeof v !== 'string' || v === '') {
      return { verb: spec, broken: true, reason: `missing "${field}" for verb ${kind}` }
    }
  }
  return { verb: spec, broken: false, reason: null }
}

// -- widget envelope validator ----------------------------------------------
//
// Ported from next-action-ui-lab/src/action-schema.mjs but scoped to a
// WidgetSpec (kind/id/data/actions), which is our envelope. Returns
// `{valid: bool, issues: [{field, message, severity}]}`; the renderer paints
// on `severity: 'broken'` (red overlay) versus `warn` (yellow chip).

function validateWidgetSpec(spec) {
  const issues = []
  if (!spec || typeof spec !== 'object') {
    return { valid: false, issues: [{ field: '/', message: 'not an object', severity: 'broken' }] }
  }
  if (typeof spec.kind !== 'string' || spec.kind === '') {
    issues.push({ field: 'kind', message: 'missing kind', severity: 'broken' })
  }
  if (typeof spec.id !== 'string' || spec.id === '') {
    issues.push({ field: 'id', message: 'missing id', severity: 'warn' })
  }
  if (Array.isArray(spec.actions)) {
    spec.actions.forEach((a, i) => {
      const c = classifyAction(a)
      if (c.broken) {
        issues.push({
          field: `actions[${i}]`,
          message: c.reason || 'invalid action',
          severity: 'broken',
        })
      }
    })
  }
  return {
    valid: issues.every((i) => i.severity !== 'broken'),
    issues,
  }
}

// -- exports -----------------------------------------------------------------

const api = {
  RULES,
  MAX_CHIPS,
  VERBS,
  emptyContext,
  contextFromEvents,
  suggestFromContext,
  suggestFromEvents,
  classifyAction,
  validateWidgetSpec,
  NextActionTracker,
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.NextActions = api
})()
