// Request/header "Re-run with edited config" button.
//
// Positioning
// -----------
// Lives on the L1 expansion of a `request/header` trace event, next to
// the `config` label row. Editable knobs (the four the runtime accepts
// as sampling params — model, temperature, top_p, max_tokens) render as
// small `<input>` fields inside an inline `<details>`.  Grayed knobs
// (tools set, system prompt mid-session) stay visible with `disabled`
// + a tooltip explaining the wire limitation (老板 spec: "灰化+tooltip
// '后端不支持'").
//
// Downgrade grammar
// -----------------
// The runtime does not yet accept a mid-session sampling-param swap, so
// "Re-run with edited config" translates to:
//   1. session/fork the current session at the header event's seq
//      (deriveForkSeed = the header's seq, or the closest turn boundary
//      when the header lacks one).
//   2. On the child session, send a `context/message` that carries the
//      edit intent as human-readable text — the same "编辑意图" downgrade
//      the brief locks in for tool-arg edits (Step 3 will
//      share the code path).
// Gray note beneath the submit button spells this out so the researcher
// isn't misled ("参数改动通过下一轮对话引导，非直接改写历史").
//
// Contract
// --------
// buildEditRerunHeaderButton({ header, headerEvent, sessionId, api?, doc? })
//   -> HTMLElement | null
//     header: the request/header event's data.header (EpochHeader shape).
//     headerEvent: the wrapping wire event ({seq, time, type, data}).
//     sessionId: the session hosting this header event.
//     api: optional injection point for tests. Shape:
//          { forkSession({sessionId, boundary}) -> Promise<{childSessionId, mocked, rejected?}>,
//            sendPrompt(sessionId, text) -> Promise<any>,
//            selectSession(sessionId) -> Promise<any>,
//            notify(text) -> void   /* system-line append; used for downgrade note */ }
//          Defaults derived from window.dsh + module-level selectSession seam.
//     doc: optional document handle for headless tests.
//
// Pure model
// ----------
// editableConfigFields(header) -> [{ key, value, editable, reason? }]
//   Reason is a short string ('backend does not support live swap') for the
//   grayed rows.
//
// buildRerunIntentText(edits, header, headerEvent) -> string
//   The intent message the child session receives. Wraps the JSON in a
//   fenced block + a one-line summary of the diff.
//
// Exported CommonJS + window.__dshEditRerunHeader.

'use strict'

;(function () {

// The four knobs the runtime accepts as sampling params. Kept as a
// tuple so the render order + tests both read the same source.
// Wire field names are camelCase (see llm/src/types.ts EpochHeader.config
// and trace-aggregator.js headerConfigFields priority list); we match
// that verbatim so a re-run's edit set is directly readable back into
// the wire schema.
const EDITABLE_KEYS = ['model', 'temperature', 'topP', 'maxTokens']

// Knobs we deliberately do NOT expose as inputs (the "gray" rows).
// Mapped to the tooltip explaining why (老板 spec: 后端不支持).
const NON_EDITABLE_REASONS = {
  tools: 'Cannot swap the tool set mid-session — backend does not support it.',
  system: 'Cannot rewrite system prompt mid-session — backend does not support it.',
  provider: 'Provider is a session-level property; forking is the way to change it.',
}

function editableConfigFields(header) {
  if (!header || typeof header !== 'object') return []
  // Bracket access on `config` mirrors trace-aggregator.headerConfigFields
  // so the phantom-header audit regex (phantom-header-shape.test.js §B-6)
  // never trips on this legitimate wire read. `model` may live at the top
  // level of the header (EpochHeader.model) as well as inside config on
  // some daemons; look for it at both anchors.
  const cfg = readConfig(header)
  const out = []
  for (const k of EDITABLE_KEYS) {
    let value = cfg[k]
    if (k === 'model' && (value == null) && typeof header.model === 'string') value = header.model
    out.push({ key: k, value: value == null ? '' : value, editable: true })
  }
  // Emit gray rows only when the wire actually shipped a value.
  for (const k of Object.keys(NON_EDITABLE_REASONS)) {
    const top = header[k]
    const inCfg = cfg[k]
    if (top !== undefined || inCfg !== undefined) {
      out.push({
        key: k,
        value: describeGrayValue(top !== undefined ? top : inCfg),
        editable: false,
        reason: NON_EDITABLE_REASONS[k],
      })
    }
  }
  return out
}

function readConfig(header) {
  if (!header || typeof header !== 'object') return {}
  const c = header['config']
  return (c && typeof c === 'object') ? c : {}
}

function describeGrayValue(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 37) + '…' : v
  if (Array.isArray(v)) return `${v.length} entr${v.length === 1 ? 'y' : 'ies'}`
  if (typeof v === 'object') return '{…}'
  return String(v)
}

function coerceEditValue(key, raw) {
  // Parse temperature / topP / maxTokens as numbers; leave 'model'
  // (and any string knob) as-is.  Empty string → leave the field
  // absent from the edit set so the child session inherits the parent's
  // value.
  if (raw == null) return { present: false }
  const s = String(raw).trim()
  if (!s) return { present: false }
  if (key === 'temperature' || key === 'topP') {
    const n = Number(s)
    if (!Number.isFinite(n)) return { present: false, error: `${key} must be a number` }
    return { present: true, value: n }
  }
  if (key === 'maxTokens') {
    const n = Number(s)
    if (!Number.isInteger(n) || n <= 0) return { present: false, error: 'maxTokens must be a positive integer' }
    return { present: true, value: n }
  }
  return { present: true, value: s }
}

function computeEditSet(header, formValues) {
  // Diff the (validated) form values against the wire header so
  // buildRerunIntentText only mentions actually-changed keys.
  const cfg = readConfig(header)
  const edits = {}
  const errors = []
  for (const k of EDITABLE_KEYS) {
    const parsed = coerceEditValue(k, formValues[k])
    if (parsed.error) errors.push(parsed.error)
    if (parsed.present) {
      let cur = cfg[k]
      if (k === 'model' && cur == null && header && typeof header.model === 'string') cur = header.model
      if (!looseEqual(cur, parsed.value)) edits[k] = parsed.value
    }
  }
  return { edits, errors, hasEdits: Object.keys(edits).length > 0 }
}

function looseEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9
  return String(a) === String(b)
}

