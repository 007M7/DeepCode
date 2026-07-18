import {
  DEFAULT_FEEDBACK_AUTHOR,
  INSPECTOR_TABS,
  createInspectorTargetId,
  defaultInspectorTabForTarget,
  type DesktopSurface,
  type InspectorTab,
  type InspectorTarget,
} from './index.ts'
import { translate, type I18nKey, type Locale } from './i18n.ts'
import './styles.css'

interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly cwd?: string
  readonly relativePath?: string
  readonly createdAt: number
  readonly lastActivity: number
  readonly eventCount: number
  readonly turnCount: number
  readonly stepCount: number
  readonly toolCallCount: number
  readonly model?: string
  readonly live?: boolean
}

interface SessionEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: Record<string, unknown>
  readonly sourceEventSeqs?: number[]
  readonly surfaceOp?: unknown
}

interface TracePayload {
  readonly found: boolean
  readonly sessionId: string
  readonly header: Record<string, unknown>
  readonly events: SessionEvent[]
  readonly rawText: string
  readonly path?: string
  readonly relativePath?: string
  readonly feedback?: FeedbackRecord[]
}

interface FeedbackRecord {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly sessionId: string
    readonly targetId: string
    readonly targetTitle: string
    readonly targetKind: string
    readonly author: string
    readonly text: string
  }
}

interface SessionUpdatePayload {
  readonly sessionId: string
  readonly update: Record<string, unknown>
}

interface ChatRow {
  readonly target: InspectorTarget
  readonly role: 'user' | 'assistant' | 'thinking' | 'tool' | 'context' | 'system'
  readonly title: string
  readonly body: string
  readonly eventSeqs: readonly number[]
  readonly collapsed?: boolean
  readonly badge?: string
}

interface TreeRow {
  readonly target: InspectorTarget
  readonly depth: number
  readonly kind: 'session' | 'turn' | 'step' | 'request' | 'message' | 'thinking' | 'tool' | 'context' | 'error'
  readonly title: string
  readonly subtitle: string
  readonly meta: string
  readonly tone?: 'blue' | 'green' | 'amber' | 'red'
}

interface SpanRow {
  readonly target: InspectorTarget
  readonly title: string
  readonly subtitle: string
  readonly startMs: number
  readonly durationMs: number
  readonly tone?: 'blue' | 'green' | 'amber' | 'red'
}

interface ContextRow {
  readonly target: InspectorTarget
  readonly title: string
  readonly subtitle: string
  readonly preview: string
  readonly kind: 'system' | 'tools' | 'messages' | 'config' | 'raw'
  readonly changed?: boolean
}

interface TargetPayload {
  readonly input: unknown
  readonly output: unknown
  readonly metadata: unknown
}

interface RequestContextSnapshot {
  readonly event?: SessionEvent
  readonly seq: number
  readonly header: Record<string, unknown>
  readonly delta: Record<string, unknown>
  readonly system: string
  readonly tools: unknown[]
  readonly config: unknown
  readonly messagePrefix: unknown
}

interface DevArtifact {
  readonly id: string
  readonly group: 'Prompts' | 'Tools' | 'Plugins / Context Providers' | 'Config / Runtime' | 'Change Loop'
  readonly title: string
  readonly subtitle: string
  readonly kind: 'prompt' | 'tool' | 'plugin' | 'config' | 'runtime' | 'change'
  readonly status?: string
  readonly source?: string
  readonly owner?: string
  readonly value?: unknown
  readonly metadata?: unknown
  readonly recent?: string
}

interface DevArtifactGroup {
  readonly title: DevArtifact['group']
  readonly artifacts: DevArtifact[]
}

type AppModule = 'sessions' | 'develop'

const SESSION_SURFACES: readonly DesktopSurface[] = ['chat', 'trajectory', 'waterfall']
const initialLocale = (localStorage.getItem('dsh.locale') === 'en-US' ? 'en-US' : 'zh-CN') as Locale

const state = {
  runtime: undefined as unknown,
  dev: undefined as unknown,
  sessions: [] as SessionSummary[],
  selectedSessionId: undefined as string | undefined,
  trace: undefined as TracePayload | undefined,
  activeModule: 'sessions' as AppModule,
  activeSurface: 'chat' as DesktopSurface,
  locale: initialLocale,
  activeDevArtifactId: undefined as string | undefined,
  selectedTarget: undefined as InspectorTarget | undefined,
  activeInspectorTab: 'input' as InspectorTab,
  busy: false,
  error: '',
  stderr: '',
  query: '',
  draftChat: false,
  liveRows: new Map<string, ChatRow[]>(),
  pendingAssistant: new Map<string, string>(),
  pendingThinking: new Map<string, string>(),
}

function t(key: I18nKey): string {
  return translate(state.locale, key)
}

const appEl = document.querySelector<HTMLDivElement>('#app')

void boot()

async function boot(): Promise<void> {
  if (!hasDesktopApi()) {
    state.error = 'Desktop API is not available. Open the Electron window with: pnpm --dir packages/ui/desktop run dev.'
    render()
    return
  }

  window.dshDesktop.runtime.onStatus(payload => {
    state.runtime = payload
    render()
  })
  window.dshDesktop.runtime.onStderr(payload => {
    state.stderr = String(asRecord(payload).tail ?? asRecord(payload).text ?? '')
    render()
  })
  window.dshDesktop.sessions.onUpdate(payload => {
    handleSessionUpdate(asSessionUpdate(payload))
  })

  await Promise.all([refreshRuntime(), refreshDevStatus(), refreshSessions()])
}

async function refreshRuntime(): Promise<void> {
  if (!hasDesktopApi()) return
  try {
    state.runtime = await window.dshDesktop.runtime.status()
  } catch (error) {
    state.error = String(error)
  }
  render()
}

async function refreshDevStatus(): Promise<void> {
  if (!hasDesktopApi()) return
  try {
    state.dev = await window.dshDesktop.dev.status()
  } catch {
    state.dev = undefined
  }
}

async function refreshSessions(preferredId?: string): Promise<void> {
  if (!hasDesktopApi()) return
  try {
    const result = asRecord(await window.dshDesktop.sessions.list())
    state.sessions = Array.isArray(result.sessions) ? result.sessions as SessionSummary[] : []
    state.selectedSessionId = preferredId ?? state.selectedSessionId ?? state.sessions[0]?.id
    if (state.selectedSessionId !== undefined) await loadTrace(state.selectedSessionId, false)
  } catch (error) {
    state.error = String(error)
  }
  render()
}

async function loadTrace(sessionId: string, rerender = true): Promise<void> {
  state.selectedSessionId = sessionId
  state.selectedTarget = undefined
  if (!hasDesktopApi()) return
  try {
    state.trace = asRecord(await window.dshDesktop.trace.read(sessionId)) as unknown as TracePayload
  } catch (error) {
    state.trace = { found: false, sessionId, header: { id: sessionId }, events: [], rawText: '', feedback: [] }
    state.error = String(error)
  }
  if (rerender) render()
}

function handleSessionUpdate(payload: SessionUpdatePayload): void {
  const update = payload.update
  const rows = state.liveRows.get(payload.sessionId) ?? []
  const kind = String(update.sessionUpdate ?? '')

  if (kind === 'agent_message_chunk') {
    const text = contentText(update.content)
    state.pendingAssistant.set(payload.sessionId, `${state.pendingAssistant.get(payload.sessionId) ?? ''}${text}`)
  } else if (kind === 'agent_thought_chunk') {
    const text = contentText(update.content)
    state.pendingThinking.set(payload.sessionId, `${state.pendingThinking.get(payload.sessionId) ?? ''}${text}`)
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    const toolCallId = String(update.toolCallId ?? `tool-${rows.length}`)
    const existing = rows.findIndex(row => row.target.id.endsWith(`synthetic:${toolCallId}`))
    const row = makeSyntheticRow(payload.sessionId, 'tool', String(update.title ?? 'Tool use'), renderValue(update), toolCallId, true)
    if (existing >= 0) rows.splice(existing, 1, row)
    else rows.push(row)
    state.liveRows.set(payload.sessionId, rows)
  } else if (kind === 'user_message_chunk') {
    rows.push(makeSyntheticRow(payload.sessionId, 'user', 'User', contentText(update.content), `user-${rows.length}`))
    state.liveRows.set(payload.sessionId, rows)
  }

  render()
}

function render(): void {
  if (appEl === null) return
  const session = currentSession()
  appEl.innerHTML = `
    <div class="harness-shell ${state.selectedTarget === undefined ? '' : 'inspector-open'}">
      ${renderSidebar()}
      <main class="harness-main">
        ${renderTopbar(session)}
        ${renderMainContent(session)}
        ${renderBottomArea(session)}
      </main>
      ${state.selectedTarget === undefined ? '' : renderInspector()}
    </div>
  `
  syncSelectionAfterRender()
}

function renderSidebar(): string {
  const sessions = filteredSessions()
  return `
    <aside class="source-list">
      <div class="traffic-lights" aria-hidden="true">
        <span class="red"></span><span class="yellow"></span><span class="green"></span>
      </div>

      <header class="app-brand">
        <button class="brand-title" data-module="sessions">Deepseek Harness</button>
        <span class="runtime-dot ${runtimeStateClass()}"></span>
      </header>

      <section class="primary-actions">
        <button class="primary-action" data-action="new-session" ${hasDesktopApi() ? '' : 'disabled'}>
          <span>${escapeHtml(t('app.newChat'))}</span>
          <kbd>⌘N</kbd>
        </button>
      </section>

      <nav class="product-nav" aria-label="Deepseek Harness modules">
        ${renderModuleButton('sessions', t('app.sessions'), t('app.sessionsSubtitle'))}
        ${renderModuleButton('develop', t('app.develop'), t('app.developSubtitle'))}
      </nav>

      <label class="session-search">
        <span>${escapeHtml(t('app.sessions'))}</span>
        <input data-search="true" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(t('app.searchPlaceholder'))}" />
      </label>

      ${renderSessionGroup(t('app.recentSessions'), sessions.slice(0, 22))}

      <footer class="source-footer">
        <span>${escapeHtml(shortPath(runtimeRepoRoot()))}</span>
        <strong>${escapeHtml(runtimeLabel())}</strong>
      </footer>
    </aside>
  `
}

