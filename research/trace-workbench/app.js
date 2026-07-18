const state = {
  sessions: [],
  session: null,
  selected: null,          // chat-side selection (drives the inspector)
  activeDetailTab: 'input',
  inspectorOpen: false,    // chat-only second-level panel
  expandedTrajectorySeqs: new Set(),
  annotateOpenIds: new Set(),
  trajGroups: [],          // step-grouped trajectory rows (lifecycle events become group metadata)
  trajectoryRows: [],      // flat row list across all groups
  turnMeta: new Map(),     // turn -> {trigger, reason, startTime, endTime}
  sessionQuery: '',
  // Per-session indexes, rebuilt on every loadSession:
  seqMap: new Map(),          // seq -> event (tree nodes reference events by seq)
  callPairs: new Map(),       // callId -> { call, result }
  firstChunkByStep: new Map(), // "turn:step" -> first assistant/chunk time
}

const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]

async function api(path) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function ms(seconds) {
  if (!Number.isFinite(seconds)) return '0ms'
  return seconds >= 1 ? `${seconds.toFixed(2)}s` : `${Math.round(seconds * 1000)}ms`
}

function fmtOffset(seconds) {
  return `+${ms(Math.max(0, seconds))}`
}

function dateTime(msValue) {
  if (!Number.isFinite(msValue)) return 'unknown'
  return new Date(msValue).toLocaleString()
}

function truncate(value, limit = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text
}

function nodeGlyph(kind) {
  return {
    session: 'S',
    turn: 'T',
    step: 'ST',
    tool: 'TL',
    llm: 'AI',
    event: 'EV',
  }[kind] ?? 'N'
}

function flatten(node, depth = 0, out = []) {
  if (!node) return out
  out.push({ ...node, depth })
  for (const child of node.children ?? []) flatten(child, depth + 1, out)
  return out
}

function currentNodes() {
  return flatten(state.session?.tree)
}

function findNode(id) {
  return currentNodes().find(node => node.id === id) ?? state.session?.tree
}

// Tree nodes carry eventSeqs (not embedded events); resolve through the seq index.
function eventsOf(node) {
  if (node?.rawEvents) return node.rawEvents
  return (node?.eventSeqs ?? []).map(seq => state.seqMap.get(seq)).filter(Boolean)
}

function resolvePrompt(node) {
  const seq = node?.detail?.promptSeq
  if (seq !== undefined) return state.seqMap.get(seq)?.data?.header
  return node?.detail?.prompt
}

function contentToText(content) {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text ?? ''
    if (block.type === 'tool-call') return `[tool-call ${block.name}] ${block.arguments ?? ''}`
    if (block.type === 'tool-result') return `[tool-result] ${JSON.stringify(block.content ?? block)}`
    return JSON.stringify(block)
  }).filter(Boolean).join('\n')
}

function contentBlocks(content) {
  return Array.isArray(content) ? content : []
}

function renderValue(value, format) {
  if (value === undefined || value === null || value === '') return ''
  if (format === 'json') return JSON.stringify(value, null, 2)
  if (format === 'jsonl') {
    const rows = Array.isArray(value) ? value : [value]
    return rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n')
  }
  if (format === 'yaml') return toYaml(value)
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(item => item?.type)) return contentToText(value)
  return JSON.stringify(value, null, 2)
}

function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return value.map(item => {
      if (item && typeof item === 'object') return `${pad}-\n${toYaml(item, indent + 2)}`
      return `${pad}- ${toYaml(item)}`
    }).join('\n')
  }
  return Object.entries(value).map(([key, item]) => {
    if (item && typeof item === 'object') return `${pad}${key}:\n${toYaml(item, indent + 2)}`
    return `${pad}${key}: ${toYaml(item)}`
  }).join('\n')
}

// Minimal safe markdown for the Chat surface: input is escaped FIRST, then a
// line-based pass adds structure. Headings, lists, hr, fenced code, inline
// bold/code/links (http(s) only). Everything unrecognized stays a paragraph.
function mdInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

function mdSplitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

const MD_TABLE_ROW = /^\s*\|.*\|\s*$/
// A |---|:---:| separator row (text is already HTML-escaped, pipes unaffected).
const MD_TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/