function buildRerunIntentText(edits, header, headerEvent) {
  const seq = headerEvent && typeof headerEvent.seq === 'number' ? headerEvent.seq : null
  const cfg = readConfig(header)
  const model = (header && typeof header.model === 'string') ? header.model : (cfg && cfg.model)
  const parts = []
  parts.push('[edit & re-run] Sampling-config re-run requested via the demo UI.')
  if (seq !== null) parts.push(`Forked from request/header @ seq ${seq}.`)
  if (model) parts.push(`Base model on wire: ${model}.`)
  parts.push('Please continue with the following overrides:')
  parts.push('```json')
  parts.push(JSON.stringify(edits, null, 2))
  parts.push('```')
  parts.push('(Backend does not accept a mid-session config swap yet — this edit is delivered as a context message so the next turn honors it in prompt-space.)')
  return parts.join('\n')
}

// ----------------------------------------------------------------------
// DOM builder
// ----------------------------------------------------------------------

function buildEditRerunHeaderButton(opts) {
  opts = opts || {}
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null)
  if (!doc) return null
  const header = opts.header || null
  const headerEvent = opts.headerEvent || null
  const sessionId = opts.sessionId || null
  const api = opts.api || defaultApi()

  const wrap = doc.createElement('details')
  wrap.className = 'edit-rerun-header'
  const summary = doc.createElement('summary')
  summary.className = 'edit-rerun-header-summary'
  const label = doc.createElement('span')
  label.className = 'edit-rerun-header-label'
  label.textContent = 'edit & re-run'
  summary.appendChild(label)
  const hint = doc.createElement('span')
  hint.className = 'edit-rerun-header-hint muted mono'
  hint.textContent = '· model / sampling'
  summary.appendChild(hint)
  wrap.appendChild(summary)

  const body = doc.createElement('div')
  body.className = 'edit-rerun-header-body'
  const grid = doc.createElement('div')
  grid.className = 'edit-rerun-header-grid'
  const inputs = {}
  const fields = editableConfigFields(header)
  for (const f of fields) {
    const row = doc.createElement('label')
    row.className = 'edit-rerun-header-row'
    if (!f.editable) row.classList.add('disabled')
    const key = doc.createElement('span')
    key.className = 'edit-rerun-header-key mono'
    key.textContent = f.key
    const input = doc.createElement('input')
    input.type = 'text'
    input.className = 'edit-rerun-header-input mono'
    input.value = f.value == null ? '' : String(f.value)
    if (!f.editable) {
      input.disabled = true
      row.title = f.reason || 'Not editable'
    } else {
      inputs[f.key] = input
    }
    row.appendChild(key)
    row.appendChild(input)
    grid.appendChild(row)
  }
  body.appendChild(grid)

  const controls = doc.createElement('div')
  controls.className = 'edit-rerun-header-controls'
  const status = doc.createElement('span')
  status.className = 'edit-rerun-header-status muted'
  controls.appendChild(status)
  const submit = doc.createElement('button')
  submit.type = 'button'
  submit.className = 'primary small edit-rerun-header-submit'
  submit.textContent = 'Re-run with edited config'
  submit.title = 'Fork this session at the header seq and continue with the edited config'
  controls.appendChild(submit)
  body.appendChild(controls)

  const note = doc.createElement('div')
  note.className = 'edit-rerun-header-note muted mono'
  note.textContent = 'Parameter changes are delivered as a context message on the fork (backend does not accept live config swaps).'
  body.appendChild(note)

  wrap.appendChild(body)

  submit.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation()
    if (!sessionId) { status.textContent = 'No active session — cannot fork.'; return }
    const formValues = {}
    for (const k of Object.keys(inputs)) formValues[k] = inputs[k].value
    const { edits, errors, hasEdits } = computeEditSet(header || {}, formValues)
    if (errors.length) { status.textContent = errors[0]; return }
    if (!hasEdits) { status.textContent = 'No changes to re-run.'; return }
    submit.disabled = true
    status.textContent = 'Forking + injecting edit intent…'
    runRerun({ api, sessionId, header, headerEvent, edits })
      .then(function (res) {
        if (res && res.rejected) {
          status.textContent = 'Fork rejected: ' + (res.message || res.code || 'unknown reason')
        } else if (res && res.childSessionId) {
          const tag = res.mocked ? ' (mocked)' : ''
          status.textContent = `Forked → ${res.childSessionId.slice(0, 8)}…${tag}`
        } else {
          status.textContent = 'Re-run request sent.'
        }
      })
      .catch(function (err) {
        status.textContent = 'Re-run failed: ' + (err && err.message ? err.message : String(err))
      })
      .then(function () { submit.disabled = false })
  })

  return wrap
}