function renderModuleButton(module: AppModule, title: string, subtitle: string): string {
  return `
    <button class="module-button ${state.activeModule === module ? 'selected' : ''}" data-module="${module}">
      <span>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(subtitle)}</small>
      </span>
    </button>
  `
}

function renderSessionGroup(title: string, sessions: SessionSummary[]): string {
  return `
    <section class="session-group">
      <div class="group-title">${escapeHtml(title)}</div>
      <div class="session-list">
        ${sessions.map(renderSessionItem).join('') || `<div class="empty-list">No ${escapeHtml(title.toLowerCase())} sessions</div>`}
      </div>
    </section>
  `
}

function renderSessionItem(session: SessionSummary): string {
  const age = formatRelativeTime(session.lastActivity)
  return `
    <button class="session-item ${session.id === state.selectedSessionId ? 'selected' : ''}" data-session="${escapeHtml(session.id)}">
      <span class="session-glyph">${session.live ? '●' : '○'}</span>
      <span class="session-copy">
        <strong>${escapeHtml(session.title || shortId(session.id))}</strong>
        <small>${session.turnCount} turns · ${session.toolCallCount} tools · ${escapeHtml(age)}</small>
      </span>
    </button>
  `
}

function renderTopbar(session: SessionSummary | undefined): string {
  if (state.activeModule === 'sessions' && state.activeSurface === 'chat') {
    return `
      <header class="topbar chat-topbar">
        <div class="title-area">
          <h1>${escapeHtml(topbarTitle(session))}</h1>
        </div>
        ${renderSurfaceSwitcher()}
        <div class="toolbar-actions">${renderLanguageToggle()}</div>
      </header>
    `
  }
  return `
    <header class="topbar">
      <div class="title-area">
        <div class="crumb">Deepseek Harness / ${escapeHtml(moduleTitle())}</div>
        <h1>${escapeHtml(topbarTitle(session))}</h1>
      </div>
      ${state.activeModule === 'sessions' ? renderSurfaceSwitcher() : ''}
      <div class="toolbar-actions">${renderLanguageToggle()}</div>
    </header>
  `
}

function renderLanguageToggle(): string {
  return `<button class="language-toggle" data-action="toggle-locale" type="button">${escapeHtml(t('app.language'))}</button>`
}

function renderSurfaceSwitcher(): string {
  return `
    <nav class="surface-switcher" aria-label="Session surfaces">
      ${SESSION_SURFACES.map(surface => `
        <button class="${state.activeSurface === surface ? 'active' : ''}" data-surface="${surface}">
          ${escapeHtml(surfaceLabel(surface))}
        </button>
      `).join('')}
    </nav>
  `
}

function renderMainContent(session: SessionSummary | undefined): string {
  if (state.activeModule === 'develop') return renderDevelopModule()

  if (session === undefined) return state.draftChat ? renderDraftChat() : renderEmptySession()
  return `
    <section class="session-canvas">
      ${state.error ? `<div class="notice"><strong>Error</strong><span>${escapeHtml(state.error)}</span></div>` : ''}
      ${state.activeSurface === 'chat' ? '' : renderSessionHeader(session)}
      ${renderActiveSurface()}
    </section>
  `
}

function renderSessionHeader(session: SessionSummary): string {
  const trace = state.trace
  return `
    <section class="run-strip">
      <button class="run-identity ${selectedClass(makeTarget('session', `Session ${session.id}`, 0, trace?.relativePath ?? 'session'))}" data-target="${makeTarget('session', `Session ${session.id}`, 0, trace?.relativePath ?? 'session').id}">
        <strong>${escapeHtml(shortId(session.id))}</strong>
        <span>${escapeHtml(trace?.relativePath ?? session.relativePath ?? 'live ACP session')}</span>
      </button>
      <div class="run-metrics">
        ${renderMetric('Turns', session.turnCount)}
        ${renderMetric('Steps', session.stepCount)}
        ${renderMetric('Tools', session.toolCallCount)}
        ${renderMetric('Events', session.eventCount)}
      </div>
    </section>
  `
}

function renderMetric(label: string, value: number): string {
  return `<span><strong>${value}</strong><small>${escapeHtml(label)}</small></span>`
}

function renderActiveSurface(): string {
  if (state.activeSurface === 'trajectory') return renderTrajectorySurface()
  if (state.activeSurface === 'waterfall') return renderWaterfallSurface()
  return renderChatSurface()
}

function renderChatSurface(): string {
  const rows = chatRows()
  return `
    <section class="surface chat-surface">
      ${rows.map(renderChatRow).join('') || renderEmptyConversation()}
    </section>
  `
}

function renderChatRow(row: ChatRow): string {
  if (row.role === 'user') {
    return `
      <article class="chat-row user-row ${selectedClass(row.target)}">
        <span class="message-bubble">
          ${renderMarkdown(row.body)}
        </span>
        <button class="message-details" data-target="${row.target.id}" type="button">${escapeHtml(t('chat.details'))}</button>
      </article>
    `
  }
  if (row.role === 'assistant') {
    return `
      <article class="chat-row assistant-row ${selectedClass(row.target)}">
        <span class="assistant-message">${renderMarkdown(row.body)}</span>
        <button class="message-details" data-target="${row.target.id}" type="button">${escapeHtml(t('chat.details'))}</button>
      </article>
    `
  }
  return `
    <details class="fold-row ${row.role} ${selectedClass(row.target)}" ${row.collapsed ? '' : 'open'}>
      <summary>
        <span class="fold-kind">${escapeHtml(row.title)}</span>
        <span class="fold-preview">${escapeHtml(truncate(row.body, 150))}</span>
      </summary>
      <div class="fold-body">
        ${renderFoldBody(row)}
      </div>
    </details>
  `
}

function renderFoldBody(row: ChatRow): string {
  if (row.role === 'tool') {
    const payload = parseMaybeJson(row.body)
    const record = asRecord(payload)
    const hasStructured = record.input !== undefined || record.output !== undefined || record.error !== undefined
    if (hasStructured) {
      return `
        ${renderActivitySection(t('chat.input'), record.input ?? record.arguments ?? record.rawInput ?? {})}
        ${record.error !== undefined ? renderActivitySection(t('chat.errorOutput'), record.error) : ''}
        ${record.output !== undefined ? renderActivitySection(t('chat.output'), record.output) : ''}
        <button class="fold-inspect" data-target="${row.target.id}" type="button">${escapeHtml(t('chat.details'))}</button>
      `
    }
  }
  return `
    <button class="fold-inspect" data-target="${row.target.id}" type="button">${escapeHtml(t('chat.details'))}</button>
    <pre>${escapeHtml(row.body)}</pre>
  `
}

function renderActivitySection(title: string, value: unknown): string {
  return `
    <section class="activity-section">
      <strong>${escapeHtml(title)}</strong>
      <pre>${escapeHtml(formatDevValue(value))}</pre>
    </section>
  `
}

function renderTrajectorySurface(): string {
  const rows = trajectoryRows()
  return `
    <section class="surface trace-surface">
      <header class="surface-intro">
        <strong>${escapeHtml(t('trace.title'))}</strong>
        <span>${escapeHtml(t('trace.body'))}</span>
      </header>
      <div class="tree-view">
        ${rows.map(renderTreeRow).join('') || renderEmptyTrace()}
      </div>
    </section>
  `
}

function renderTreeRow(row: TreeRow): string {
  const detail = renderTrajectoryInlineDetail(row)
  if (detail.length > 0) {
    return `
      <details class="tree-item">
        <summary class="tree-row depth-${row.depth} ${row.tone ?? ''} ${selectedClass(row.target)}">
          <span class="tree-rail"></span>
          <span class="tree-kind">${escapeHtml(row.kind)}</span>
          <span class="tree-copy">
            <strong>${escapeHtml(row.title)}</strong>
            <small>${escapeHtml(row.subtitle)}</small>
          </span>
          <em>${escapeHtml(row.meta)}</em>
        </summary>
        <div class="traj-body">
          ${detail}
          <button class="fold-inspect" data-target="${row.target.id}" type="button">${escapeHtml(t('chat.details'))}</button>
        </div>
      </details>
    `
  }
  return `
    <button class="tree-row depth-${row.depth} ${row.tone ?? ''} ${selectedClass(row.target)}" data-target="${row.target.id}">
      <span class="tree-rail"></span>
      <span class="tree-kind">${escapeHtml(row.kind)}</span>
      <span class="tree-copy">
        <strong>${escapeHtml(row.title)}</strong>
        <small>${escapeHtml(row.subtitle)}</small>
      </span>
      <em>${escapeHtml(row.meta)}</em>
    </button>
  `
}