function renderMarkdown(text) {
  const lines = escapeHtml(text).split('\n')
  const out = []
  let inCode = false
  let listType = null
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      closeList()
      out.push(inCode ? '</pre>' : '<pre class="md-code">')
      inCode = !inCode
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }
    // Table: a |...| row whose next line is the |---|---| separator.
    if (MD_TABLE_ROW.test(line) && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      closeList()
      const header = mdSplitRow(line)
      const aligns = mdSplitRow(lines[i + 1]).map(cell => {
        if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
        if (cell.endsWith(':')) return 'right'
        return ''
      })
      i += 1
      const rows = []
      while (i + 1 < lines.length && MD_TABLE_ROW.test(lines[i + 1])) {
        i += 1
        rows.push(mdSplitRow(lines[i]))
      }
      const cellHtml = (tag, cells) => cells.map((cell, k) =>
        `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${mdInline(cell)}</${tag}>`).join('')
      out.push('<div class="md-table-wrap"><table class="md-table">')
      out.push(`<thead><tr>${cellHtml('th', header)}</tr></thead>`)
      out.push(`<tbody>${rows.map(row => `<tr>${cellHtml('td', row)}</tr>`).join('')}</tbody>`)
      out.push('</table></div>')
      continue
    }
    // Blockquote ('>' is already escaped to &gt;).
    if (/^\s*&gt;\s?/.test(line)) {
      closeList()
      const quote = []
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*&gt;\s?/, ''))
        i += 1
      }
      i -= 1
      out.push(`<blockquote>${quote.map(q => mdInline(q)).join('<br>')}</blockquote>`)
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = Math.min(heading[1].length + 2, 5)
      out.push(`<h${level} class="md-h">${mdInline(heading[2])}</h${level}>`)
      continue
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      closeList()
      out.push('<hr>')
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${mdInline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      continue
    }
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/)
    if (ordered) {
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li value="${ordered[1]}">${mdInline(ordered[2])}</li>`)
      continue
    }
    if (!line.trim()) {
      closeList()
      continue
    }
    out.push(`<p>${mdInline(line)}</p>`)
  }
  if (inCode) out.push('</pre>')
  closeList()
  return out.join('\n')
}

function toast(text) {
  const el = $('#toast')
  el.textContent = text
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 1500)
}

function backendOpenHint(error) {
  const currentUrl = window.location.href
  const expectedUrl = 'http://127.0.0.1:5173/'
  const fileHint = window.location.protocol === 'file:'
    ? '<p>You opened the HTML file directly. The API only works through the local server.</p>'
    : ''
  return `
    <div class="error-state backend-error">
      <strong>Backend data did not load in this browser tab.</strong>
      ${fileHint}
      <p>Current URL: <code>${escapeHtml(currentUrl)}</code></p>
      <p>Open this instead: <code>${expectedUrl}</code></p>
      <p>Error: <code>${escapeHtml(error.message)}</code></p>
    </div>
  `
}

function syncUrl() {
  if (!state.session) return
  const params = new URLSearchParams()
  params.set('session', state.session.header.id)
  const activeView = document.querySelector('[data-main-view].active')?.dataset.mainView
  if (activeView && activeView !== 'conversation') params.set('view', activeView)
  const selId = state.selected?.id
  if (selId && selId !== state.session.tree?.id) params.set('sel', selId)
  history.replaceState(null, '', `?${params.toString()}`)
}

async function loadSessions(preferredId) {
  const data = await api('/api/sessions')
  state.sessions = data.sessions
  $('#sourceLine').textContent = `${data.sessions.length} sessions from ${data.root}`
  renderSessionList(preferredId)
  const id = preferredId ?? state.sessions.find(session => !session.parentSession)?.id ?? state.sessions[0]?.id
  if (id) await loadSession(id)
}

async function loadSession(id) {
  document.querySelector('.main-pane')?.classList.add('loading')
  try {
    await loadSessionInner(id)
  } finally {
    document.querySelector('.main-pane')?.classList.remove('loading')
  }
}

async function loadSessionInner(id) {
  state.session = await api(`/api/sessions/${encodeURIComponent(id)}`)
  state.selected = state.session.tree
  state.inspectorOpen = false
  state.annotateOpenIds = new Set()
  state.seqMap = new Map(state.session.events.map(event => [event.seq, event]))
  state.callPairs = new Map()
  state.firstChunkByStep = new Map()
  for (const event of state.session.events) {
    if (event.type === 'tool/call') {
      state.callPairs.set(event.data?.callId, { call: event })
    } else if (event.type === 'tool/result') {
      const pair = state.callPairs.get(event.data?.callId)
      if (pair) pair.result = event
      else state.callPairs.set(event.data?.callId, { result: event })
    } else if (event.type === 'assistant/chunk') {
      const key = `${event.data?.turn}:${event.data?.step}`
      if (!state.firstChunkByStep.has(key)) state.firstChunkByStep.set(key, event.time)
    }
  }
  const firstAssistant = state.session.events.find(event => event.type === 'assistant/message')
  state.expandedTrajectorySeqs = new Set(firstAssistant ? [`event:${firstAssistant.seq}`] : [])
  renderAll()
  syncUrl()
}

function sessionRowHtml(session, isChild, kidCount) {
  return `
    <button class="session-row ${isChild ? 'child' : ''} ${session.id === state.session?.header?.id ? 'selected' : ''}" data-select-session="${escapeHtml(session.id)}">
      <span class="session-title">${isChild ? '<span class="child-mark">↳</span> ' : ''}${escapeHtml(session.title || session.id)}</span>
      <span class="session-meta">${session.turnCount} turns · ${session.stepCount} steps · ${session.toolCallCount} tools${kidCount ? ` · <span class="kid-count">${kidCount} sub</span>` : ''}</span>
      <span class="session-time">${escapeHtml(dateTime(session.lastActivity))}</span>
    </button>
  `
}

function renderSessionList(preferredId = state.session?.header?.id) {
  const query = state.sessionQuery.toLowerCase().trim()
  const matches = session => !query || `${session.title} ${session.id} ${session.cwd} ${session.model}`.toLowerCase().includes(query)
  const ids = new Set(state.sessions.map(session => session.id))
  const childrenByParent = new Map()
  const tops = []
  for (const session of state.sessions) {
    if (session.parentSession && ids.has(session.parentSession)) {
      if (!childrenByParent.has(session.parentSession)) childrenByParent.set(session.parentSession, [])
      childrenByParent.get(session.parentSession).push(session)
    } else {
      tops.push(session)
    }
  }
  const html = tops.map(parent => {
    const kids = (childrenByParent.get(parent.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)
    const anyKidMatches = kids.some(matches)
    if (!matches(parent) && !anyKidMatches) return ''
    const visibleKids = matches(parent) ? kids : kids.filter(matches)
    return sessionRowHtml(parent, Boolean(parent.parentSession), kids.length)
      + visibleKids.map(kid => sessionRowHtml(kid, true, 0)).join('')
  }).join('')
  $('#sessionList').innerHTML = html || '<div class="empty-state">No sessions match the filter.</div>'
  if (preferredId) {
    $$('#sessionList .session-row').forEach(row => row.classList.toggle('selected', row.dataset.selectSession === preferredId))
  }
}

function renderAll() {
  renderChrome()
  renderSessionList()
  renderConversation()
  renderTrajectory()
  renderTrajTree()
  renderWaterfall()
  // Apply the requested view BEFORE renderDetails: renderDetails syncs the URL
  // from the currently-active view button, which would erase ?view= otherwise.
  applyRequestedView()
  renderDetails()
  renderInspectorState()
}

// One #detailDrawer element, moved into whichever split view is active (Chat or
// Waterfall). Trajectory is self-contained and never shows it.
function renderInspectorState() {
  const drawer = $('#detailDrawer')
  const chatSplit = $('#chatSplit')
  const wfSplit = $('#wfSplit')
  const view = document.querySelector('[data-main-view].active')?.dataset.mainView
  const target = view === 'waterfall' ? wfSplit : view === 'conversation' ? chatSplit : null
  chatSplit?.classList.remove('inspector-open')
  wfSplit?.classList.remove('inspector-open')
  if (drawer && target && drawer.parentElement !== target) target.appendChild(drawer)
  if (target && state.inspectorOpen) target.classList.add('inspector-open')
}

function openInspector() {
  state.inspectorOpen = true
  renderInspectorState()
}

function closeInspector() {
  state.inspectorOpen = false
  renderInspectorState()
}

function showMainView(viewName) {
  const button = document.querySelector(`[data-main-view="${viewName}"]`)
  if (!button) return
  $$('[data-main-view]').forEach(item => item.classList.toggle('active', item === button))
  $$('.view').forEach(view => view.classList.remove('active'))
  $(`#${viewName}View`)?.classList.add('active')
  renderInspectorState()
  syncUrl()
}

function applyRequestedView() {
  const view = new URLSearchParams(window.location.search).get('view')
  if (['trajectory', 'conversation', 'waterfall'].includes(view)) showMainView(view)
}

function renderChrome() {
  const session = state.session
  if (!session) return
  const summary = state.sessions.find(item => item.id === session.header.id)
  $('#conversationTitle').textContent = summary?.title || session.header.id
  const crumb = $('#sessionCrumb')
  if (crumb) {
    crumb.innerHTML = session.parent
      ? `<button class="crumb" data-load-session="${escapeHtml(session.parent.id)}" title="Open the session that spawned this one">↳ spawned by: ${escapeHtml(truncate(session.parent.title ?? session.parent.id, 48))}</button>`
      : ''
  }
}

/* ── Trajectory: step-grouped rows + navigation tree ─────────────────────────
   Lifecycle events (turn/step start/end) are NOT rows: they become the tree
   nodes and the sticky group headers, so the tree never duplicates the table. */

function buildTrajectory() {
  const groups = []
  const rows = []
  state.turnMeta = new Map()
  let current = null
  let chunkGroup = null
  let rowIndex = 0

  const pushGroup = (turn, step, startTime) => {
    current = {
      key: `g:${turn}:${step ?? 'pre'}`,
      turn,
      step,
      startTime,
      endTime: startTime,
      rows: [],
      hasError: false,
    }
    groups.push(current)
    return current
  }

  const pushRow = (event, rawEvents) => {
    if (!current) pushGroup(event.data?.turn ?? 0, null, event.time)
    const row = { id: event.type === 'assistant/chunks' ? `chunks:${rawEvents[0].seq}` : `event:${event.seq}`, event, rawEvents, index: ++rowIndex, group: current }
    current.rows.push(row)
    rows.push(row)
    if (eventIsError(event)) current.hasError = true
    current.endTime = Math.max(current.endTime, rawEvents.at(-1)?.time ?? event.time)
  }

  const flushChunks = () => {
    if (!chunkGroup) return
    const first = chunkGroup.events[0]
    pushRow({
      seq: first.seq,
      time: first.time,
      type: 'assistant/chunks',
      data: {
        turn: first.data?.turn,
        step: first.data?.step,
        count: chunkGroup.events.length,
        chunks: chunkGroup.events,
      },
    }, chunkGroup.events)
    chunkGroup = null
  }

  for (const event of state.session.events) {
    switch (event.type) {
      case 'turn/start': {
        flushChunks()
        state.turnMeta.set(event.data.turn, { trigger: event.data.trigger?.kind, startTime: event.time })
        pushGroup(event.data.turn, null, event.time)
        break
      }
      case 'turn/end': {
        flushChunks()
        const meta = state.turnMeta.get(event.data.turn)
        if (meta) {
          meta.reason = event.data.reason?.kind
          meta.endTime = event.time
        }
        break
      }
      case 'step/start': {
        flushChunks()
        pushGroup(event.data.turn, event.data.step, event.time)
        break
      }
      case 'step/end': {
        flushChunks()
        if (current && current.step === event.data.step) current.endTime = event.time
        break
      }
      case 'assistant/chunk': {
        const key = `${event.data?.turn}:${event.data?.step}`
        if (chunkGroup && chunkGroup.key !== key) flushChunks()
        if (!chunkGroup) chunkGroup = { key, events: [] }
        chunkGroup.events.push(event)
        break
      }
      default: {
        flushChunks()
        pushRow(event, [event])
      }
    }
  }
  flushChunks()

  state.trajGroups = groups.filter(group => group.rows.length || group.step !== null)
  state.trajectoryRows = rows
}