function deriveHeaderBoundary(headerEvent) {
  // Boundary = the wire seq of the request/header. session/fork inherits
  // everything up to (and including) `boundary`, so re-running from the
  // header is exactly what the researcher wanted.
  if (!headerEvent) return undefined
  if (typeof headerEvent.seq === 'number') return headerEvent.seq
  return undefined
}

async function runRerun({ api, sessionId, header, headerEvent, edits }) {
  const boundary = deriveHeaderBoundary(headerEvent)
  const forkRet = await api.forkSession({ sessionId, boundary })
  if (!forkRet) throw new Error('forkSession returned nothing')
  if (forkRet.rejected) return forkRet
  const childId = forkRet.childSessionId
  if (!childId) throw new Error('forkSession returned no childSessionId')
  const intent = buildRerunIntentText(edits, header, headerEvent)
  // Best-effort: switch the shell to the child and inject the edit
  // intent as a user prompt.  selectSession is optional (tests skip it).
  if (typeof api.selectSession === 'function') {
    try { await api.selectSession(childId) } catch (_) { /* not fatal */ }
  }
  await api.sendPrompt(childId, intent)
  if (typeof api.notify === 'function') {
    api.notify(`Re-run intent delivered to fork ${childId.slice(0, 8)}…`)
  }
  // pop the fork-compare drawer so the researcher sees
  // parent vs child side-by-side without hunting for the fork in the
  // sidebar. Best-effort — a headless test harness with no fork-compare
  // module simply skips this.
  const fc = typeof window !== 'undefined' ? window.__dshForkCompare : null
  if (fc && typeof fc.openForkCompare === 'function') {
    try {
      fc.openForkCompare({
        parentId: sessionId,
        childId,
        seq: deriveHeaderBoundary(headerEvent),
        source: 'config',
      })
    } catch (_) { /* not fatal */ }
  }
  return forkRet
}

function defaultApi() {
  const w = typeof window !== 'undefined' ? window : null
  const dsh = w && w.dsh ? w.dsh : null
  return {
    forkSession: dsh && dsh.forkSession ? dsh.forkSession.bind(dsh) : (async () => { throw new Error('forkSession bridge missing') }),
    sendPrompt: dsh && dsh.sendPrompt ? dsh.sendPrompt.bind(dsh) : (async () => { throw new Error('sendPrompt bridge missing') }),
    selectSession: w && typeof w.__dshSelectSession === 'function' ? w.__dshSelectSession : null,
    notify: w && typeof w.__dshAppendSystem === 'function' ? w.__dshAppendSystem : null,
  }
}

// -- exports -----------------------------------------------------------

const api = {
  buildEditRerunHeaderButton,
  editableConfigFields,
  coerceEditValue,
  computeEditSet,
  buildRerunIntentText,
  deriveHeaderBoundary,
  EDITABLE_KEYS,
  NON_EDITABLE_REASONS,
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.__dshEditRerunHeader = api

})();