function renderTrajectoryInlineDetail(row: TreeRow): string {
  const seq = targetSeq(row.target)
  const event = (state.trace?.events ?? []).find(candidate => candidate.seq === seq)
  if (event === undefined) return ''
  const data = asRecord(event.data)
  if (event.type === 'request/header' || event.type === 'request/header-delta') {
    const header = asRecord(data.header)
    const delta = event.type === 'request/header-delta' ? data : {}
    const system = String(header.system ?? delta.system ?? '')
    const tools = header.tools ?? delta.tools ?? []
    return `
      ${renderTrajectoryCard(t('trace.systemPrompt'), `${system.length} chars`, system || t('trace.noSystem'))}
      ${renderTrajectoryCard(t('trace.toolSchemas'), `${Array.isArray(tools) ? tools.length : 0} tools`, tools)}
      <details class="metadata-line">
        <summary>${escapeHtml(t('trace.configPrefix'))}</summary>
        <pre>${escapeHtml(formatDevValue({ config: header.config ?? delta.config, messagePrefix: header.messagePrefix ?? delta.messagePrefix }))}</pre>
      </details>
    `
  }
  if (event.type === 'tool/call') {
    const callId = String(data.callId ?? '')
    const result = (state.trace?.events ?? []).find(candidate => candidate.type === 'tool/result' && asRecord(candidate.data).callId === callId)
    return `
      ${renderTrajectoryCard(String(data.name ?? 'tool'), callId, data.arguments ?? data.rawInput ?? data)}
      ${result === undefined ? '' : renderTrajectoryCard(asRecord(result.data).isError ? t('chat.errorOutput') : t('chat.output'), callId, asRecord(result.data).content ?? result.data)}
    `
  }
  if (event.type === 'tool/result') {
    return renderTrajectoryCard(asRecord(data).isError ? t('chat.errorOutput') : t('chat.output'), String(data.callId ?? ''), data.content ?? data)
  }
  return ''
}

function renderTrajectoryCard(title: string, meta: string, value: unknown): string {
  return `
    <section class="traj-card">
      <header><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></header>
      <pre>${escapeHtml(formatDevValue(value))}</pre>
    </section>
  `
}

function renderWaterfallSurface(): string {
  const spans = waterfallRows()
  const total = Math.max(1, ...spans.map(span => span.startMs + span.durationMs))
  return `
    <section class="surface waterfall-surface">
      <header class="surface-intro">
        <strong>${escapeHtml(t('waterfall.title'))}</strong>
        <span>${escapeHtml(t('waterfall.body'))}</span>
      </header>
      ${renderWaterfallSummary(spans, total)}
      <div class="waterfall">
        ${spans.map(span => renderSpanRow(span, total)).join('') || renderEmptyTrace()}
      </div>
    </section>
  `
}

function renderWaterfallSummary(spans: SpanRow[], total: number): string {
  const events = state.trace?.events ?? []
  const slowest = [...spans].sort((a, b) => b.durationMs - a.durationMs)[0]
  return `
    <section class="wf-summary">
      ${renderWfStat(t('waterfall.total'), formatMs(total))}
      ${renderWfStat(t('waterfall.turns'), String(uniqueTurns().length))}
      ${renderWfStat(t('waterfall.steps'), String(events.filter(event => event.type === 'step/start').length))}
      ${renderWfStat(t('waterfall.tools'), String(events.filter(event => event.type === 'tool/call').length))}
      ${renderWfStat(t('waterfall.errors'), String(events.filter(event => event.type === 'tool/result' && asRecord(event.data).isError).length))}
      ${renderWfStat(t('waterfall.slowest'), slowest === undefined ? '-' : `${slowest.title} · ${formatMs(slowest.durationMs)}`)}
    </section>
  `
}

function renderWfStat(labelText: string, value: string): string {
  return `<div class="wf-stat"><span>${escapeHtml(labelText)}</span><strong>${escapeHtml(value)}</strong></div>`
}

function renderSpanRow(span: SpanRow, total: number): string {
  const left = (span.startMs / total) * 100
  const width = Math.max(1.5, (span.durationMs / total) * 100)
  return `
    <button class="span-row ${span.tone ?? ''} ${selectedClass(span.target)}" data-target="${span.target.id}">
      <span class="span-title">
        <strong>${escapeHtml(span.title)}</strong>
        <small>${escapeHtml(span.subtitle)}</small>
      </span>
      <span class="span-track">
        <span style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span>
      </span>
      <em>${escapeHtml(formatMs(span.durationMs))}</em>
    </button>
  `
}

function renderContextSurface(): string {
  const rows = contextRows()
  return `
    <section class="surface context-surface">
      <header class="surface-intro">
        <strong>Context</strong>
        <span>这是开发分析视图：它解释模型请求边界里真正进入上下文的内容，用来改 prompt、tool schema 和 config。</span>
      </header>
      <div class="context-grid">
        ${rows.map(renderContextCard).join('') || renderEmptyTrace()}
      </div>
    </section>
  `
}

function renderContextCard(row: ContextRow): string {
  return `
    <button class="context-card ${row.kind} ${selectedClass(row.target)}" data-target="${row.target.id}">
      <span class="context-card-head">
        <strong>${escapeHtml(row.title)}</strong>
        <em>${escapeHtml(row.subtitle)}${row.changed ? ' · changed' : ''}</em>
      </span>
      <span class="context-preview">${escapeHtml(row.preview)}</span>
    </button>
  `
}

function renderDevelopModule(): string {
  const groups = developArtifactGroups()
  const artifacts = groups.flatMap(group => group.artifacts)
  const selected = artifacts.find(artifact => artifact.id === state.activeDevArtifactId) ?? artifacts[0]
  return `
    <section class="module-canvas develop-canvas">
      <div class="develop-shell">
        <div class="develop-browser">
          <aside class="develop-artifact-rail" aria-label="Agent artifacts">
            ${groups.map(group => renderDevArtifactGroup(group, selected?.id)).join('')}
          </aside>
          <section class="develop-artifact-detail">
            ${selected === undefined ? renderEmptyDevBrowser() : renderDevArtifactDetail(selected)}
          </section>
        </div>
      </div>
    </section>
  `
}

function renderEmptyDevBrowser(): string {
  return `
    <section class="dev-empty">
      <strong>No development artifacts found</strong>
      <span>Start the runtime or check the active cordis.yml config.</span>
    </section>
  `
}

function renderDevArtifactGroup(group: DevArtifactGroup, selectedId: string | undefined): string {
  return `
    <section class="dev-artifact-group">
      <h3>${escapeHtml(group.title)}</h3>
      <div>
        ${group.artifacts.map(artifact => renderDevArtifactButton(artifact, selectedId)).join('')}
      </div>
    </section>
  `
}

function renderDevArtifactButton(artifact: DevArtifact, selectedId: string | undefined): string {
  return `
    <button class="dev-artifact-row ${artifact.id === selectedId ? 'selected' : ''} ${artifact.kind}" data-dev-artifact="${artifact.id}">
      <div>
        <strong>${escapeHtml(artifact.title)}</strong>
        <span>${escapeHtml(artifact.subtitle)}</span>
      </div>
      <em>${escapeHtml(artifact.status ?? artifact.kind)}</em>
    </button>
  `
}

function renderDevArtifactDetail(artifact: DevArtifact): string {
  return `
    <article class="dev-detail-card ${artifact.kind}">
      <header class="dev-detail-head">
        <div>
          <span>${escapeHtml(artifact.group)}</span>
          <h3>${escapeHtml(artifact.title)}</h3>
          <p>${escapeHtml(artifact.subtitle)}</p>
        </div>
        <em>${escapeHtml(artifact.status ?? artifact.kind)}</em>
      </header>
      <section class="dev-detail-grid">
        ${renderDevFact('Source', artifact.source ?? 'unknown')}
        ${renderDevFact('Owner', artifact.owner ?? 'unknown')}
        ${renderDevFact('Recently used', artifact.recent ?? 'No recent evidence yet')}
        ${renderDevFact('Reload', reloadLabelForArtifact(artifact))}
      </section>
      ${renderDevCodePanel(contentTitleForArtifact(artifact), contentMetaForArtifact(artifact), artifact.value ?? '')}
      ${artifact.id === 'prompt:persona' ? renderDevRegistrySnapshot() : ''}
      ${artifact.metadata === undefined ? '' : renderDevCodePanel('Metadata', 'Implementation, dependency, and last-seen evidence', artifact.metadata)}
      ${artifact.kind === 'runtime' ? renderRuntimePanel() : ''}
      ${artifact.kind === 'change' ? renderChangeLoopPanel() : ''}
    </article>
  `
}

function renderDevFact(labelText: string, value: string): string {
  return `
    <div class="dev-fact">
      <span>${escapeHtml(labelText)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `
}

function renderDevRegistrySnapshot(): string {
  const groups = developArtifactGroups()
  const plugins = groups.find(group => group.title === 'Plugins / Context Providers')?.artifacts ?? []
  const tools = groups.find(group => group.title === 'Tools')?.artifacts ?? []
  return `
    <section class="dev-registry-snapshot">
      <div>
        <h4>Registered plugins</h4>
        ${renderDevPillList(plugins, 'No registered plugins found')}
      </div>
      <div>
        <h4>Registered tool surfaces</h4>
        ${renderDevPillList(tools, 'No registered tools found yet')}
      </div>
    </section>
  `
}

function renderDevPillList(artifacts: DevArtifact[], empty: string): string {
  if (artifacts.length === 0) return `<p>${escapeHtml(empty)}</p>`
  return `
    <ul>
      ${artifacts.map(artifact => `
        <li>
          <strong>${escapeHtml(artifact.title)}</strong>
          <span>${escapeHtml(artifact.status ?? artifact.kind)}</span>
        </li>
      `).join('')}
    </ul>
  `
}