function groupDurationSec(group) {
  return Math.max(0, (group.endTime - group.startTime) / 1000)
}

function groupToolSummary(group) {
  const names = group.rows.filter(row => row.event.type === 'tool/call').map(row => row.event.data?.name ?? 'tool')
  if (!names.length) return ''
  const counts = new Map()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts.entries()].map(([name, n]) => n > 1 ? `${name} ×${n}` : name).join(' · ')
}

function renderTrajTree() {
  const root = $('#trajTree')
  if (!root || !state.session) return
  const turns = new Map()
  for (const group of state.trajGroups) {
    if (!turns.has(group.turn)) turns.set(group.turn, [])
    turns.get(group.turn).push(group)
  }
  root.innerHTML = [...turns.entries()].map(([turn, groups]) => {
    const meta = state.turnMeta.get(turn) ?? {}
    const dur = meta.startTime && meta.endTime ? ms((meta.endTime - meta.startTime) / 1000) : ''
    const steps = groups.map(group => {
      const label = group.step === null ? `turn ${group.turn} input` : `step ${group.step}`
      const sub = group.step === null
        ? truncate(contentToText(group.rows.find(r => r.event.type === 'user/message')?.event.data?.content) || (meta.trigger ?? ''), 34)
        : groupToolSummary(group)
      return `
        <button class="tree-step ${group.hasError ? 'error' : ''}" type="button" data-jump-group="${escapeHtml(group.key)}">
          <span class="t-name">${escapeHtml(label)}</span>
          <span class="t-dur">${ms(groupDurationSec(group))}</span>
          ${sub ? `<span class="t-sub">${escapeHtml(sub)}</span>` : ''}
        </button>
      `
    }).join('')
    return `
      <details class="tree-turn" open>
        <summary class="tree-turn-head"><span class="tt-label">turn ${turn}${meta.reason ? ` · ${escapeHtml(meta.reason)}` : ''}</span><span class="t-dur">${dur}</span></summary>
        <div class="tree-steps">${steps}</div>
      </details>
    `
  }).join('') || '<div class="empty-state">No structure.</div>'
}

function roleOfEvent(event) {
  if (event.type === 'assistant/message' || event.type === 'assistant/chunks') return 'assistant'
  if (event.type === 'tool/call' || event.type === 'tool/result') return 'tool'
  if (event.type === 'request/header') return 'system'
  if (event.type === 'context/message' || event.type === 'steering/message') return 'system'
  if (event.type === 'user/message') return 'user'
  return 'meta'
}

function toolCallsFromContent(content) {
  return contentBlocks(content).filter(block => block.type === 'tool-call')
}

function usageOfEvent(event) {
  const usage = event.data?.usage ?? {}
  return {
    input: usage.inputTokens ?? usage.input_tokens ?? '',
    output: usage.outputTokens ?? usage.output_tokens ?? '',
    think: usage.reasoningTokens ?? usage.reasoning_tokens ?? '',
  }
}

function eventIsError(event) {
  if (event.type === 'tool/result') return Boolean(event.data?.isError)
  if (event.type === 'tool/call') return Boolean(state.callPairs.get(event.data?.callId)?.result?.data?.isError)
  return false
}

function pairedDurationSec(event) {
  const pair = state.callPairs.get(event.data?.callId)
  if (!pair?.call || !pair?.result) return 0
  return Math.max(0, (pair.result.time - pair.call.time) / 1000)
}

function trajectoryTitle(event) {
  if (event.type === 'request/header') {
    const header = event.data?.header ?? {}
    return `request envelope · ${header.config?.model ?? 'unknown model'} · ${(header.tools ?? []).length} tools · system ${String(header.system ?? '').length} chars`
  }
  if (event.type === 'assistant/chunks') return `${event.data?.count ?? 0} streaming chunks`
  if (event.type === 'tool/call') return `${event.data?.name ?? 'tool call'} · ${truncate(event.data?.arguments ?? '', 96)}`
  if (event.type === 'tool/result') return truncate(contentToText(event.data?.content) || event.data?.callId || 'tool result', 96)
  const toolCalls = toolCallsFromContent(event.data?.content)
  if (toolCalls.length) return toolCalls.map(call => call.name).join(', ')
  return truncate(contentToText(event.data?.content) || eventPreview(event), 96)
}

function feedbackFor(targetId) {
  return (state.session.feedback ?? []).filter(item => item.data?.targetId === targetId)
}

function renderTrajectory() {
  buildTrajectory()
  if (!state.trajectoryRows.length) {
    $('#trajectory').innerHTML = '<div class="empty-state">No trajectory events in this session.</div>'
    return
  }
  const header = `
    <div class="traj-head-row">
      <span>#</span>
      <span>event</span>
      <span>content</span>
      <span class="num">in</span>
      <span class="num">out</span>
      <span class="num">think</span>
      <span class="num" title="offset from session start">time</span>
      <span></span>
    </div>
  `
  const body = state.trajGroups.map(group => {
    const label = group.step === null
      ? `turn ${group.turn}${state.turnMeta.get(group.turn)?.trigger ? ` · ${state.turnMeta.get(group.turn).trigger}` : ''}`
      : `step ${group.step}`
    const head = `
      <div class="traj-group-head ${group.hasError ? 'error' : ''}" data-group-anchor="${escapeHtml(group.key)}">
        <span>${escapeHtml(label)}</span>
        <span class="g-dur">${ms(groupDurationSec(group))}</span>
        ${groupToolSummary(group) ? `<span class="g-meta">${escapeHtml(groupToolSummary(group))}</span>` : ''}
      </div>
    `
    return head + group.rows.map(row => renderTrajectoryRow(row)).join('')
  }).join('')
  $('#trajectory').innerHTML = header + body
}

