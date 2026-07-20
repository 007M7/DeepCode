// inspector-drawer.js — unified right-side Inspector for the Chat stream.
//
// Supersedes the two-pane `#tool-json-drawer` (tool-cards.openJsonDrawer):
// instead of a tool-only "raw call + raw result" drawer, every inspectable
// element in the stream — user bubble, assistant bubble, reasoning block,
// tool call, tool result, compact card, context 📎 card, subagent card —
// opens ONE drawer anchored to that element's source session event, with
// three tabs:
//
//   Pretty — a readable, type-specific enlarged view (message text, usage,
//            reasoning full text, tool args + result summary, …). A clean
//            typed projection, not a rebuilt card.
//   Raw    — the original session-log record: the verbatim session.event
//            pretty-printed as JSON, with a seq / type / time header + copy.
//            ("session log 里的原始记录".) Reconstructed records (e.g. a tool
//            card's call+result, an aggregated reasoning block) are labelled
//            as such so the reader is never told a synthesized blob is a
//            verbatim wire record.
//   JSON   — the same event through the app's existing recursive collapsible
//            Fields tree (window.__dshTraceDetailPane.buildJsonTree) — the
//            zero-drop, per-level-folding grammar used on the trace pane.
//
// Design guard (the `{ }` drawer philosophy this inherits): the pretty
// renderer is a projection; the JSON / Raw tabs are the source of truth.
//
// Split: the projections (projectPretty / formatRaw / normalizeTab) are pure
// and unit-tested from node:test; the DOM render + wiring guard on
// `typeof document`. Dual export mirrors tool-cards.js / trace-detail-pane.js.

'use strict'