function contentTitleForArtifact(artifact: DevArtifact): string {
  if (artifact.kind === 'prompt') return 'Effective prompt content'
  if (artifact.kind === 'tool') return 'Tool schema'
  if (artifact.kind === 'plugin') return 'Plugin config / contribution'
  if (artifact.kind === 'config') return 'Active configuration'
  if (artifact.kind === 'runtime') return 'Runtime state'
  return 'Suggested verification loop'
}

function contentMetaForArtifact(artifact: DevArtifact): string {
  if (artifact.kind === 'prompt') return 'Current source-level prompt text or prompt owner metadata'
  if (artifact.kind === 'tool') return 'Current registered schema when last seen by a model request'
  if (artifact.kind === 'plugin') return 'Who injects prompt/context or registers tools, based on active Cordis config'
  if (artifact.kind === 'config') return 'Model/runtime parameters and files whose edits require reload'
  if (artifact.kind === 'runtime') return 'Current Electron main process and ACP bridge state'
  return 'How to rerun and compare after editing the agent'
}

function reloadLabelForArtifact(artifact: DevArtifact): string {
  if (artifact.kind === 'runtime') return 'Manual restart available here'
  if (artifact.kind === 'change') return String(asRecord(state.dev).restartNeeded ?? false) === 'true' ? 'Restart recommended' : 'No restart signal'
  if (artifact.kind === 'config' || artifact.kind === 'prompt' || artifact.kind === 'tool' || artifact.kind === 'plugin') return 'Restart ACP after editing'
  return 'unknown'
}

function renderChangeLoopPanel(): string {
  return `
    <section class="dev-loop-card">
      <strong>Recommended loop</strong>
      <ol>
        <li>Edit the prompt, tool, plugin, or config source.</li>
        <li>Restart ACP runtime if the changed file is loaded at process start.</li>
        <li>Return to Chat and rerun a previous task or start a new one.</li>
        <li>Use Trajectory / Waterfall to compare behavior and timing evidence.</li>
      </ol>
    </section>
  `
}

function developArtifactGroups(): DevArtifactGroup[] {
  const dev = asRecord(state.dev)
  const composition = asRecord(dev.appComposition)
  const sourceFiles = Array.isArray(composition.sourceFiles) ? composition.sourceFiles : []
  const plugins = Array.isArray(composition.plugins) ? composition.plugins : []
  const recentPromptUses = Array.isArray(dev.recentPromptUses) ? dev.recentPromptUses : []
  const recentToolCalls = Array.isArray(dev.recentToolCalls) ? dev.recentToolCalls : []
  const request = latestRequestContext()
  const persona = extractPersonaFromConfig(String(composition.configText ?? ''))
  const promptOwner = sourceFiles.find(file => asRecord(file).label === 'System prompt service')
  const toolRegistryOwner = sourceFiles.find(file => asRecord(file).label === 'Tool registry')
  const promptArtifacts: DevArtifact[] = [
    {
      id: 'prompt:persona',
      group: 'Prompts',
      kind: 'prompt',
      title: 'System persona',
      subtitle: 'Current deployment persona forwarded from cordis.yml',
      status: persona.length > 0 ? 'active' : 'missing',
      source: String(composition.configPath ?? 'examples/acp-agent/cordis.yml'),
      owner: '@deepseek-ai/dsh-acp-demo -> @deepseek-ai/dsh-system-prompt',
      value: persona || 'No persona block found in the active config.',
      metadata: promptOwner ?? { path: 'packages/system-prompt/system-prompt/src/index.ts' },
      recent: recentPromptSummary(recentPromptUses, request),
    },
    {
      id: 'prompt:assembly',
      group: 'Prompts',
      kind: 'prompt',
      title: 'Prompt assembly service',
      subtitle: 'Owns persona, steering sections, and tool-order assembly',
      status: 'source',
      source: String(asRecord(promptOwner).path ?? 'packages/system-prompt/system-prompt/src/index.ts'),
      owner: '@deepseek-ai/dsh-system-prompt',
      value: promptOwner ?? { path: 'packages/system-prompt/system-prompt/src/index.ts' },
      metadata: {
        lastSeenSystemPromptChars: request.system.length,
        messagePrefix: request.messagePrefix,
        recentPromptUses,
      },
      recent: recentPromptSummary(recentPromptUses, request),
    },
  ]
  const toolArtifacts = buildToolArtifacts(request, plugins, toolRegistryOwner, recentToolCalls)
  const pluginArtifacts = plugins.map(plugin => pluginToArtifact(plugin))
  const configArtifacts: DevArtifact[] = [
    {
      id: 'config:cordis',
      group: 'Config / Runtime',
      kind: 'config',
      title: 'Active cordis.yml',
      subtitle: 'Process-start Cordis composition loaded by the desktop ACP runtime',
      status: 'active',
      source: String(composition.configPath ?? 'examples/acp-agent/cordis.yml'),
      owner: 'packages/examples/acp-demo/src/bin.ts',
      value: composition.configText ?? 'No config text reported by dev backend.',
      metadata: {
        entrypoint: composition.entrypoint ?? 'packages/examples/acp-demo/src/bin.ts',
        model: modelFromConfigText(String(composition.configText ?? '')),
        watchedPaths: dev.watchedPaths ?? [],
      },
      recent: runtimeLabel(),
    },
    {
      id: 'runtime:acp',
      group: 'Config / Runtime',
      kind: 'runtime',
      title: 'ACP runtime',
      subtitle: 'Managed backend process used by Chat and trace capture',
      status: runtimeLabel(),
      source: 'packages/ui/desktop/src/main.mjs',
      owner: 'Electron main process',
      value: { runtime: state.runtime, dev: state.dev },
      metadata: {
        repo: runtimeRepoRoot(),
        dirty: gitField('dirty'),
        branch: gitField('branch'),
        commit: gitField('commit'),
      },
      recent: String(asRecord(state.runtime).pid ?? 'No pid'),
    },
  ]
  const changeArtifacts: DevArtifact[] = [
    {
      id: 'change:loop',
      group: 'Change Loop',
      kind: 'change',
      title: 'Modify, reload, rerun',
      subtitle: 'The product loop after editing Harness, plugins, prompts, tools, or config',
      status: String(dev.restartNeeded ?? false) === 'true' ? 'restart needed' : 'ready',
      source: runtimeRepoRoot(),
      owner: 'Deepseek Harness desktop',
      value: {
        git: dev.git,
        restartNeeded: dev.restartNeeded ?? false,
        suggestedNextRun: state.selectedSessionId === undefined ? 'Start a chat task, then inspect its trajectory/waterfall.' : `Rerun or continue session ${state.selectedSessionId}`,
      },
      metadata: {
        selectedSessionId: state.selectedSessionId,
        sessionsAvailable: state.sessions.length,
      },
      recent: gitSummary(),
    },
  ]
  return [
    { title: 'Prompts', artifacts: promptArtifacts },
    { title: 'Tools', artifacts: toolArtifacts },
    { title: 'Plugins / Context Providers', artifacts: pluginArtifacts },
    { title: 'Config / Runtime', artifacts: configArtifacts },
    { title: 'Change Loop', artifacts: changeArtifacts },
  ]
}

function buildToolArtifacts(request: RequestContextSnapshot, plugins: unknown[], owner: unknown, recentToolCalls: unknown[]): DevArtifact[] {
  if (request.tools.length > 0) {
    return request.tools.map((tool, index) => {
      const record = asRecord(tool)
      const name = String(record.name ?? record.functionName ?? `tool_${index + 1}`)
      const schema = record.input_schema ?? record.inputSchema ?? record.parameters ?? record.schema ?? tool
      const plugin = plugins.find(candidate => toolLikelyOwnedByPlugin(name, asRecord(candidate)))
      const recent = recentToolCalls.find(call => String(asRecord(call).name) === name)
      return {
        id: `tool:${name}`,
        group: 'Tools',
        kind: 'tool',
        title: name,
        subtitle: String(record.description ?? record.summary ?? 'Registered model-facing tool'),
        status: 'registered',
        source: toolImplementationSource(name, plugin),
        owner: String(asRecord(plugin).name ?? asRecord(owner).path ?? '@deepseek-ai/dsh-tools'),
        value: schema,
        metadata: {
          fullTool: tool,
          ownerPlugin: plugin ?? 'No matching plugin inferred from active config',
          registry: owner ?? { path: 'packages/tools/tools/src/index.ts' },
          recentToolCall: recent ?? 'No persisted call evidence found',
        },
        recent: recentToolSummary(recent) || (request.event === undefined ? 'No request evidence yet' : `Schema last seen in request seq ${request.seq}`),
      } satisfies DevArtifact
    })
  }
  const toolPlugins = plugins.filter(plugin => {
    const record = asRecord(plugin)
    const id = String(record.id ?? '')
    const name = String(record.name ?? '')
    return id.includes('tool') || name.includes('tool') || id === 'bash' || id.includes('subagent') || id.includes('workflow')
  })
  return toolPlugins.map(plugin => {
    const record = asRecord(plugin)
    const id = String(record.id ?? 'tool')
    const recent = recentToolCalls.find(call => {
      const name = String(asRecord(call).name)
      return toolLikelyOwnedByPlugin(name, record) || id.includes(name)
    })
    return {
      id: `tool-plugin:${id}`,
      group: 'Tools',
      kind: 'tool',
      title: id,
      subtitle: String(record.name ?? 'Tool provider plugin'),
      status: 'provider',
      source: toolImplementationSource(id, plugin),
      owner: String(record.name ?? '@deepseek-ai/dsh-tools'),
      value: String(record.configPreview ?? '').trim() || 'Tool schema will appear here after the first model request captures the registered tool list.',
      metadata: {
        plugin,
        registry: owner ?? { path: 'packages/tools/tools/src/index.ts' },
        recentToolCall: recent ?? 'No persisted call evidence found',
      },
      recent: recentToolSummary(recent) || 'No request schema loaded',
    }
  })
}