function renderTrajectoryRow(row) {
  const { event, index, id } = row
  const role = roleOfEvent(event)
  const usage = usageOfEvent(event)
  const toolCalls = toolCallsFromContent(event.data?.content)
  const expanded = state.expandedTrajectorySeqs.has(id)
  const isError = eventIsError(event)
  const metaChip = trajectoryMetaChip(event, toolCalls, isError)
  const offsetSec = (event.time - state.session.stats.startTime) / 1000
  const fbCount = feedbackFor(id).length
  return `
    <article class="traj-row ${role} ${isError ? 'error' : ''} ${expanded ? 'expanded' : ''}" data-select-trajectory-row="${escapeHtml(id)}">
      <div class="traj-summary" role="button" tabindex="0" data-toggle-trajectory="${escapeHtml(id)}">
        <span class="traj-index">#${index}</span>
        <span class="role-chip ${role}">${escapeHtml(event.type)}</span>
        <span class="traj-content">${metaChip}<span class="traj-title">${escapeHtml(trajectoryTitle(event))}</span>${fbCount ? `<span class="fb-chip" title="${fbCount} annotations">✎${fbCount}</span>` : ''}</span>
        <span class="token-cell">${escapeHtml(String(usage.input ?? ''))}</span>
        <span class="token-cell">${escapeHtml(String(usage.output ?? ''))}</span>
        <span class="token-cell">${escapeHtml(String(usage.think ?? ''))}</span>
        <span class="token-cell offset">${fmtOffset(offsetSec)}</span>
        <span class="chevron">${expanded ? '▾' : '▸'}</span>
      </div>
      ${expanded ? renderTrajectoryBody(row) : ''}
    </article>
  `
}

function rerenderTrajectoryRow(id) {
  const row = state.trajectoryRows.find(item => item.id === id)
  const el = document.querySelector(`[data-select-trajectory-row="${CSS.escape(id)}"]`)
  if (!row || !el) {
    renderTrajectory()
    return
  }
  el.outerHTML = renderTrajectoryRow(row)
}

function trajectoryMetaChip(event, toolCalls, isError) {
  if (toolCalls.length) return `<span class="tool-chip">→ ${escapeHtml(toolCalls.map(call => call.name).join(', '))}</span>`
  if (event.type === 'tool/result') return isError ? '<span class="result-chip error">← error</span>' : '<span class="result-chip">← result</span>'
  if (event.type === 'tool/call') return `<span class="tool-chip">→ ${escapeHtml(event.data?.name ?? 'tool')}</span>`
  if (event.type === 'request/header') return `<span class="event-chip">${event.data?.header?.tools?.length ?? 0} tools</span>`
  if (event.type === 'assistant/chunks') return `<span class="event-chip">${event.data?.count ?? 0} chunks</span>`
  return '<span class="event-chip">event</span>'
}

// Child sessions whose creation falls inside this tool call's lifetime are
// almost certainly the subagents it spawned (workflow / subagent tools).
function spawnedSessionsFor(event) {
  const kids = state.session?.children ?? []
  if (!kids.length || event.type !== 'tool/call') return []
  const pair = state.callPairs.get(event.data?.callId)
  const start = event.time - 2000
  const end = (pair?.result?.time ?? event.time + 600000) + 2000
  return kids.filter(kid => kid.createdAt >= start && kid.createdAt <= end)
}

function spawnedSessionsHtml(event) {
  const spawned = spawnedSessionsFor(event)
  if (!spawned.length) return ''
  return `
    <section class="spawn-list">
      <div class="spawn-list-head">spawned sessions · ${spawned.length}</div>
      ${spawned.map(kid => `
        <button class="spawn-link" type="button" data-load-session="${escapeHtml(kid.id)}">
          <span class="spawn-mark">↳</span>
          <span class="spawn-title">${escapeHtml(truncate(kid.title || kid.id, 72))}</span>
          <span class="spawn-meta">${kid.stepCount} steps · ${kid.toolCallCount} tools</span>
        </button>
      `).join('')}
    </section>
  `
}

/* Inline row utilities: the trajectory is self-contained — copy, the raw event
   and annotations live in the expanded row instead of a side inspector. */

function rowPayload(row) {
  const event = row.event
  if (event.type === 'tool/call' || event.type === 'tool/result') {
    const pair = state.callPairs.get(event.data?.callId) ?? {}
    return { call: pair.call ?? null, result: pair.result ?? null }
  }
  if (event.type === 'assistant/chunks') return row.rawEvents
  return event
}

function rowToolsHtml(row) {
  const fb = feedbackFor(row.id)
  const annotateOpen = state.annotateOpenIds.has(row.id)
  const author = localStorage.getItem('dh-author') || 'shentuni'
  const rawDetails = row.event.type === 'assistant/chunks' ? '' : `
    <details class="metadata-line">
      <summary>raw event</summary>
      <pre>${escapeHtml(renderValue(row.rawEvents, 'jsonl'))}</pre>
    </details>
  `
  const fbList = fb.length ? `
    <div class="inline-fb-list">
      ${fb.map(item => `
        <article class="feedback-item">
          <header><strong>${escapeHtml(item.data.author)}</strong><time>${escapeHtml(dateTime(item.time))}</time></header>
          <p>${escapeHtml(item.data.text)}</p>
        </article>
      `).join('')}
    </div>
  ` : ''
  const fbForm = annotateOpen ? `
    <form class="inline-fb" data-fb-row="${escapeHtml(row.id)}">
      <textarea name="text" placeholder="输入标注内容" required></textarea>
      <div class="inline-fb-row">
        <input name="author" type="text" value="${escapeHtml(author)}" placeholder="标注人">
        <span class="fb-hint">针对 #${row.index} ${escapeHtml(row.event.type)}</span>
        <button class="fb-send" type="submit">提交标注</button>
      </div>
    </form>
  ` : ''
  return `
    <div class="row-tools">
      <button type="button" data-copy-row="${escapeHtml(row.id)}">Copy JSON</button>
      <button type="button" data-annotate-row="${escapeHtml(row.id)}">${annotateOpen ? '收起标注' : `标注${fb.length ? ` (${fb.length})` : ''}`}</button>
    </div>
    ${fbForm}${fbList}${rawDetails}
  `
}

const CHUNK_PREVIEW_LIMIT = 200