;(function () {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'

  const TABS = ['pretty', 'raw', 'json']

  // --- pure helpers ------------------------------------------------------

  function normalizeTab (tab) {
    return TABS.indexOf(tab) >= 0 ? tab : 'pretty'
  }

  // Local copy of renderer.textFromContentBlocks — the inspector module is
  // standalone and can't reach into renderer.js. Concatenates `text` blocks.
  function textFromContentBlocks (blocks) {
    if (!Array.isArray(blocks)) return ''
    let out = ''
    for (const b of blocks) {
      if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') out += b.text
    }
    return out
  }

  // Best-effort readable text for a message-shaped payload: prefer a raw
  // `text` string, else fold `content` blocks.
  function messageText (data) {
    if (!data || typeof data !== 'object') return ''
    if (typeof data.text === 'string') return data.text
    if (Array.isArray(data.content)) return textFromContentBlocks(data.content)
    if (typeof data.content === 'string') return data.content
    return ''
  }

  function describeSource (source) {
    if (!source) return 'context'
    if (typeof source === 'string') return source
    if (typeof source === 'object') {
      if (source.kind === 'plugin' && source.plugin) return `plugin:${source.plugin}`
      if (source.kind === 'tool' && source.tool) return `tool:${source.tool}`
      if (source.kind) return source.kind
    }
    return 'context'
  }

  // Normalize an event's `type` into an inspector kind used by projectPretty
  // and the drawer title.
  function kindForEvent (event) {
    const t = (event && event.type) || ''
    if (t === 'user/message') return 'user'
    if (t === 'assistant/message') return 'assistant'
    if (t === 'reasoning') return 'reasoning'
    if (t === 'tool/call' || t === 'tool') return 'tool-call'
    if (t === 'tool/result') return 'tool-result'
    if (t === 'context/message' || t === 'steering/message') return 'context'
    if (t.indexOf('compact/') === 0) return 'compact'
    if (t.indexOf('subagent') === 0) return 'subagent'
    return 'event'
  }

  function argsText (args) {
    if (args == null) return ''
    if (typeof args === 'string') {
      try { return JSON.stringify(JSON.parse(args), null, 2) } catch { return args }
    }
    try { return JSON.stringify(args, null, 2) } catch { return String(args) }
  }

  const USAGE_LABELS = [
    ['inputTokens', 'input'], ['input_tokens', 'input'], ['promptTokens', 'input'],
    ['outputTokens', 'output'], ['output_tokens', 'output'], ['completionTokens', 'output'],
    ['totalTokens', 'total'], ['total_tokens', 'total'],
    ['reasoningTokens', 'reasoning'], ['cacheReadTokens', 'cache read'],
    ['cacheWriteTokens', 'cache write'],
  ]

  function usageRows (usage) {
    if (!usage || typeof usage !== 'object') return []
    const rows = []
    const seen = new Set()
    for (const [key, label] of USAGE_LABELS) {
      if (usage[key] != null && !seen.has(label)) {
        rows.push({ label, value: String(usage[key]) })
        seen.add(label)
      }
    }
    return rows
  }

  // Pure projection: event -> a readable, type-specific structure the Pretty
  // tab renders. Shape:
  //   { kind, title, meta: [{label, value}], blocks: [{label, text, mono?}] }
  // `meta` = small key/value chips; `blocks` = larger text panels.
  function projectPretty (event) {
    const ev = event || {}
    const data = (ev.data && typeof ev.data === 'object') ? ev.data : ev
    const kind = kindForEvent(ev)
    const meta = []
    const blocks = []
    if (typeof ev.seq === 'number') meta.push({ label: 'seq', value: String(ev.seq) })

    let title
    switch (kind) {
      case 'user': {
        title = 'User message'
        blocks.push({ label: 'text', text: messageText(data) })
        break
      }
      case 'assistant': {
        title = 'Assistant message'
        for (const r of usageRows(data.usage)) meta.push(r)
        blocks.push({ label: 'text', text: messageText(data) })
        break
      }
      case 'reasoning': {
        title = 'Reasoning'
        blocks.push({ label: 'thinking', text: messageText(data) || (typeof data.text === 'string' ? data.text : '') })
        break
      }
      case 'tool-call': {
        const name = data.name || '(tool)'
        title = `Tool call · ${name}`
        if (data.callId) meta.push({ label: 'callId', value: String(data.callId) })
        blocks.push({ label: 'arguments', text: argsText(data.arguments != null ? data.arguments : data.args), mono: true })
        const result = data.result
        if (result && typeof result === 'object') {
          if (result.isError != null) meta.push({ label: 'isError', value: String(!!result.isError) })
          if (result.durationMs != null) meta.push({ label: 'durationMs', value: String(result.durationMs) })
          const rt = messageText(result) || (typeof result.content === 'string' ? result.content : '')
          blocks.push({ label: 'result', text: rt || (result.isError ? '[error]' : '[ok]'), mono: true })
        } else {
          blocks.push({ label: 'result', text: '(result pending)', mono: true })
        }
        break
      }
      case 'tool-result': {
        title = 'Tool result'
        if (data.callId) meta.push({ label: 'callId', value: String(data.callId) })
        if (data.isError != null) meta.push({ label: 'isError', value: String(!!data.isError) })
        if (data.durationMs != null) meta.push({ label: 'durationMs', value: String(data.durationMs) })
        blocks.push({ label: 'content', text: messageText(data) || (data.isError ? '[error]' : '[ok]'), mono: true })
        break
      }
      case 'context': {
        title = ev.type === 'steering/message' ? 'Steering message' : 'Context injection'
        meta.push({ label: 'source', value: describeSource(data.source) })
        blocks.push({ label: 'payload', text: messageText(data) })
        break
      }
      case 'compact': {
        title = 'Compaction'
        meta.push({ label: 'phase', value: String(ev.type || '').replace('compact/', '') || 'summary' })
        blocks.push({ label: 'summary', text: messageText(data) || (typeof data.summary === 'string' ? data.summary : '') })
        break
      }
      case 'subagent': {
        title = 'Subagent'
        if (data.agentId) meta.push({ label: 'agentId', value: String(data.agentId) })
        if (data.status) meta.push({ label: 'status', value: String(data.status) })
        if (data.stopReason) meta.push({ label: 'stopReason', value: String(data.stopReason) })
        const msg = Array.isArray(data.lastAssistantMessage)
          ? textFromContentBlocks(data.lastAssistantMessage)
          : messageText(data)
        if (msg) blocks.push({ label: 'result', text: msg })
        break
      }
      default: {
        title = ev.type ? String(ev.type) : 'Event'
        const t = messageText(data)
        if (t) blocks.push({ label: 'text', text: t })
        break
      }
    }
    return { kind, title, meta, blocks }
  }

  // Strip inspector-internal markers before a record is shown verbatim /
  // fed to the JSON tree, so neither surface leaks `__reconstructed`.
  function cleanEvent (event) {
    if (!event || typeof event !== 'object') return event
    const out = {}
    for (const k of Object.keys(event)) {
      if (k === '__reconstructed' || k === '__synthesized') continue
      out[k] = event[k]
    }
    return out
  }

  // Pure projection for the Raw tab: the header line + pretty-printed JSON of
  // the (cleaned) event, plus a `reconstructed` flag + note when the record
  // is a synthesized combination rather than a single verbatim wire event.
  function formatRaw (event) {
    const ev = event || {}
    const clean = cleanEvent(ev)
    let json
    try { json = JSON.stringify(clean, null, 2) } catch { json = String(clean) }
    const reconstructed = !!(ev.__reconstructed || ev.__synthesized)
    return {
      header: {
        seq: typeof ev.seq === 'number' ? ev.seq : null,
        type: ev.type || 'event',
        time: ev.time || ev.timestamp || null,
      },
      json,
      reconstructed,
      note: reconstructed
        ? 'reconstructed record (combined / aggregated) — not a single verbatim wire event'
        : '',
    }
  }

  // --- DOM: pretty / raw panel renderers (doc-injected for tests) --------

  function renderPretty (doc, host, projection) {
    if (!host) return
    host.textContent = ''
    const proj = projection || { title: '', meta: [], blocks: [] }
    const title = doc.createElement('div')
    title.className = 'inspector-pretty-title'
    title.textContent = proj.title || ''
    host.appendChild(title)

    if (proj.meta && proj.meta.length) {
      const metaWrap = doc.createElement('div')
      metaWrap.className = 'inspector-pretty-meta'
      for (const m of proj.meta) {
        const chip = doc.createElement('span')
        chip.className = 'inspector-meta-chip'
        const k = doc.createElement('span')
        k.className = 'inspector-meta-key'
        k.textContent = m.label
        const v = doc.createElement('span')
        v.className = 'inspector-meta-value mono'
        v.textContent = m.value
        chip.appendChild(k); chip.appendChild(v)
        metaWrap.appendChild(chip)
      }
      host.appendChild(metaWrap)
    }

    for (const b of (proj.blocks || [])) {
      const section = doc.createElement('section')
      section.className = 'inspector-pretty-block'
      const label = doc.createElement('div')
      label.className = 'inspector-pretty-block-label'
      label.textContent = b.label
      const body = doc.createElement('div')
      body.className = 'inspector-pretty-block-body' + (b.mono ? ' mono' : '')
      body.textContent = (b.text != null && b.text !== '') ? b.text : '(empty)'
      section.appendChild(label); section.appendChild(body)
      host.appendChild(section)
    }
  }

  function renderRaw (doc, host, raw) {
    if (!host) return
    host.textContent = ''
    const head = doc.createElement('div')
    head.className = 'inspector-raw-head'
    const label = doc.createElement('span')
    label.className = 'inspector-raw-head-label muted'
    const parts = []
    if (raw.header.seq != null) parts.push(`seq ${raw.header.seq}`)
    parts.push(raw.header.type)
    if (raw.header.time != null) parts.push(String(raw.header.time))
    label.textContent = parts.join(' · ')
    const copy = doc.createElement('button')
    copy.type = 'button'
    copy.className = 'inspector-raw-copy ghost small'
    copy.textContent = 'copy'
    copy.title = 'Copy raw JSON'
    head.appendChild(label); head.appendChild(copy)
    host.appendChild(head)

    if (raw.reconstructed && raw.note) {
      const note = doc.createElement('div')
      note.className = 'inspector-raw-note'
      note.textContent = raw.note
      host.appendChild(note)
    }

    const pre = doc.createElement('pre')
    pre.className = 'inspector-raw-pre mono'
    pre.textContent = raw.json
    host.appendChild(pre)

    // Wire copy (browser only; the shim doc in tests has no navigator).
    if (isBrowser) {
      copy.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        const text = pre.textContent || ''
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => { copy.textContent = 'copied'; setTimeout(() => { copy.textContent = 'copy' }, 900) },
            () => { copy.textContent = 'err'; setTimeout(() => { copy.textContent = 'copy' }, 900) },
          )
        }
      })
    }
  }

  function renderJson (doc, host, event) {
    if (!host) return
    host.textContent = ''
    const clean = cleanEvent(event)
    const td = (typeof window !== 'undefined') ? window.__dshTraceDetailPane : null
    if (td && typeof td.buildJsonTree === 'function') {
      // Reuse the app's recursive collapsible Fields tree — do NOT rebuild it.
      host.appendChild(td.buildJsonTree(doc, clean, { rootName: null, openDepth: 1 }))
      return
    }
    // Fallback for early boot / headless: flat pre.
    const pre = doc.createElement('pre')
    pre.className = 'inspector-raw-pre mono'
    try { pre.textContent = JSON.stringify(clean, null, 2) } catch { pre.textContent = String(clean) }
    host.appendChild(pre)
  }

  // --- drawer state + wiring (browser only) ------------------------------

  const state = { event: null, tab: 'pretty', title: '' }

  function drawerEl () {
    return (isBrowser && document.getElementById) ? document.getElementById('inspector-drawer') : null
  }

  function renderActivePanel (drawer) {
    if (!drawer || !state.event) return
    const doc = drawer.ownerDocument || document
    // Reflect the active tab on the buttons + panels.
    const tabs = drawer.querySelectorAll ? drawer.querySelectorAll('.inspector-tab') : []
    tabs.forEach((btn) => {
      const on = btn.dataset && btn.dataset.tab === state.tab
      btn.setAttribute('aria-selected', on ? 'true' : 'false')
      btn.classList.toggle('active', on)
    })
    const panels = drawer.querySelectorAll ? drawer.querySelectorAll('.inspector-panel') : []
    panels.forEach((p) => { p.hidden = !(p.dataset && p.dataset.panel === state.tab) })

    const host = drawer.querySelector(`.inspector-panel[data-panel="${state.tab}"]`)
    if (!host) return
    if (state.tab === 'pretty') renderPretty(doc, host, projectPretty(state.event))
    else if (state.tab === 'raw') renderRaw(doc, host, formatRaw(state.event))
    else renderJson(doc, host, state.event)

    const titleEl = drawer.querySelector('.inspector-drawer-title')
    if (titleEl) titleEl.textContent = state.title || projectPretty(state.event).title || 'inspector'
  }

  function setTab (tab) {
    state.tab = normalizeTab(tab)
    const drawer = drawerEl()
    if (drawer) renderActivePanel(drawer)
    return state.tab
  }

  // Open the inspector anchored to `event` (a real or reconstructed
  // session.event). `tab` selects the initial tab; `title` overrides the
  // derived headline.
  function open (input) {
    const opts = input || {}
    if (!opts.event) return null
    state.event = opts.event
    state.tab = normalizeTab(opts.tab)
    state.title = opts.title || ''
    const drawer = drawerEl()
    if (!drawer) return null
    renderActivePanel(drawer)
    drawer.classList.add('open')
    drawer.setAttribute('aria-hidden', 'false')
    const escHandler = (e) => { if (e && e.key === 'Escape') close() }
    drawer._escHandler = escHandler
    document.addEventListener('keydown', escHandler)
    return drawer
  }

  // Adapter for the legacy tool-cards.openJsonDrawer contract, so its call
  // sites (tool-card `{ }` badge, devtools / trace raw badges, context page)
  // all route into the one inspector. When `call`/`result` are present it is
  // the tool-card path: reconstruct a combined tool/call record so all three
  // tabs show call + result together (the legacy two-pane drawer's intent).
  // A bare `event` is a verbatim session.event (devtools / trace).
  function openFromDrawer (input) {
    const opts = input || {}
    let event
    if (opts.call || opts.result) {
      const call = opts.call || {}
      event = {
        type: 'tool/call',
        seq: opts.event && typeof opts.event.seq === 'number' ? opts.event.seq : undefined,
        time: opts.event && (opts.event.time || opts.event.timestamp),
        data: {
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
          result: opts.result || null,
        },
        __reconstructed: true,
      }
    } else if (opts.event && typeof opts.event === 'object') {
      event = opts.event
    } else {
      event = { type: 'event', data: {}, __reconstructed: true }
    }
    return open({ event, tab: opts.tab || 'json', title: opts.title })
  }

  function close () {
    const drawer = drawerEl()
    if (!drawer) return
    drawer.classList.remove('open')
    drawer.setAttribute('aria-hidden', 'true')
    const esc = drawer._escHandler
    if (esc) { document.removeEventListener('keydown', esc); drawer._escHandler = null }
  }

  // Build an unobtrusive "{ }" inspect affordance and hang it on `el`. The
  // caller supplies `getTarget()` returning { event, tab, title } resolved at
  // click time (so bubbles can synthesize from live DOM text). `opts.hover`
  // makes it a hover-revealed badge (bubble / reasoning) rather than an
  // always-visible one.
  function attachInspectBadge (el, getTarget, opts) {
    if (!isBrowser || !el) return null
    const o = opts || {}
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'inspect-badge' + (o.hover ? ' inspect-badge-hover' : '')
    btn.textContent = '{ }'
    btn.title = 'Inspect · Pretty / Raw / JSON'
    btn.setAttribute('aria-label', 'Inspect this element (Pretty, Raw, JSON)')
    btn.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation()
      if (e && e.preventDefault) e.preventDefault()
      const target = typeof getTarget === 'function' ? getTarget() : null
      if (target && target.event) open(target)
    })
    el.appendChild(btn)
    return btn
  }

  function install () {
    if (!isBrowser) return
    const drawer = drawerEl()
    if (!drawer || drawer.dataset.wired === '1') return
    drawer.dataset.wired = '1'
    const closeBtn = document.getElementById('inspector-drawer-close')
    if (closeBtn) closeBtn.addEventListener('click', () => close())
    const tabs = drawer.querySelectorAll('.inspector-tab')
    tabs.forEach((btn) => {
      btn.addEventListener('click', () => { if (btn.dataset) setTab(btn.dataset.tab) })
    })
  }

  if (isBrowser) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install)
    else install()
  }

  const api = {
    // pure
    normalizeTab, projectPretty, formatRaw, kindForEvent, TABS,
    // dom renderers (doc-injected)
    renderPretty, renderRaw, renderJson,
    // drawer
    open, openFromDrawer, close, setTab, install, attachInspectBadge,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (isBrowser) window.__dshInspector = api
})()