function recentPromptSummary(recentPromptUses: unknown[], request: RequestContextSnapshot): string {
  const latest = asRecord(recentPromptUses[0])
  if (latest.sessionId !== undefined) return `Last used in ${shortId(String(latest.sessionId))} · seq ${String(latest.seq ?? '?')}`
  if (request.event !== undefined) return `Observed in selected trace · seq ${request.seq}`
  return 'No request evidence yet'
}

function recentToolSummary(call: unknown): string {
  const record = asRecord(call)
  if (record.name === undefined) return ''
  return `${String(record.count ?? 0)} calls · last ${shortId(String(record.lastSessionId ?? 'session'))} seq ${String(record.lastSeq ?? '?')}`
}

function pluginToArtifact(plugin: unknown): DevArtifact {
  const record = asRecord(plugin)
  const id = String(record.id ?? 'plugin')
  const name = String(record.name ?? '')
  const role = pluginRole(record)
  return {
    id: `plugin:${id}`,
    group: 'Plugins / Context Providers',
    kind: 'plugin',
    title: id,
    subtitle: name || 'Cordis config entry',
    status: role,
    source: String(record.source ?? 'examples/acp-agent/cordis.yml'),
    owner: name || id,
    value: String(record.configPreview ?? '').trim() || { id, name },
    metadata: {
      injectsPrompt: role.includes('prompt'),
      registersTool: role.includes('tool'),
      injectsContext: role.includes('context') || id.includes('hooks') || id.includes('repeat'),
      dependencyNote: 'Derived from the active Cordis config order; exact runtime graph can be added when the backend exposes Cordis fibers.',
    },
    recent: 'Loaded from active config',
  }
}

function pluginRole(plugin: Record<string, unknown>): string {
  const id = String(plugin.id ?? '')
  const name = String(plugin.name ?? '')
  if (id.includes('tool') || name.includes('tool') || id === 'bash' || id.includes('workflow') || id.includes('subagent')) return 'registers tool'
  if (id.includes('prompt') || name.includes('prompt') || id === 'acp-agent') return 'injects prompt'
  if (id.includes('hooks') || id.includes('guard') || id.includes('permission')) return 'context / policy provider'
  if (id.includes('llm')) return 'model provider'
  return 'plugin'
}

function toolLikelyOwnedByPlugin(toolName: string, plugin: Record<string, unknown>): boolean {
  const id = String(plugin.id ?? '').replace(/^tool-/, '')
  const name = String(plugin.name ?? '')
  return toolName.includes(id) || id.includes(toolName) || name.includes(toolName)
}

function toolImplementationSource(toolName: string, plugin: unknown): string {
  const packageName = String(asRecord(plugin).name ?? '')
  if (packageName.startsWith('@deepseek-ai/dsh-')) return `packages/${packageName.replace('@deepseek-ai/dsh-', '').replace(/^tool-/, 'tool-')}/`
  if (toolName === 'bash') return 'packages/bash/tool-bash/src/index.ts'
  if (toolName === 'subagent' || toolName === 'subagent_fork') return 'packages/agent/tool-subagent/src/index.ts'
  return 'packages/tools/tools/src/index.ts'
}

function modelFromConfigText(text: string): string {
  const match = text.match(/^\s*model:\s*(.+?)\s*$/m)
  return match?.[1] ?? 'unknown'
}