function renderTrajectoryBody(row) {
  const event = row.event
  const tools = rowToolsHtml(row)
  if (event.type === 'request/header') {
    const header = event.data?.header ?? {}
    return `
      <div class="traj-body">
        <section class="tool-call-card">
          <div class="tool-call-head">
            <strong>System prompt</strong>
            <span>${String(header.system ?? '').length} chars</span>
          </div>
          <pre>${escapeHtml(header.system || 'No system prompt recorded.')}</pre>
        </section>
        <section class="tool-call-card">
          <div class="tool-call-head">
            <strong>Tool schemas</strong>
            <span>${(header.tools ?? []).length} tools</span>
          </div>
          <pre>${escapeHtml(renderValue(header.tools ?? [], 'json'))}</pre>
        </section>
        <details class="metadata-line">
          <summary>config and messagePrefix</summary>
          <pre>${escapeHtml(renderValue({ config: header.config, messagePrefix: header.messagePrefix }, 'json'))}</pre>
        </details>
        ${tools}
      </div>
    `
  }
  if (event.type === 'assistant/chunks') {
    const chunks = event.data?.chunks ?? []
    const preview = chunks.slice(0, CHUNK_PREVIEW_LIMIT)
    return `
      <div class="traj-body">
        <details class="metadata-line">
          <summary>raw streaming chunks (${chunks.length})</summary>
          <pre>${escapeHtml(renderValue(preview, 'jsonl'))}</pre>
          ${chunks.length > CHUNK_PREVIEW_LIMIT ? `<div class="more-note">… ${chunks.length - CHUNK_PREVIEW_LIMIT} more chunks — use Copy JSON for the full stream</div>` : ''}
        </details>
        ${tools}
      </div>
    `
  }
  if (event.type === 'tool/call') {
    const pair = state.callPairs.get(event.data?.callId)
    const duration = pairedDurationSec(event)
    const failed = Boolean(pair?.result?.data?.isError)
    return `
      <div class="traj-body">
        <section class="tool-call-card ${failed ? 'error' : ''}">
          <div class="tool-call-head">
            <strong>${escapeHtml(event.data?.name ?? 'tool')}</strong>
            <span>${escapeHtml(event.data?.callId ?? '')}${duration ? ` · ${ms(duration)}` : ''}${failed ? ' · failed' : ''}</span>
          </div>
          <pre>${escapeHtml(renderValue(parseMaybeJson(event.data?.arguments), 'json'))}</pre>
        </section>
        ${spawnedSessionsHtml(event)}
        ${tools}
      </div>
    `
  }
  if (event.type === 'user/message') {
    return `<div class="traj-body"><div class="user-body">${escapeHtml(contentToText(event.data?.content))}</div>${tools}</div>`
  }
  if (event.type === 'tool/result') {
    const pair = state.callPairs.get(event.data?.callId)
    const duration = pairedDurationSec(event)
    const failed = Boolean(event.data?.isError)
    const name = pair?.call?.data?.name
    return `
      <div class="traj-body">
        <div class="tool-output-card ${failed ? 'error' : ''}">
          <div class="tool-output-head">${failed ? 'tool error' : 'tool result'}${name ? ` · ${escapeHtml(name)}` : ''} <span>${escapeHtml(event.data?.callId ?? '')}${duration ? ` · ${ms(duration)}` : ''}</span></div>
          ${event.data?.error ? `<pre class="error-text">${escapeHtml(renderValue(event.data.error, 'plain'))}</pre>` : ''}
          <pre>${escapeHtml(renderValue(event.data?.content ?? event.data, 'plain'))}</pre>
        </div>
        ${tools}
      </div>
    `
  }
  const blocks = contentBlocks(event.data?.content)
  const reasoning = blocks.filter(block => block.type === 'reasoning').map(block => block.text).filter(Boolean).join('\n\n')
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).filter(Boolean).join('\n\n')
  const calls = toolCallsFromContent(blocks)
  const usage = event.data?.usage
  return `
    <div class="traj-body">
      ${reasoning ? `
        <section class="thinking-card">
          <strong>Thinking</strong>
          <p>${escapeHtml(reasoning)}</p>
        </section>
      ` : ''}
      ${text ? `<p class="assistant-text">${escapeHtml(text)}</p>` : ''}
      ${calls.map(call => `
        <section class="tool-call-card">
          <div class="tool-call-head">
            <strong>${escapeHtml(call.name)}</strong>
            <span>${escapeHtml(call.id ?? '')}</span>
          </div>
          <pre>${escapeHtml(renderValue(parseMaybeJson(call.arguments), 'json'))}</pre>
        </section>
      `).join('')}
      ${usage ? `
        <details class="metadata-line">
          <summary>metadata ${escapeHtml(JSON.stringify(usage))}</summary>
          <pre>${escapeHtml(renderValue(usage, 'json'))}</pre>
        </details>
      ` : ''}
      ${tools}
    </div>
  `
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/* ── Chat ──────────────────────────────────────────────────────────────── */

function renderConversation() {
  const messages = state.session.messages.filter(message => message.role === 'user' || message.role === 'assistant')
  if (!messages.length) {
    $('#conversation').innerHTML = '<div class="empty-state">No surface messages in this session.</div>'
    return
  }
  $('#conversation').innerHTML = messages.map(message => `
    <article class="message ${escapeHtml(message.role)}" data-select-event-seq="${message.seq}">
      <div class="message-card">
        ${renderChatBody(message)}
      </div>
    </article>
  `).join('')
}

function renderChatBody(message) {
  const text = chatText(message)
  const blocks = contentBlocks(message.content)
  const reasoning = blocks.filter(block => block.type === 'reasoning').map(block => block.text).filter(Boolean).join('\n\n')
  const calls = toolCallsFromContent(message.content)
  const activity = [
    reasoning ? `
      <details class="chat-activity thinking">
        <summary><span>Thinking</span><strong>${escapeHtml(truncate(reasoning, 112))}</strong></summary>
        <div class="activity-body">${escapeHtml(reasoning)}</div>
      </details>
    ` : '',
    ...calls.map(call => renderChatToolActivity(call)),
  ].filter(Boolean).join('')
  if (message.role === 'user') return `<div class="user-bubble">${escapeHtml(text)}</div>`
  if (text) return `${activity ? `<div class="activity-list">${activity}</div>` : ''}<div class="assistant-prose">${renderMarkdown(text)}</div>`
  if (calls.length) {
    return `<div class="activity-list">${activity}</div>`
  }
  if (reasoning) return `<div class="activity-list">${activity}</div>`
  return '<div class="muted-text">No visible assistant text.</div>'
}

// A short human-readable hint of what the call did, for the collapsed summary
// row (lay users should understand a tool line without expanding it).
function toolCallPreview(call) {
  const args = parseMaybeJson(call.arguments)
  if (args && typeof args === 'object') {
    const preferred = args.description ?? args.command ?? args.file_path ?? args.path ?? args.name ?? args.url ?? args.query
    if (typeof preferred === 'string' && preferred) return truncate(preferred, 90)
    const firstString = Object.values(args).find(value => typeof value === 'string' && value)
    if (firstString) return truncate(firstString, 90)
  }
  return ''
}

function renderChatToolActivity(call) {
  const result = state.session.events.find(event => event.type === 'tool/result' && event.data?.callId === call.id)
  const failed = Boolean(result?.data?.isError)
  const resultText = result ? renderValue(result.data?.content ?? result.data, 'plain') : ''
  const preview = toolCallPreview(call)
  // .activity-body is white-space: pre-wrap (thinking bodies rely on it), so the
  // markup inside it must be emitted WITHOUT newlines/indentation between tags —
  // stray template whitespace would render as literal blank space.
  const inputHtml = `<div class="activity-section-title">Input</div><pre>${escapeHtml(renderValue(parseMaybeJson(call.arguments), 'json'))}</pre>`
  const outputHtml = result
    ? `<div class="activity-section-title">${failed ? 'Error output' : 'Output'}</div><pre>${escapeHtml(resultText)}</pre>`
    : ''
  const openBtn = `<button class="activity-open-inspector" type="button" data-inspect-call="${escapeHtml(call.id ?? '')}">在检查器中打开 →</button>`
  return `
    <details class="chat-activity tool-use ${failed ? 'failed' : ''}" data-call-id="${escapeHtml(call.id ?? '')}">
      <summary><span>${failed ? 'Tool failed' : 'Tool use'}</span><strong>${escapeHtml(call.name)}${preview ? `<span class="activity-preview"> · ${escapeHtml(preview)}</span>` : ''}</strong></summary>
      <div class="activity-body">${inputHtml}${outputHtml}${openBtn}</div>
    </details>
  `
}

function chatText(message) {
  if (message.role === 'user') return contentToText(message.content)
  return contentBlocks(message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .filter(Boolean)
    .join('\n\n')
}

/* ── Waterfall: find the hotspot, then jump to Trajectory for detail ─────── */

function renderWaterfall() {
  const total = Math.max(state.session?.stats.durationSec ?? 1, 0.001)
  const nodes = currentNodes().filter(node => node.kind !== 'session')
  const llmTime = nodes.filter(n => n.kind === 'llm').reduce((sum, n) => sum + n.durationSec, 0)
  const toolTime = nodes.filter(n => n.kind === 'tool').reduce((sum, n) => sum + n.durationSec, 0)
  const errors = nodes.filter(n => n.status === 'error')
  const slowest = nodes.filter(n => n.kind === 'step').sort((a, b) => b.durationSec - a.durationSec)[0]
  const summary = `
    <div class="wf-summary">
      <div class="wf-stat"><span>total</span><strong>${ms(state.session.stats.durationSec)}</strong></div>
      <div class="wf-stat"><span>llm time</span><strong>${ms(llmTime)}</strong></div>
      <div class="wf-stat"><span>tool time</span><strong>${ms(toolTime)}</strong></div>
      <div class="wf-stat ${errors.length ? 'error link' : ''}" ${errors.length ? `data-inspect-node="${escapeHtml(errors[0].id)}"` : ''}><span>errors</span><strong>${errors.length}</strong></div>
      ${slowest ? `<div class="wf-stat link" data-inspect-node="${escapeHtml(slowest.id)}"><span>slowest step</span><strong>${escapeHtml(slowest.title)} · ${ms(slowest.durationSec)}</strong></div>` : ''}
      <div class="wf-stat"><span>tokens in/out</span><strong>${sumTokens('input')}/${sumTokens('output')}</strong></div>
    </div>
  `
  const ticks = [0, .25, .5, .75, 1].map(p => `<span>${ms(total * p)}</span>`).join('')
  $('#waterfall').innerHTML = summary + `
    <div class="wf">
      <div class="wf-row wf-head-row">
        <div class="wf-label-col"></div>
        <div class="wf-axis">${ticks}</div>
      </div>
      ${nodes.map(node => {
        const left = Math.max(0, (node.startSec / total) * 100)
        const width = Math.max(.35, (node.durationSec / total) * 100)
        const error = node.status === 'error'
        return `
          <div class="wf-row">
            <button class="wf-label-col" type="button" data-inspect-node="${escapeHtml(node.id)}" style="--depth:${node.depth}" title="Inspect">
              <span class="wf-glyph ${node.kind} ${error ? 'error' : ''}">${nodeGlyph(node.kind)}</span>
              <span class="wf-name">${escapeHtml(node.title)}</span>
              <span class="wf-dur">${ms(node.durationSec)}</span>
            </button>
            <div class="wf-track">
              <button class="wf-bar ${node.kind} ${error ? 'error' : ''}" type="button" style="left:${left}%;width:${Math.min(width, 100 - left)}%" data-inspect-node="${escapeHtml(node.id)}" title="${escapeHtml(node.title)} · ${ms(node.durationSec)} @ ${fmtOffset(node.startSec)}"></button>
            </div>
          </div>
        `
      }).join('')}
    </div>
  `
}

function sumTokens(kind) {
  let total = 0
  for (const event of state.session.events) {
    if (event.type !== 'assistant/message') continue
    const usage = usageOfEvent(event)
    total += Number(usage[kind === 'input' ? 'input' : 'output']) || 0
  }
  return total.toLocaleString()
}

// Select a tree node (waterfall click) and open the inspector on it.
function selectNode(id) {
  state.selected = findNode(id)
  renderDetails()
  openInspector()
}

// Map a waterfall/tree node or a selected event to its trajectory anchor and
// navigate there.
function jumpToNode(nodeId) {
  let target = null
  if (nodeId.startsWith('event:') || nodeId.startsWith('chunks:')) {
    target = { rowId: nodeId }
  } else if (nodeId.startsWith('tool:')) {
    const callId = nodeId.slice('tool:'.length)
    const call = state.callPairs.get(callId)?.call
    if (call) target = { rowId: `event:${call.seq}` }
  } else if (nodeId.startsWith('assistant:')) {
    target = { rowId: `event:${nodeId.slice('assistant:'.length)}` }
  } else if (nodeId.startsWith('step:')) {
    const [turn, step] = nodeId.slice('step:'.length).split(':')
    target = { groupKey: `g:${turn}:${step}` }
  } else if (nodeId.startsWith('turn:')) {
    const turn = nodeId.slice('turn:'.length)
    const group = state.trajGroups.find(g => String(g.turn) === turn)
    if (group) target = { groupKey: group.key }
  }
  if (!target) return
  showMainView('trajectory')
  if (target.rowId) {
    const row = state.trajectoryRows.find(item => item.id === target.rowId)
    if (!row) return
    if (!state.expandedTrajectorySeqs.has(target.rowId)) {
      state.expandedTrajectorySeqs.add(target.rowId)
      rerenderTrajectoryRow(target.rowId)
    }
    flashAndScroll(`[data-select-trajectory-row="${CSS.escape(target.rowId)}"]`)
  } else if (target.groupKey) {
    flashAndScroll(`[data-group-anchor="${CSS.escape(target.groupKey)}"]`, 'start')
  }
}

function jumpToGroup(groupKey) {
  flashAndScroll(`[data-group-anchor="${CSS.escape(groupKey)}"]`, 'start')
  markActiveGroup(groupKey)
}

// Scroll-spy: as the trajectory table scrolls, highlight the step the reader is
// looking at in the tree (and keep it visible there).
function markActiveGroup(groupKey) {
  let activeStep = null
  $$('#trajTree .tree-step').forEach(el => {
    const on = el.dataset.jumpGroup === groupKey
    el.classList.toggle('active', on)
    if (on) activeStep = el
  })
  $$('#trajTree .tree-turn').forEach(turn => {
    turn.querySelector('.tree-turn-head')?.classList.toggle('active', Boolean(turn.querySelector('.tree-step.active')))
  })
  if (activeStep) {
    const tree = document.querySelector('#trajTree')
    const stepRect = activeStep.getBoundingClientRect()
    const treeRect = tree.getBoundingClientRect()
    if (stepRect.top < treeRect.top || stepRect.bottom > treeRect.bottom) {
      activeStep.scrollIntoView({ block: 'nearest' })
    }
  }
}

function updateScrollSpy() {
  const main = document.querySelector('.traj-main')
  if (!main) return
  const anchors = [...main.querySelectorAll('[data-group-anchor]')]
  if (!anchors.length) return
  const topEdge = main.getBoundingClientRect().top + 70
  let current = anchors[0]
  for (const anchor of anchors) {
    if (anchor.getBoundingClientRect().top <= topEdge) current = anchor
    else break
  }
  markActiveGroup(current.dataset.groupAnchor)
}

function initScrollSpy() {
  const main = document.querySelector('.traj-main')
  if (!main) return
  let ticking = false
  main.addEventListener('scroll', () => {
    if (ticking) return
    ticking = true
    requestAnimationFrame(() => {
      ticking = false
      updateScrollSpy()
    })
  })
}

// Instant scrolling: smooth scrolling is silently dropped during boot-time
// layout. Rows center (so the sticky group head never covers them); group
// heads go to 'start' — they stick at the top, which is also exactly where the
// scroll-spy samples, so the tree highlight agrees with the jump target.
function flashAndScroll(selector, block = 'center') {
  const el = document.querySelector(selector)
  if (!el) return
  el.scrollIntoView({ block })
  el.classList.remove('flash')
  void el.offsetWidth
  el.classList.add('flash')
}

/* ── Inspector payloads (chat only) ──────────────────────────────────────── */

function eventPayloadText(event) {
  return JSON.stringify(event?.data ?? event ?? {}, null, 0)
}

function eventPreview(event) {
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    return truncate(textOfEventContent(event), 220)
  }
  if (event.type === 'tool/call') return `${event.data?.name ?? 'tool'} ${truncate(event.data?.arguments ?? '', 180)}`
  if (event.type === 'tool/result') return truncate(textOfEventContent(event) || eventPayloadText(event), 220)
  if (event.type === 'request/header') {
    const tools = event.data?.header?.tools?.length ?? 0
    const model = event.data?.header?.config?.model ?? 'unknown model'
    return `${model}, ${tools} tools, full request envelope available`
  }
  return truncate(eventPayloadText(event), 220)
}

function textOfEventContent(event) {
  return contentToText(event?.data?.content)
}