function extractPersonaFromConfig(text: string): string {
  const match = text.match(/persona:\s*\|\n([\s\S]*?)(?:\n\S|\n\s*#|$)/)
  if (match === null) return ''
  return match[1]
    .split('\n')
    .map(line => line.replace(/^ {6}/, ''))
    .join('\n')
    .trim()
}

function renderRuntimePanel(): string {
  return `
    <section class="module-card dev-status">
      <dl>${renderKeyValue('Repo', shortPath(runtimeRepoRoot()))}${renderKeyValue('Branch', gitField('branch'))}${renderKeyValue('Commit', gitField('commit'))}${renderKeyValue('Dirty', gitField('dirty'))}${renderKeyValue('ACP', runtimeLabel())}${renderKeyValue('Restart needed', String(asRecord(state.dev).restartNeeded ?? false))}</dl>
      <button data-action="restart-runtime" ${hasDesktopApi() ? '' : 'disabled'}>Restart ACP runtime</button>
    </section>
  `
}

function renderDevCodePanel(title: string, meta: string, value: unknown): string {
  return `
    <section class="dev-section">
      <header class="dev-section-head">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(meta)}</p>
        </div>
      </header>
      <pre class="dev-code"><code>${escapeHtml(formatDevValue(value))}</code></pre>
    </section>
  `
}

function renderBottomArea(session: SessionSummary | undefined): string {
  if (state.activeModule !== 'sessions') {
    return `<footer class="status-bar"><span>${escapeHtml(runtimeLabel())}</span><span>${escapeHtml(gitSummary())}</span></footer>`
  }
  return `
    <form class="composer" data-prompt-form="true">
      <textarea name="prompt" placeholder="${escapeHtml(session === undefined ? t('composer.placeholderDraft') : t('composer.placeholderSession'))}"></textarea>
      <div class="composer-meta">
        <button type="submit" disabled aria-label="Send message">↑</button>
      </div>
    </form>
  `
}

function renderInspector(): string {
  const target = state.selectedTarget!
  const feedbackCount = feedbackForTarget().length
  return `
    <aside class="inspector">
      <header class="inspector-head">
        <div>
          <span>${escapeHtml(target.kind)}</span>
          <strong>${escapeHtml(target.title)}</strong>
          <small>${escapeHtml(target.subtitle ?? '')}</small>
        </div>
        <button data-action="close-selection">${escapeHtml(t('inspector.close'))}</button>
      </header>
      <nav class="inspector-tabs">
        ${renderInspectorTabs(feedbackCount)}
      </nav>
      <section class="inspector-body">
        ${renderInspectorBody()}
      </section>
    </aside>
  `
}

function renderInspectorTabs(feedbackCount = feedbackForTarget().length): string {
  return INSPECTOR_TABS.map(tab => `
    <button class="${tab === state.activeInspectorTab ? 'active' : ''}" data-inspector-tab="${tab}">
      ${label(tab)}${tab === 'feedback' && feedbackCount > 0 ? ` ${feedbackCount}` : ''}
    </button>
  `).join('')
}

function renderInspectorBody(): string {
  const selected = state.selectedTarget
  if (selected === undefined) return ''
  if (state.activeInspectorTab === 'feedback') {
    const feedback = feedbackForTarget()
    return `
      <div class="feedback-list">
        ${feedback.map(record => `
          <article class="feedback-entry">
            <header><strong>${escapeHtml(record.data.author)}</strong><span>${escapeHtml(new Date(record.time).toLocaleString())}</span></header>
            <p>${escapeHtml(record.data.text)}</p>
          </article>
        `).join('') || `<p class="empty-panel">${escapeHtml(t('feedback.empty'))}</p>`}
      </div>
      <form class="feedback-form" data-feedback-form="true">
        <input name="author" value="${DEFAULT_FEEDBACK_AUTHOR}" aria-label="${escapeHtml(t('feedback.author'))}" />
        <textarea name="text" rows="5" placeholder="${escapeHtml(t('feedback.placeholder'))}"></textarea>
        <button type="submit">${escapeHtml(t('feedback.add'))}</button>
      </form>
    `
  }
  const payload = payloadForTarget(selected)
  const value = state.activeInspectorTab === 'input' ? payload.input : state.activeInspectorTab === 'output' ? payload.output : payload.metadata
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`
}

function renderInspectorOnly(): void {
  const tabs = document.querySelector<HTMLElement>('.inspector-tabs')
  const body = document.querySelector<HTMLElement>('.inspector-body')
  if (tabs === null || body === null) {
    render()
    return
  }
  tabs.innerHTML = renderInspectorTabs()
  body.innerHTML = renderInspectorBody()
}

function renderEmptySession(): string {
  return `
    <section class="empty-state">
      <h2>${escapeHtml(t('chat.startTitle'))}</h2>
      <p>${escapeHtml(t('chat.startBody'))}</p>
      <button data-action="new-session" ${hasDesktopApi() ? '' : 'disabled'}>${escapeHtml(t('app.newChat'))}</button>
    </section>
  `
}

function renderDraftChat(): string {
  return `
    <section class="session-canvas">
      <section class="surface chat-surface">
        <div class="empty-thread">
          <h2>${escapeHtml(t('chat.newTitle'))}</h2>
          <p>${escapeHtml(t('chat.newBody'))}</p>
        </div>
      </section>
    </section>
  `
}

function renderEmptyConversation(): string {
  return `
    <div class="empty-thread">
      <h2>${escapeHtml(t('chat.emptyTitle'))}</h2>
      <p>${escapeHtml(t('chat.emptyBody'))}</p>
    </div>
  `
}

function renderEmptyTrace(): string {
  return `<div class="empty-thread compact"><h2>${escapeHtml(t('empty.traceTitle'))}</h2><p>${escapeHtml(t('empty.traceBody'))}</p></div>`
}

function renderKeyValue(key: string, value: unknown): string {
  return `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`
}

function filteredSessions(): SessionSummary[] {
  const query = state.query.trim().toLowerCase()
  if (query.length === 0) return state.sessions
  return state.sessions.filter(session => [
    session.id,
    session.title,
    session.cwd ?? '',
    session.relativePath ?? '',
    session.model ?? '',
  ].join('\n').toLowerCase().includes(query))
}

function chatRows(): ChatRow[] {
  const sessionId = state.selectedSessionId
  if (sessionId === undefined) return []
  const fromTrace = rowsFromEvents(state.trace?.events ?? [])
  const live = flushLiveDrafts(sessionId)
  if (fromTrace.length === 0) return live
  return [...fromTrace, ...live.filter(row => row.eventSeqs.length === 0)]
}

function rowsFromEvents(events: readonly SessionEvent[]): ChatRow[] {
  const rows: ChatRow[] = []
  const reasoningByStep = new Map<string, { text: string; seq: number }>()
  const seenReasoningStep = new Set<string>()
  const toolResults = new Map<string, SessionEvent>()

  for (const event of events) {
    if (event.type === 'tool/result') {
      const callId = String(asRecord(event.data).callId ?? '')
      if (callId.length > 0) toolResults.set(callId, event)
    }
  }

  for (const event of events) {
    if (event.type === 'assistant/chunk') {
      const chunk = asRecord(asRecord(event.data).chunk)
      if (chunk.type === 'reasoning-delta') {
        const key = `${asRecord(event.data).turn}:${asRecord(event.data).step}`
        const previous = reasoningByStep.get(key)
        reasoningByStep.set(key, {
          text: `${previous?.text ?? ''}${String(chunk.text ?? '')}`,
          seq: previous?.seq ?? event.seq ?? 0,
        })
      }
    }
  }

  for (const event of events) {
    const seq = event.seq ?? rows.length
    const data = asRecord(event.data)
    if (event.type === 'user/message') {
      rows.push({ target: makeTarget('message', 'User message', seq, `seq ${seq}`), role: 'user', title: 'User', body: contentText(data.content), eventSeqs: [seq] })
    } else if (event.type === 'assistant/message') {
      const key = `${data.turn}:${data.step}`
      const reasoning = reasoningByStep.get(key)
      if (reasoning !== undefined && !seenReasoningStep.has(key)) {
        seenReasoningStep.add(key)
        rows.push({
          target: makeTarget('assistant-stream', 'Thinking', reasoning.seq, `turn ${String(data.turn)} step ${String(data.step)}`),
          role: 'thinking',
          title: 'Thinking',
          body: reasoning.text,
          eventSeqs: [reasoning.seq],
          collapsed: true,
          badge: 'folded',
        })
      }
      rows.push({ target: makeTarget('message', 'Assistant message', seq, `seq ${seq}`), role: 'assistant', title: 'Assistant', body: contentText(data.content), eventSeqs: [seq] })
    } else if (event.type === 'tool/call') {
      const callId = String(data.callId ?? '')
      const result = toolResults.get(callId)
      const resultData = asRecord(result?.data)
      rows.push({
        target: makeTarget('tool-call', `Tool · ${String(data.name ?? 'tool')}`, seq, `seq ${seq}`),
        role: 'tool',
        title: `Tool use · ${String(data.name ?? 'tool')}`,
        body: renderValue({
          input: data.arguments ?? data.rawInput ?? data,
          output: resultData.content ?? resultData.output,
          error: resultData.isError ? resultData.error ?? resultData : undefined,
        }),
        eventSeqs: [seq],
        collapsed: true,
        badge: 'tool',
      })
    } else if (event.type === 'context/message' || event.type === 'steering/message') {
      rows.push({
        target: makeTarget('context-section', event.type, seq, `seq ${seq}`),
        role: 'context',
        title: event.type,
        body: contentText(data.content),
        eventSeqs: [seq],
        collapsed: true,
        badge: 'context',
      })
    }
  }
  return rows
}

function flushLiveDrafts(sessionId: string): ChatRow[] {
  const rows = [...(state.liveRows.get(sessionId) ?? [])]
  const thinking = state.pendingThinking.get(sessionId)
  if (thinking !== undefined && thinking.length > 0) {
    rows.push(makeSyntheticRow(sessionId, 'thinking', 'Thinking', thinking, 'thinking-live', true))
  }
  const assistant = state.pendingAssistant.get(sessionId)
  if (assistant !== undefined && assistant.length > 0) {
    rows.push(makeSyntheticRow(sessionId, 'assistant', 'Assistant', assistant, 'assistant-live'))
  }
  return rows
}

function makeSyntheticRow(
  sessionId: string,
  role: ChatRow['role'],
  title: string,
  body: string,
  syntheticId: string,
  collapsed = false,
): ChatRow {
  const targetKind = role === 'tool' ? 'tool-call' : role === 'thinking' ? 'assistant-stream' : 'message'
  return {
    target: {
      id: createInspectorTargetId({ sessionId, kind: targetKind, syntheticId }),
      kind: targetKind,
      title,
      subtitle: 'live ACP update',
    },
    role,
    title,
    body,
    eventSeqs: [],
    collapsed,
    badge: collapsed ? 'live' : undefined,
  }
}

function trajectoryRows(): TreeRow[] {
  const events = state.trace?.events ?? []
  const rows: TreeRow[] = []
  const sessionId = state.selectedSessionId
  if (sessionId !== undefined) {
    rows.push({
      target: makeTarget('session', `Session ${sessionId}`, 0, state.trace?.relativePath ?? 'session root'),
      depth: 0,
      kind: 'session',
      title: `Session ${shortId(sessionId)}`,
      subtitle: `${events.length} events · ${state.trace?.found ? 'persisted JSONL' : 'live session'}`,
      meta: state.trace?.found ? 'saved' : 'live',
      tone: 'blue',
    })
  }

  for (const event of events) {
    const seq = event.seq ?? 0
    const data = asRecord(event.data)
    if (event.type === 'turn/start') rows.push(treeRow('turn', `Turn ${String(data.turn)}`, summarizeTrigger(data.trigger), seq, 1, undefined, 'blue'))
    else if (event.type === 'step/start') rows.push(treeRow('step', `Step ${String(data.step)}`, `turn ${String(data.turn)}`, seq, 2))
    else if (event.type === 'request/header' || event.type === 'request/header-delta') rows.push(treeRow('request', event.type, summarizeHeaderEvent(event), seq, 3, 'request', 'amber'))
    else if (event.type === 'assistant/message') rows.push(treeRow('message', 'Assistant message', truncate(contentText(data.content), 130), seq, 3, 'message'))
    else if (event.type === 'tool/call') rows.push(treeRow('tool', `Tool · ${String(data.name ?? 'tool')}`, truncate(renderValue(data.arguments ?? data.rawInput ?? data), 140), seq, 3, 'tool-call', 'green'))
    else if (event.type === 'tool/result') rows.push(treeRow(data.isError ? 'error' : 'tool', 'Tool result', truncate(contentText(data.content), 140), seq, 3, 'tool-result', data.isError ? 'red' : 'green'))
    else if (event.type === 'context/message' || event.type === 'steering/message') rows.push(treeRow('context', event.type, truncate(contentText(data.content), 140), seq, 3, 'context-section', 'blue'))
  }
  return rows
}

function treeRow(
  kind: TreeRow['kind'],
  title: string,
  subtitle: string,
  seq: number,
  depth: number,
  targetKind: InspectorTarget['kind'] = kind === 'tool' ? 'tool-call' : kind === 'thinking' ? 'assistant-stream' : kind === 'context' ? 'context-section' : kind === 'error' ? 'tool-result' : kind,
  tone?: TreeRow['tone'],
): TreeRow {
  return {
    target: makeTarget(targetKind, title, seq, `seq ${seq}`),
    depth,
    kind,
    title,
    subtitle,
    meta: `seq ${seq}`,
    tone,
  }
}

function waterfallRows(): SpanRow[] {
  const events = state.trace?.events ?? []
  const first = events.find(event => typeof event.time === 'number')?.time ?? Date.now()
  const starts = new Map<string, SessionEvent>()
  const spans: SpanRow[] = []
  for (const event of events) {
    const data = asRecord(event.data)
    if (event.type === 'turn/start') starts.set(`turn:${String(data.turn)}`, event)
    if (event.type === 'step/start') starts.set(`step:${String(data.turn)}:${String(data.step)}`, event)
    if (event.type === 'turn/end') {
      const start = starts.get(`turn:${String(data.turn)}`)
      if (start) spans.push(timedRow(`Turn ${String(data.turn)}`, start, event, 'turn', first, 'blue'))
    }
    if (event.type === 'step/end') {
      const start = starts.get(`step:${String(data.turn)}:${String(data.step)}`)
      if (start) spans.push(timedRow(`Step ${String(data.step)}`, start, event, 'step', first))
    }
    if (event.type === 'tool/call') {
      const result = events.find(candidate => candidate.type === 'tool/result' && asRecord(candidate.data).callId === data.callId)
      spans.push(timedRow(`Tool · ${String(data.name ?? data.callId ?? 'tool')}`, event, result ?? event, 'tool-call', first, 'green'))
    }
  }
  return spans.sort((a, b) => a.startMs - b.startMs)
}

function timedRow(title: string, start: SessionEvent, end: SessionEvent, kind: InspectorTarget['kind'], zero: number, tone?: SpanRow['tone']): SpanRow {
  const durationMs = Math.max(0, (end.time ?? start.time ?? 0) - (start.time ?? 0))
  return {
    target: makeTarget(kind, title, start.seq ?? 0, `seq ${start.seq ?? 0}`),
    title,
    subtitle: `${eventTime(start)} → ${eventTime(end)}`,
    startMs: Math.max(0, (start.time ?? 0) - zero),
    durationMs,
    tone,
  }
}

function latestRequestContext(): RequestContextSnapshot {
  const event = [...(state.trace?.events ?? [])].reverse().find(candidate => candidate.type === 'request/header' || candidate.type === 'request/header-delta')
  const data = asRecord(event?.data)
  const header = asRecord(data.header)
  const delta = event?.type === 'request/header-delta' ? data : {}
  const systemValue = header.system ?? delta.system ?? ''
  const toolsValue = header.tools ?? delta.tools ?? []
  return {
    event,
    seq: event?.seq ?? 0,
    header,
    delta,
    system: typeof systemValue === 'string' ? systemValue : renderValue(systemValue),
    tools: Array.isArray(toolsValue) ? toolsValue : [],
    config: header.config ?? delta.config ?? {},
    messagePrefix: header.messagePrefix ?? delta.messagePrefix ?? [],
  }
}

function contextRows(): ContextRow[] {
  const events = state.trace?.events ?? []
  const request = latestRequestContext()
  const rows: ContextRow[] = []
  if (request.event !== undefined) {
    rows.push(contextRow('System prompt', `${request.system.length} chars`, request.system || 'No system prompt found in latest request header.', 'system', 'request', request.seq, Boolean(request.delta.system)))
    rows.push(contextRow('Tool schemas', `${request.tools.length} tools`, request.tools.length > 0 ? request.tools.map(tool => String(asRecord(tool).name ?? 'tool')).join(', ') : 'No tool schemas found in latest request header.', 'tools', 'request', request.seq, Boolean(request.delta.tools)))
    rows.push(contextRow('Call config', request.config === undefined ? 'empty' : 'available', renderValue(request.config), 'config', 'request', request.seq, Boolean(request.delta.config)))
    rows.push(contextRow('Message prefix', Array.isArray(request.messagePrefix) ? `${request.messagePrefix.length} messages` : 'derived', renderValue(request.messagePrefix), 'messages', 'request', request.seq, Boolean(request.delta.messagePrefix)))
  }
  const modelVisible = rowsFromEvents(events).filter(row => row.role === 'user' || row.role === 'assistant' || row.role === 'context')
  rows.push(contextRow('Derived history', `${modelVisible.length} visible rows`, modelVisible.map(row => `${row.title}: ${truncate(row.body, 80)}`).join('\n'), 'messages', 'context-section', 0))
  rows.push(contextRow('Raw JSONL', `${events.length} events`, state.trace?.rawText ?? '', 'raw', 'session', 0))
  return rows
}

function contextRow(
  title: string,
  subtitle: string,
  preview: string,
  kind: ContextRow['kind'],
  targetKind: InspectorTarget['kind'],
  seq: number,
  changed = false,
): ContextRow {
  return {
    target: makeTarget(targetKind, title, seq, `seq ${seq}`),
    title,
    subtitle,
    preview: truncate(preview, 240),
    kind,
    changed,
  }
}

function payloadForTarget(target: InspectorTarget): TargetPayload {
  const events = state.trace?.events ?? []
  const seq = Number(target.id.match(/seq:(\d+)/)?.[1] ?? Number.NaN)
  const event = Number.isFinite(seq) ? events.find(candidate => candidate.seq === seq) : undefined
  const data = asRecord(event?.data)
  return {
    input: inspectorInput(target, event),
    output: inspectorOutput(target, event),
    metadata: {
      target,
      session: state.trace?.header,
      event,
      eventWindow: Number.isFinite(seq) ? events.filter(candidate => Math.abs((candidate.seq ?? 0) - seq) <= 4) : events.slice(0, 20),
      rawJsonlPath: state.trace?.relativePath ?? state.trace?.path,
      runtime: state.runtime,
      dev: state.dev,
      surface: state.activeSurface,
      module: state.activeModule,
      dataKeys: Object.keys(data),
    },
  }
}

function inspectorInput(target: InspectorTarget, event: SessionEvent | undefined): unknown {
  if (target.kind === 'request') return latestRequestHeader()
  if (target.kind === 'dev-object') return devObjectPayload(target)
  return event?.data ?? target
}

function inspectorOutput(target: InspectorTarget, event: SessionEvent | undefined): unknown {
  if (target.kind === 'session') return { trace: state.trace, feedback: state.trace?.feedback ?? [] }
  if (target.kind === 'context-section' || target.kind === 'request') return contextRows()
  if (target.kind === 'dev-object') return devObjectPayload(target)
  return event ?? target
}

function latestRequestHeader(): unknown {
  const request = latestRequestContext()
  return request.event?.data ?? {}
}

function devObjectPayload(target: InspectorTarget): unknown {
  const request = latestRequestContext()
  const syntheticId = target.id.match(/synthetic:(.+)$/)?.[1] ?? ''
  if (syntheticId === 'system-prompt') return request.system
  if (syntheticId === 'message-prefix') return request.messagePrefix
  if (syntheticId === 'derived-history') {
    return rowsFromEvents(state.trace?.events ?? [])
      .filter(row => row.role === 'user' || row.role === 'assistant' || row.role === 'context')
      .map(row => ({ role: row.role, title: row.title, body: row.body, eventSeqs: row.eventSeqs }))
  }
  if (syntheticId === 'raw-jsonl') return state.trace?.rawText ?? ''
  if (syntheticId === 'request-header') return request.header
  if (syntheticId === 'call-config') return request.config
  if (syntheticId.startsWith('tool-')) {
    const index = Number(syntheticId.match(/^tool-(\d+)-/)?.[1] ?? Number.NaN)
    if (Number.isFinite(index)) return request.tools[index] ?? target
  }
  if (syntheticId === 'config-path') return asRecord(state.runtime).configPath
  if (syntheticId === 'watched-paths') return asRecord(state.dev).watchedPaths
  if (syntheticId === 'dev-status') return state.dev
  if (syntheticId === 'runtime-status') return { runtime: state.runtime, dev: state.dev }
  return {
    target,
    repoRoot: runtimeRepoRoot(),
    configPath: asRecord(state.runtime).configPath,
    watchedPaths: asRecord(state.dev).watchedPaths,
    note: 'The first implementation exposes the backend status. File-level editing surfaces can bind here next.',
  }
}

function feedbackForTarget(): FeedbackRecord[] {
  const selected = state.selectedTarget
  if (selected === undefined) return []
  return (state.trace?.feedback ?? []).filter(record => record.data?.targetId === selected.id)
}

document.addEventListener('click', event => {
  const element = event.target instanceof Element ? event.target : undefined

  const module = element?.closest<HTMLButtonElement>('[data-module]')?.dataset.module as AppModule | undefined
  if (module !== undefined) {
    state.activeModule = module
    state.selectedTarget = undefined
    render()
    return
  }

  const surface = element?.closest<HTMLButtonElement>('[data-surface]')?.dataset.surface as DesktopSurface | undefined
  if (surface !== undefined) {
    state.activeSurface = surface
    render()
    return
  }

  const sessionId = element?.closest<HTMLButtonElement>('[data-session]')?.dataset.session
  if (sessionId !== undefined) {
    state.activeModule = 'sessions'
    state.draftChat = false
    void loadTrace(sessionId)
    return
  }

  const devArtifactId = element?.closest<HTMLButtonElement>('[data-dev-artifact]')?.dataset.devArtifact
  if (devArtifactId !== undefined) {
    state.activeDevArtifactId = devArtifactId
    render()
    return
  }

  const targetId = element?.closest<HTMLElement>('[data-target]')?.dataset.target
  if (targetId !== undefined) {
    const target = findTarget(targetId)
    state.selectedTarget = target
    state.activeInspectorTab = target === undefined ? 'input' : defaultInspectorTabForTarget(target)
    render()
    return
  }

  const inspectorTab = element?.closest<HTMLButtonElement>('[data-inspector-tab]')?.dataset.inspectorTab
  if (inspectorTab !== undefined) {
    state.activeInspectorTab = inspectorTab as InspectorTab
    renderInspectorOnly()
    return
  }

  const action = element?.closest<HTMLElement>('[data-action]')?.dataset.action
  if (action === 'toggle-locale') {
    state.locale = state.locale === 'zh-CN' ? 'en-US' : 'zh-CN'
    localStorage.setItem('dsh.locale', state.locale)
    render()
    return
  }

  if (action === 'close-selection') {
    state.selectedTarget = undefined
    render()
  } else if (action === 'new-session') {
    startDraftChat()
  } else if (action === 'reload-trace' && state.selectedSessionId !== undefined) {
    void loadTrace(state.selectedSessionId).then(() => refreshSessions(state.selectedSessionId))
  } else if (action === 'restart-runtime') {
    if (!hasDesktopApi()) {
      state.error = 'Desktop API is not available. Use the Electron window, not the browser tab.'
      render()
      return
    }
    void window.dshDesktop.runtime.restart().then(refreshRuntime)
  }
})

document.addEventListener('input', event => {
  const input = event.target instanceof HTMLInputElement ? event.target : undefined
  if (input?.dataset.search === 'true') {
    state.query = input.value
    render()
    return
  }
  const textarea = event.target instanceof HTMLTextAreaElement ? event.target : undefined
  if (textarea !== undefined && textarea.closest<HTMLFormElement>('[data-prompt-form="true"]') !== null) {
    autosizeComposer(textarea)
    updateComposerSubmit(textarea)
  }
})

document.addEventListener('submit', event => {
  const form = event.target instanceof HTMLFormElement ? event.target : undefined
  if (form?.dataset.promptForm === 'true') {
    event.preventDefault()
    if (state.busy) return
    const prompt = String(new FormData(form).get('prompt') ?? '').trim()
    if (prompt.length > 0) void sendPrompt(prompt, form)
  } else if (form?.dataset.feedbackForm === 'true') {
    event.preventDefault()
    void addFeedback(form)
  }
})

document.addEventListener('keydown', event => {
  const textarea = event.target instanceof HTMLTextAreaElement ? event.target : undefined
  if (textarea !== undefined && textarea.closest<HTMLFormElement>('[data-prompt-form="true"]') !== null) {
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    const form = textarea.closest<HTMLFormElement>('[data-prompt-form="true"]')
    if (form !== null) form.requestSubmit()
    return
  }

})

function autosizeComposer(textarea: HTMLTextAreaElement): void {
  textarea.style.height = '0px'
  textarea.style.height = `${Math.min(132, Math.max(42, textarea.scrollHeight))}px`
}

function updateComposerSubmit(textarea: HTMLTextAreaElement): void {
  const form = textarea.closest<HTMLFormElement>('[data-prompt-form="true"]')
  const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (button !== undefined && button !== null) {
    button.disabled = state.busy || !hasDesktopApi() || textarea.value.trim().length === 0
  }
}

function startDraftChat(): void {
  state.activeModule = 'sessions'
  state.activeSurface = 'chat'
  state.selectedSessionId = undefined
  state.trace = undefined
  state.selectedTarget = undefined
  state.draftChat = true
  state.error = ''
  render()
  focusComposer()
}

async function createBackendSession(): Promise<string | undefined> {
  if (!hasDesktopApi()) {
    state.error = 'Desktop API is not available. Use the Electron window, not the browser tab.'
    render()
    return undefined
  }
  try {
    const result = asRecord(await window.dshDesktop.sessions.create())
    state.selectedSessionId = String(result.sessionId)
    state.trace = result.trace as TracePayload
    state.draftChat = false
    return state.selectedSessionId
  } catch (error) {
    state.error = String(error)
    render()
    return undefined
  }
}

async function sendPrompt(prompt: string, form: HTMLFormElement): Promise<void> {
  if (!hasDesktopApi()) {
    state.error = 'Desktop API is not available. Use the Electron window, not the browser tab.'
    render()
    return
  }
  if (state.selectedSessionId === undefined) await createBackendSession()
  if (state.selectedSessionId === undefined) return
  const sessionId = state.selectedSessionId
  form.reset()
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')
  if (textarea !== null) autosizeComposer(textarea)
  const rows = state.liveRows.get(sessionId) ?? []
  rows.push(makeSyntheticRow(sessionId, 'user', 'User', prompt, `user-${Date.now()}`))
  state.liveRows.set(sessionId, rows)
  state.pendingAssistant.delete(sessionId)
  state.pendingThinking.delete(sessionId)
  state.busy = true
  state.error = ''
  render()
  try {
    const result = asRecord(await window.dshDesktop.sessions.prompt(sessionId, prompt))
    state.trace = result.trace as TracePayload
    state.liveRows.delete(sessionId)
    state.pendingAssistant.delete(sessionId)
    state.pendingThinking.delete(sessionId)
    await refreshSessions(sessionId)
  } catch (error) {
    state.error = String(error)
  } finally {
    state.busy = false
    render()
    focusComposer()
  }
}

function focusComposer(): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
  })
}

async function addFeedback(form: HTMLFormElement): Promise<void> {
  if (!hasDesktopApi()) return
  if (state.selectedSessionId === undefined || state.selectedTarget === undefined) return
  const data = new FormData(form)
  const text = String(data.get('text') ?? '').trim()
  if (text.length === 0) return
  await window.dshDesktop.feedback.add({
    sessionId: state.selectedSessionId,
    targetId: state.selectedTarget.id,
    targetTitle: state.selectedTarget.title,
    targetKind: state.selectedTarget.kind,
    author: String(data.get('author') ?? DEFAULT_FEEDBACK_AUTHOR),
    text,
  })
  await loadTrace(state.selectedSessionId, false)
  state.activeInspectorTab = 'feedback'
  render()
}

function findTarget(id: string): InspectorTarget | undefined {
  const targets = [
    ...chatRows().map(row => row.target),
    ...trajectoryRows().map(row => row.target),
    ...waterfallRows().map(row => row.target),
    ...contextRows().map(row => row.target),
  ]
  return targets.find(target => target.id === id) ?? targetFromId(id)
}

function selectedClass(target: InspectorTarget): string {
  return isSelectedTarget(target) ? 'is-selected' : ''
}

function isSelectedTarget(target: InspectorTarget): boolean {
  const selected = state.selectedTarget
  if (selected === undefined) return false
  if (selected.id === target.id) return true
  const selectedSeq = selected.id.match(/seq:(\d+)/)?.[1]
  const targetSeq = target.id.match(/seq:(\d+)/)?.[1]
  return selectedSeq !== undefined && selectedSeq === targetSeq
}

function syncSelectionAfterRender(): void {
  if (state.selectedTarget === undefined) return
  window.requestAnimationFrame(() => {
    const selected = document.querySelector<HTMLElement>('.is-selected[data-target], .is-selected [data-target]')
    selected?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

function targetFromId(id: string): InspectorTarget | undefined {
  const kind = id.match(/kind:([^:]+)/)?.[1] as InspectorTarget['kind'] | undefined
  if (kind === undefined) return undefined
  return { id, kind, title: label(kind), subtitle: 'derived target' }
}

function makeTarget(kind: InspectorTarget['kind'], title: string, seq: number, subtitle?: string): InspectorTarget {
  const sessionId = state.selectedSessionId ?? state.trace?.sessionId ?? 'unknown'
  return {
    id: createInspectorTargetId({ sessionId, kind, eventSeq: seq }),
    kind,
    title,
    subtitle: subtitle ?? `seq ${seq}`,
  }
}

function currentSession(): SessionSummary | undefined {
  return state.sessions.find(session => session.id === state.selectedSessionId)
}

function uniqueTurns(): number[] {
  const turns = new Set<number>()
  for (const event of state.trace?.events ?? []) {
    const turn = Number(asRecord(event.data).turn)
    if (Number.isFinite(turn)) turns.add(turn)
  }
  return [...turns].sort((a, b) => a - b)
}

function moduleTitle(): string {
  if (state.activeModule === 'sessions') return 'Sessions'
  return 'Develop'
}

function topbarTitle(session: SessionSummary | undefined): string {
  if (state.activeModule !== 'sessions') return moduleTitle()
  return session?.title || 'Sessions'
}

function surfaceLabel(surface: DesktopSurface): string {
  if (surface === 'chat') return t('surface.chat')
  if (surface === 'trajectory') return t('surface.trajectory')
  if (surface === 'waterfall') return t('surface.waterfall')
  if (surface === 'context') return 'Context'
  if (surface === 'compare') return 'Compare'
  return 'Dev'
}

function runtimeLabel(): string {
  const runtime = asRecord(state.runtime)
  return `ACP ${String(runtime.state ?? 'starting')}`
}

function runtimeStateClass(): string {
  const runtime = asRecord(state.runtime)
  const value = String(runtime.state ?? 'starting')
  if (value === 'running') return 'running'
  if (value === 'error') return 'error'
  return 'starting'
}

function runtimeRepoRoot(): string {
  return String(asRecord(state.runtime).repoRoot ?? '/Users/tn.shen/Documents/deepseek-harness-master')
}

function gitField(key: string): string {
  const git = asRecord(asRecord(state.dev).git)
  return String(git[key] ?? 'unknown')
}

function gitSummary(): string {
  return `${gitField('branch')} @ ${gitField('commit')}${gitField('dirty') === 'true' ? ' · dirty' : ''}`
}

function summarizeHeaderEvent(event: SessionEvent): string {
  const data = asRecord(event.data)
  const header = asRecord(data.header)
  if (event.type === 'request/header') {
    const tools = Array.isArray(header.tools) ? header.tools.length : 0
    return `system ${String(header.system ?? '').length} chars · ${tools} tools`
  }
  return truncate(renderValue(data), 160)
}

function summarizeTrigger(value: unknown): string {
  const text = renderValue(value)
  return text === '{}' ? 'user prompt' : truncate(text, 120)
}

function eventTime(event: SessionEvent): string {
  if (typeof event.time !== 'number') return 'unknown'
  return new Date(event.time).toLocaleTimeString()
}

function asSessionUpdate(value: unknown): SessionUpdatePayload {
  const record = asRecord(value)
  return {
    sessionId: String(record.sessionId ?? ''),
    update: asRecord(record.update),
  }
}

function hasDesktopApi(): boolean {
  return window.dshDesktop !== undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map(block => {
    const record = asRecord(block)
    if (record.type === 'text' || record.type === 'reasoning') return String(record.text ?? '')
    if (record.type === 'resource_link') return `[resource ${String(record.name ?? '')}] ${String(record.uri ?? '')}`
    return JSON.stringify(record)
  }).filter(Boolean).join('\n')
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function formatDevValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  return renderValue(value)
}

function targetSeq(target: InspectorTarget): number {
  return Number(target.id.match(/seq:(\d+)/)?.[1] ?? Number.NaN)
}

function label(value: string): string {
  return value
    .split(/[-_]/)
    .map(part => part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

function formatRelativeTime(time: number): string {
  const diff = Date.now() - time
  if (!Number.isFinite(diff) || diff < 0) return 'now'
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function truncate(value: string, limit = 180): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value
}

function shortPath(value: string): string {
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= 2) return value
  return `.../${parts.slice(-2).join('/')}`
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderMarkdown(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map(part => `<p>${part.replaceAll('\n', '<br>')}</p>`)
    .join('')
}