function selectedPayloads() {
  const node = state.selected ?? state.session.tree
  if (node.kind === 'session') {
    return {
      input: {
        header: state.session.header,
        stats: state.session.stats,
        model: state.session.agent.model,
        tools: (state.session.agent.tools ?? []).map(tool => tool.name),
      },
      output: '',
      metadata: {
        id: node.id,
        kind: node.kind,
        title: node.title,
        subtitle: node.subtitle,
        durationSec: node.durationSec,
        events: `${state.session.events.length} events — select a message for detail`,
        children: state.session.children,
        parent: state.session.parent,
      },
    }
  }
  // Steps can own thousands of chunk events; cap what the metadata pane
  // serializes so selecting a node never stalls on a multi-MB JSON string.
  const nodeEvents = node.kind === 'event' ? node.rawEvents : eventsOf(node)
  const events = nodeEvents.length > 50
    ? { count: nodeEvents.length, first50: nodeEvents.slice(0, 50) }
    : nodeEvents
  return {
    input: node.detail?.input ?? nodeEvents.slice(0, 50),
    output: node.detail?.output ?? '',
    metadata: {
      id: node.id,
      kind: node.kind,
      title: node.title,
      subtitle: node.subtitle,
      status: node.status,
      durationSec: node.durationSec,
      startSec: node.startSec,
      events,
      prompt: resolvePrompt(node),
      schema: node.detail?.schema,
    },
  }
}

function renderDetails() {
  const node = state.selected ?? state.session.tree
  $('#detailIcon').textContent = nodeGlyph(node.kind)
  $('#detailTitle').textContent = node.title
  $('#detailSubtitle').textContent = `${node.kind} · ${node.subtitle ?? ''} · ${ms(node.durationSec)}`
  const jumpBtn = $('#jumpFromInspector')
  if (jumpBtn) jumpBtn.style.display = node.kind === 'session' ? 'none' : ''
  renderFeedback()
  const payloads = selectedPayloads()
  for (const [id, key] of Object.entries({
    inputText: 'input',
    outputText: 'output',
    metadataText: 'metadata',
  })) {
    const select = document.querySelector(`[data-format-target="${id}"]`)
    $(`#${id}`).textContent = renderValue(payloads[key], select?.value ?? 'json')
  }
  updateSelectionUI()
  syncUrl()
}

// Update chat selection highlighting in place — no view rebuilds.
function updateSelectionUI() {
  const selectedSeq = state.selected?.kind === 'event' ? state.selected.rawEvents?.[0]?.seq : undefined
  $$('#conversation .message').forEach(el => {
    el.classList.toggle('selected', Number(el.dataset.selectEventSeq) === selectedSeq)
  })
}

function currentTargetId() {
  return (state.selected ?? state.session.tree)?.id
}

function renderFeedback() {
  const feedback = feedbackFor(currentTargetId())
  $('#feedbackList').innerHTML = feedback.length
    ? feedback.map(item => `
      <article class="feedback-item">
        <header>
          <strong>${escapeHtml(item.data.author)}</strong>
          <time>${escapeHtml(dateTime(item.time))}</time>
        </header>
        <p>${escapeHtml(item.data.text)}</p>
      </article>
    `).join('')
    : '<div class="feedback-empty">暂无标注记录</div>'
}

function selectEvent(seq) {
  const event = state.seqMap.get(Number(seq)) ?? state.session.events.find(item => item.seq === Number(seq))
  if (!event) return
  let input = event.data
  let output = ''
  let durationSec = 0
  let status = 'ok'
  if (event.type === 'tool/call' || event.type === 'tool/result') {
    const pair = state.callPairs.get(event.data?.callId) ?? {}
    input = parseMaybeJson(pair.call?.data?.arguments ?? event.data?.arguments) ?? event.data
    output = pair.result
      ? { content: pair.result.data?.content, isError: pair.result.data?.isError, error: pair.result.data?.error, meta: pair.result.data?.meta }
      : ''
    durationSec = pairedDurationSec(pair.call ?? event)
    status = pair.result?.data?.isError ? 'error' : 'ok'
  } else if (event.type === 'assistant/message') {
    input = { usage: event.data?.usage, model: state.session.agent.model }
    output = event.data?.content
    const firstChunk = state.firstChunkByStep.get(`${event.data?.turn}:${event.data?.step}`)
    durationSec = firstChunk ? Math.max(0, (event.time - firstChunk) / 1000) : 0
  } else if (event.type === 'user/message') {
    input = ''
    output = event.data?.content
  }
  state.selected = {
    id: `event:${event.seq}`,
    kind: 'event',
    title: event.type,
    subtitle: `seq ${event.seq}`,
    startSec: (event.time - state.session.stats.startTime) / 1000,
    durationSec,
    status,
    rawEvents: [event],
    detail: { input, output, prompt: state.session.agent.latestHeader, schema: state.session.agent.tools },
  }
  renderDetails()
  openInspector()
}

function toggleTrajectoryRow(id) {
  if (state.expandedTrajectorySeqs.has(id)) state.expandedTrajectorySeqs.delete(id)
  else state.expandedTrajectorySeqs.add(id)
  rerenderTrajectoryRow(id)
}

function restoreSelection(id) {
  const view = new URLSearchParams(window.location.search).get('view')
  const row = state.trajectoryRows.find(item => item.id === id)
  if (row && view === 'trajectory') {
    state.expandedTrajectorySeqs.add(id)
    renderTrajectory()
    flashAndScroll(`[data-select-trajectory-row="${CSS.escape(id)}"]`)
    return
  }
  if (id.startsWith('event:')) {
    const seq = Number(id.slice('event:'.length))
    const message = state.session.messages.find(item => item.seq === seq)
    if (message) selectEvent(seq)
  }
}

async function submitInlineFeedback(form) {
  const rowId = form.dataset.fbRow
  const text = form.elements.text.value.trim()
  const author = form.elements.author.value.trim() || 'anonymous'
  if (!text) return
  localStorage.setItem('dh-author', author)
  const row = state.trajectoryRows.find(item => item.id === rowId)
  const result = await postJson(`/api/sessions/${encodeURIComponent(state.session.header.id)}/feedback`, {
    author,
    text,
    targetId: rowId,
    targetTitle: row ? `#${row.index} ${row.event.type}` : rowId,
    targetKind: 'event',
  })
  if (result.feedback) {
    state.session.feedback = [...(state.session.feedback ?? []), result.feedback]
    rerenderTrajectoryRow(rowId)
    toast('标注已保存')
  } else {
    toast(result.error ?? '标注保存失败')
  }
}

/* ── Event wiring ────────────────────────────────────────────────────────── */

document.addEventListener('click', async (event) => {
  const loadLink = event.target.closest('[data-load-session]')
  if (loadLink) {
    await loadSession(loadLink.dataset.loadSession)
    return
  }

  const sessionRow = event.target.closest('[data-select-session]')
  if (sessionRow) {
    await loadSession(sessionRow.dataset.selectSession)
    return
  }

  const copyRow = event.target.closest('[data-copy-row]')
  if (copyRow) {
    const row = state.trajectoryRows.find(item => item.id === copyRow.dataset.copyRow)
    if (row) {
      await navigator.clipboard.writeText(JSON.stringify(rowPayload(row), null, 2))
      toast('Copied')
    }
    return
  }

  const annotateRow = event.target.closest('[data-annotate-row]')
  if (annotateRow) {
    const id = annotateRow.dataset.annotateRow
    if (state.annotateOpenIds.has(id)) state.annotateOpenIds.delete(id)
    else state.annotateOpenIds.add(id)
    rerenderTrajectoryRow(id)
    return
  }

  const inspectNode = event.target.closest('[data-inspect-node]')
  if (inspectNode) {
    selectNode(inspectNode.dataset.inspectNode)
    return
  }

  const jumpNode = event.target.closest('[data-jump-node]')
  if (jumpNode) {
    jumpToNode(jumpNode.dataset.jumpNode)
    return
  }

  const jumpGroup = event.target.closest('[data-jump-group]')
  if (jumpGroup) {
    jumpToGroup(jumpGroup.dataset.jumpGroup)
    return
  }

  if (event.target.closest('#jumpFromInspector')) {
    if (state.selected && state.selected.kind !== 'session') jumpToNode(state.selected.id)
    return
  }

  // One click, one behavior in chat: a summary toggles its <details>, a link
  // navigates, and any OTHER click inside a message opens the inspector — on
  // the tool call when inside its expanded body, else on the message. A click
  // that ends a text selection does nothing (copying stays safe).
  const inspectCall = event.target.closest('[data-inspect-call]')
  if (inspectCall) {
    const pair = state.callPairs.get(inspectCall.dataset.inspectCall)
    if (pair?.call) selectEvent(pair.call.seq)
    return
  }

  if (event.target.closest('#conversation summary') || event.target.closest('#conversation a')) {
    return
  }

  const activityBody = event.target.closest('#conversation .activity-body')
  if (activityBody) {
    if (window.getSelection()?.toString()) return
    const callId = activityBody.closest('[data-call-id]')?.dataset.callId
    const pair = state.callPairs.get(callId)
    if (pair?.call) selectEvent(pair.call.seq)
    return
  }

  // Expanded trajectory bodies and their <details> handle their own clicks;
  // chat messages are NOT guarded — any click inside a message selects it.
  if (event.target.closest('.traj-row') && (event.target.closest('details') || event.target.closest('.traj-body'))) {
    return
  }

  const trajectoryToggle = event.target.closest('[data-toggle-trajectory]')
  if (trajectoryToggle) {
    toggleTrajectoryRow(trajectoryToggle.dataset.toggleTrajectory)
    return
  }

  const eventNode = event.target.closest('[data-select-event-seq]')
  if (eventNode) {
    if (window.getSelection()?.toString()) return
    selectEvent(eventNode.dataset.selectEventSeq)
    return
  }

  const mainView = event.target.closest('[data-main-view]')
  if (mainView) {
    showMainView(mainView.dataset.mainView)
    return
  }

  const tab = event.target.closest('[data-detail-tab]')
  if (tab) {
    state.activeDetailTab = tab.dataset.detailTab
    $$('[data-detail-tab]').forEach(button => button.classList.toggle('active', button === tab))
    $$('.detail-panel').forEach(panel => panel.classList.remove('active'))
    $(`#${state.activeDetailTab}Panel`).classList.add('active')
    return
  }

  if (event.target.closest('#expandAllTrajectory')) {
    state.expandedTrajectorySeqs = new Set(state.trajectoryRows.map(item => item.id))
    renderTrajectory()
    return
  }

  if (event.target.closest('#collapseTrajectory')) {
    state.expandedTrajectorySeqs = new Set()
    renderTrajectory()
    return
  }

  if (event.target.closest('#inspectorClose')) {
    closeInspector()
    return
  }

  if (event.target.closest('#newSessionButton')) {
    const result = await postJson('/api/sessions', {})
    toast(result.error ?? 'New session created')
    return
  }
})

document.addEventListener('submit', (event) => {
  const form = event.target.closest('.inline-fb')
  if (form) {
    event.preventDefault()
    submitInlineFeedback(form)
  }
})

document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('.traj-summary')) {
    event.preventDefault()
    toggleTrajectoryRow(event.target.dataset.toggleTrajectory)
    return
  }
  if (event.key === 'Escape' && state.inspectorOpen) {
    closeInspector()
  }
})

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-format-target]')) renderDetails()
})

$('#sessionSearch')?.addEventListener('input', (event) => {
  state.sessionQuery = event.target.value
  renderSessionList()
})

$('#feedbackForm')?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = $('#feedbackText').value.trim()
  if (!text) return
  const target = state.selected ?? state.session.tree
  const result = await postJson(`/api/sessions/${encodeURIComponent(state.session.header.id)}/feedback`, {
    author: $('#feedbackAuthor').value,
    text,
    targetId: target.id,
    targetTitle: target.title,
    targetKind: target.kind,
  })
  if (result.feedback) {
    state.session.feedback = [...(state.session.feedback ?? []), result.feedback]
    $('#feedbackText').value = ''
    renderFeedback()
    toast('Feedback saved')
  } else {
    toast(result.error ?? 'Failed to save feedback')
  }
})

$('#feedbackText')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.altKey && !event.shiftKey && !event.metaKey) {
    event.preventDefault()
    $('#feedbackForm').requestSubmit()
  }
})

$('#feedbackAuthor')?.addEventListener('input', (event) => {
  localStorage.setItem('dh-author', event.target.value.trim() || 'anonymous')
})

/* Pane resizers: shell left divider + chat's inner inspector divider. Widths
   are clamped so no pane can crush the others and persist across reloads. */
const PANE_WIDTH_KEY = 'dh-pane-widths'

function initPaneResizers() {
  const shell = document.querySelector('.shell')
  const chatSplit = document.querySelector('#chatSplit')
  const wfSplit = document.querySelector('#wfSplit')
  if (!shell) return
  let saved = {}
  try {
    saved = JSON.parse(localStorage.getItem(PANE_WIDTH_KEY) ?? '{}')
  } catch {
    // Corrupt localStorage entry: fall back to defaults; next drag rewrites it.
  }
  // The inspector width is shared between the chat and waterfall splits.
  const setInspectorWidth = (width) => {
    chatSplit?.style.setProperty('--inspector-w', `${width}px`)
    wfSplit?.style.setProperty('--inspector-w', `${width}px`)
  }
  if (saved.left) shell.style.setProperty('--left-w', `${saved.left}px`)
  if (saved.inspector) setInspectorWidth(saved.inspector)

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))
  const persist = () => {
    localStorage.setItem(PANE_WIDTH_KEY, JSON.stringify({
      left: parseInt(shell.style.getPropertyValue('--left-w')) || undefined,
      inspector: parseInt(chatSplit?.style.getPropertyValue('--inspector-w')) || undefined,
    }))
  }

  const attach = (divider, apply) => {
    if (!divider) return
    divider.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      divider.classList.add('dragging')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const move = (ev) => apply(ev)
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        divider.classList.remove('dragging')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        persist()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    })
  }

  attach($('#dividerLeft'), (ev) => {
    const rect = shell.getBoundingClientRect()
    const width = clamp(ev.clientX - rect.left - 12, 220, Math.min(480, rect.width * 0.4))
    shell.style.setProperty('--left-w', `${width}px`)
  })
  attach($('#dividerInspector'), (ev) => {
    if (!chatSplit) return
    const rect = chatSplit.getBoundingClientRect()
    setInspectorWidth(clamp(rect.right - ev.clientX - 4, 300, Math.min(640, rect.width * 0.6)))
  })
  attach($('#dividerWfInspector'), (ev) => {
    if (!wfSplit) return
    const rect = wfSplit.getBoundingClientRect()
    setInspectorWidth(clamp(rect.right - ev.clientX - 4, 300, Math.min(640, rect.width * 0.6)))
  })
}

initPaneResizers()
initScrollSpy()
const bootParams = new URLSearchParams(window.location.search)
loadSessions(bootParams.get('session') || undefined)
  .then(() => {
    const sel = bootParams.get('sel')
    if (sel && state.session) restoreSelection(sel)
  })
  .catch((error) => {
    const hint = backendOpenHint(error)
    $('#sourceLine').textContent = `Backend failed from ${window.location.href}`
    $('#sessionList').innerHTML = hint
    $('.main-pane').innerHTML = hint
  })
