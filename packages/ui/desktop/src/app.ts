/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-conversion, @stylistic/max-len */
import { DEFAULT_FEEDBACK_AUTHOR, INSPECTOR_TABS, type InspectorTab } from './index.ts'
import { translate, type I18nKey, type Locale } from './i18n.ts'
import { assistantText, contentText } from './renderer-content.ts'
import { buildTraceGraph, type ChatActivity, type ChatTurn, type TraceTarget, type TrajectoryGroup as GraphTrajectoryGroup } from './trace-graph.ts'
import './styles.css'

const PATH_SYSTEM_PROMPT = 'packages/core/system-prompt/src/index.ts'
const PATH_TOOL_REGISTRY = 'packages/core/tools/src/index.ts'
const PATH_TOOL_BASH = 'packages/bash/tool-bash/src/index.ts'
const PATH_TOOL_SUBAGENT = 'packages/subagent/tool-subagent/src/index.ts'

interface SessionSummary {
  readonly id: string
  readonly parentSession?: string
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
  feedback?: FeedbackRecord[]
  readonly parent?: SessionSummary
  readonly children?: SessionSummary[]
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

/** One in-flight turn rendered incrementally while ACP updates stream in. */
interface LiveTurn {
  /** Distinguishes turns so a new prompt never reuses the previous turn's DOM skeleton. */
  key: number
  userText?: string
  thinking: string
  answer: string
  plan?: readonly PlanItem[]
  tools: LiveTool[]
  expectedCompletedTurns: number
  status: 'sending' | 'streaming' | 'complete' | 'error'
  errorText?: string
}

interface PlanItem {
  readonly content: string
  readonly status: string
}

interface LiveToolMeta {
  title?: string
  kind?: string
  locations?: readonly { path: string; line?: number }[]
}

interface LiveTool {
  readonly callId: string
  title: string
  status: string
  detail: string
}

type PayloadFormat = 'plain' | 'json' | 'jsonl' | 'yaml'

interface DevArtifact {
  readonly id: string
  readonly group: 'Prompts' | 'Tools' | 'Plugins / Context Providers' | 'Config / Runtime'
  readonly title: string
  readonly subtitle: string
  readonly kind: 'prompt' | 'tool' | 'plugin' | 'config' | 'runtime' | 'source'
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

interface RequestContextSnapshot {
  readonly event: SessionEvent | undefined
  readonly seq: number
  readonly header: Record<string, unknown>
  readonly system: string
  readonly tools: unknown[]
  readonly messagePrefix: unknown
}

type PluginRole = 'tool' | 'prompt' | 'context-policy' | 'model' | 'plugin'

type AppModule = 'sessions' | 'develop'

type SessionSurface = 'chat' | 'trajectory' | 'waterfall'

const SESSION_SURFACES: readonly SessionSurface[] = ['chat', 'trajectory', 'waterfall']
const DRAFT_SESSION_ID = '__draft-session__'
const AUTHOR_KEY = 'dsh.author'
const PANE_WIDTH_KEY = 'dsh.pane-widths'
const initialLocale: Locale = localStorage.getItem('dsh.locale') === 'en-US' ? 'en-US' : 'zh-CN'

const state = {
  runtime: undefined as unknown,
  dev: undefined as unknown,
  sessions: [] as SessionSummary[],
  selectedSessionId: undefined as string | undefined,
  trace: undefined as TracePayload | undefined,
  activeModule: 'sessions' as AppModule,
  activeSurface: 'chat' as SessionSurface,
  locale: initialLocale,
  activeDevArtifactId: undefined as string | undefined,
  selectedTargetId: undefined as string | undefined,
  activeInspectorTab: 'input' as InspectorTab,
  inspectorFormats: { input: 'plain', output: 'plain', metadata: 'json' } as Record<'input' | 'output' | 'metadata', PayloadFormat>,
  busySessionId: undefined as string | undefined,
  error: '',
  query: '',
  draftChat: false,
  live: new Map<string, LiveTurn>(),
  pendingSessionTitles: new Map<string, string>(),
  feedbackDrafts: new Map<string, { author: string; text: string }>(),
  expandedTrajectoryIds: new Set<string>(),
  annotateOpenIds: new Set<string>(),
  stickToBottom: true,
  seqMap: new Map<number, SessionEvent>(),
  graph: buildTraceGraph('', []),
  expandedActivityIds: new Set<string>(),
  traceLoadRevision: 0,
  liveTurnCounter: 0,
  liveToolMeta: new Map<string, LiveToolMeta>(),
  traceCatchupTimer: undefined as number | undefined,
  traceCatchupAttempts: 0,
}

function t(key: I18nKey): string {
  return translate(state.locale, key)
}

const appEl = document.querySelector<HTMLElement>('#app')

/* ── Static shell: built once; regions are patched in place afterwards ────── */

interface ShellRefs {
  sessionList: HTMLElement
  searchInput: HTMLInputElement
  footerRepo: HTMLElement
  footerRuntime: HTMLElement
  runtimeDot: HTMLElement
  topbarTitle: HTMLElement
  revealButton: HTMLButtonElement
  errorNotice: HTMLElement
  chatView: HTMLElement
  conversation: HTMLElement
  liveTurn: HTMLElement
  liveJump: HTMLButtonElement
  trajTree: HTMLElement
  trajectory: HTMLElement
  trajMain: HTMLElement
  waterfall: HTMLElement
  devCanvas: HTMLElement
  sessionCanvas: HTMLElement
  composerForm: HTMLFormElement
  composerInput: HTMLTextAreaElement
  composerHint: HTMLElement
  sendButton: HTMLButtonElement
  cancelButton: HTMLButtonElement
  inspector: HTMLElement
  inspectorKind: HTMLElement
  inspectorTitle: HTMLElement
  inspectorSubtitle: HTMLElement
  inspectorTabs: HTMLElement
  inspectorBody: HTMLElement
  toast: HTMLElement
}

let el: ShellRefs

function buildShell(): void {
  if (appEl === null) return
  appEl.innerHTML = `
    <div class="harness-shell" id="shell">
      <aside class="source-list">
        <header class="app-brand">
          <button class="brand-title" data-module="sessions">DeepSeek Harness</button>
          <span class="runtime-dot starting" id="runtimeDot" aria-hidden="true"></span>
        </header>
        <section class="primary-actions">
          <button class="primary-action" data-action="new-session"><span data-text="app.newChat"></span><kbd>⌘N</kbd></button>
        </section>
        <nav class="product-nav" aria-label="DeepSeek Harness modules">
          <button class="module-button selected" data-module="sessions" data-title="app.sessionsSubtitle"><strong data-text="app.sessions"></strong></button>
          <button class="module-button" data-module="develop" data-title="app.developSubtitle"><strong data-text="app.develop"></strong></button>
        </nav>
        <label class="session-search">
          <span data-text="app.sessions"></span>
          <input id="sessionSearch" type="search" />
        </label>
        <section class="session-group">
          <div class="group-title" data-text="app.recentSessions"></div>
          <div class="session-list" id="sessionList"></div>
        </section>
        <footer class="source-footer">
          <span id="footerRepo"></span>
          <strong id="footerRuntime"></strong>
        </footer>
      </aside>
      <div class="pane-divider" id="dividerLeft" role="separator" aria-orientation="vertical" data-label="app.resizeSidebar"></div>
      <main class="harness-main">
        <header class="topbar">
          <div class="title-area"><h1 id="topbarTitle"></h1></div>
          <nav class="surface-switcher" id="surfaceSwitcher" aria-label="Session surfaces">
            ${SESSION_SURFACES.map(surface => `<button class="${surface === 'chat' ? 'active' : ''}" data-surface="${surface}" data-text="surface.${surface}"></button>`).join('')}
          </nav>
          <div class="toolbar-actions">
            <button class="reveal-button" id="revealButton" data-action="reveal-session" type="button" data-text="app.revealSession" hidden></button>
            <button class="language-toggle" data-action="toggle-locale" type="button" data-text="app.language"></button>
          </div>
        </header>
        <div class="notice" id="errorNotice" hidden></div>
        <section class="session-canvas" id="sessionCanvas">
          <section class="view chat-view active" id="chatView">
            <div class="chat-surface conversation">
              <div id="conversation"></div>
              <div id="liveTurn"></div>
            </div>
            <button class="chat-live-jump" id="liveJump" type="button" hidden data-text="chat.jumpToLive"></button>
          </section>
          <section class="view traj-view" id="trajView">
            <div class="traj-split">
              <nav class="traj-tree" id="trajTree" aria-label="Session structure"></nav>
              <div class="traj-main" id="trajMain">
                <div class="trajectory-toolbar">
                  <span data-text="trace.title"></span>
                  <div>
                    <button data-action="expand-traj" data-text="trace.expandAll"></button>
                    <button data-action="collapse-traj" data-text="trace.collapse"></button>
                  </div>
                </div>
                <div class="trajectory-table" id="trajectory"></div>
              </div>
            </div>
          </section>
          <section class="view wf-view" id="wfView">
            <div class="waterfall-surface" id="waterfall"></div>
          </section>
        </section>
        <section class="module-canvas develop-canvas" id="devCanvas" hidden></section>
        <form class="composer" id="composerForm">
          <textarea id="composerInput" name="prompt" rows="1"></textarea>
          <div class="composer-meta">
            <span class="composer-hint" id="composerHint"></span>
            <button type="button" class="cancel-button" id="cancelButton" hidden data-text="chat.cancel"></button>
            <button type="submit" class="send-button" id="sendButton" disabled>↑</button>
          </div>
        </form>
      </main>
      <div class="pane-divider" id="dividerInspector" role="separator" aria-orientation="vertical" hidden data-label="app.resizeInspector"></div>
      <aside class="inspector" id="inspector" hidden>
        <header class="inspector-head">
          <div>
            <span id="inspectorKind"></span>
            <strong id="inspectorTitle"></strong>
            <small id="inspectorSubtitle"></small>
          </div>
          <div class="inspector-head-actions">
            <button data-action="jump-traj" data-text="inspector.jumpTraj" type="button"></button>
            <button data-action="close-inspector" data-text="inspector.close" type="button"></button>
          </div>
        </header>
        <nav class="inspector-tabs" id="inspectorTabs">
          ${INSPECTOR_TABS.map(tab => `<button class="${tab === 'input' ? 'active' : ''}" data-inspector-tab="${tab}" data-text="inspector.${tab}"></button>`).join('')}
        </nav>
        <section class="inspector-body" id="inspectorBody"></section>
      </aside>
    </div>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  `
  const pick = (id: string): HTMLElement => appEl.querySelector<HTMLElement>(`#${id}`)!
  el = {
    sessionList: pick('sessionList'),
    searchInput: pick('sessionSearch') as HTMLInputElement,
    footerRepo: pick('footerRepo'),
    footerRuntime: pick('footerRuntime'),
    runtimeDot: pick('runtimeDot'),
    topbarTitle: pick('topbarTitle'),
    revealButton: pick('revealButton') as HTMLButtonElement,
    errorNotice: pick('errorNotice'),
    chatView: pick('chatView'),
    conversation: pick('conversation'),
    liveTurn: pick('liveTurn'),
    liveJump: pick('liveJump') as HTMLButtonElement,
    trajTree: pick('trajTree'),
    trajectory: pick('trajectory'),
    trajMain: pick('trajMain'),
    waterfall: pick('waterfall'),
    devCanvas: pick('devCanvas'),
    sessionCanvas: pick('sessionCanvas'),
    composerForm: pick('composerForm') as HTMLFormElement,
    composerInput: pick('composerInput') as HTMLTextAreaElement,
    composerHint: pick('composerHint'),
    sendButton: pick('sendButton') as HTMLButtonElement,
    cancelButton: pick('cancelButton') as HTMLButtonElement,
    inspector: pick('inspector'),
    inspectorKind: pick('inspectorKind'),
    inspectorTitle: pick('inspectorTitle'),
    inspectorSubtitle: pick('inspectorSubtitle'),
    inspectorTabs: pick('inspectorTabs'),
    inspectorBody: pick('inspectorBody'),
    toast: pick('toast'),
  }
}

/** Re-applies locale-dependent text to the static chrome (elements are never rebuilt). */
function applyStaticText(): void {
  if (appEl === null) return
  for (const node of appEl.querySelectorAll<HTMLElement>('[data-text]')) {
    node.textContent = t(node.dataset.text as I18nKey)
  }
  for (const node of appEl.querySelectorAll<HTMLElement>('[data-title]')) {
    node.title = t(node.dataset.title as I18nKey)
  }
  for (const node of appEl.querySelectorAll<HTMLElement>('[data-label]')) {
    node.setAttribute('aria-label', t(node.dataset.label as I18nKey))
  }
  document.documentElement.lang = state.locale
  el.searchInput.placeholder = t('app.searchPlaceholder')
  el.composerInput.placeholder = state.selectedSessionId === undefined
    ? t('composer.placeholderDraft')
    : t('composer.placeholderSession')
  el.sendButton.setAttribute('aria-label', t('composer.send'))
  el.composerInput.setAttribute('aria-label', t('composer.send'))
  updateComposerState()
}

function toast(text: string): void {
  el.toast.textContent = text
  el.toast.classList.add('show')
  window.setTimeout(() => {
    el.toast.classList.remove('show')
  }, 1600)
}

function showError(message: string): void {
  state.error = message
  el.errorNotice.hidden = message.length === 0
  el.errorNotice.textContent = message
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

void boot()

async function boot(): Promise<void> {
  buildShell()
  applyStaticText()
  wireStaticEvents()
  initPaneResizers()
  renderFooter()
  if (!hasDesktopApi()) {
    showError(`${t('error.noDesktopApi')} pnpm --dir packages/ui/desktop run dev`)
    renderSessionList()
    renderTopbar()
    return
  }
  window.dshDesktop.runtime.onStatus((payload) => {
    state.runtime = payload
    renderFooter()
    if (state.activeModule === 'develop') renderDevelop()
  })
  window.dshDesktop.runtime.onStderr(() => {
    // stderr is diagnostic-only; the Develop panel re-reads it on demand.
  })
  window.dshDesktop.sessions.onUpdate((payload) => {
    handleSessionUpdate(asSessionUpdate(payload))
  })
  await Promise.all([refreshRuntime(), refreshDevStatus()])
  await refreshSessions()
}

async function refreshRuntime(): Promise<void> {
  try {
    state.runtime = await window.dshDesktop.runtime.status()
  } catch (error) {
    showError(String(error))
  }
  renderFooter()
}

async function refreshDevStatus(): Promise<void> {
  try {
    state.dev = await window.dshDesktop.dev.status()
  } catch {
    state.dev = undefined
  }
}

async function refreshSessions(preferredId?: string): Promise<void> {
  try {
    const result = asRecord(await window.dshDesktop.sessions.list())
    const sessions = Array.isArray(result.sessions) ? result.sessions as SessionSummary[] : []
    state.sessions = sessions.map((session) => {
      const pendingTitle = state.pendingSessionTitles.get(session.id)
      if (pendingTitle === undefined || session.eventCount > 0) return session
      return { ...session, title: pendingTitle }
    })
    renderSessionList()
    const id = preferredId ?? state.selectedSessionId ?? (state.draftChat ? undefined : state.sessions[0]?.id)
    if (id !== undefined && id !== state.selectedSessionId) {
      await loadTrace(id)
    } else if (id !== undefined) {
      state.selectedSessionId = id
      renderSessionList()
      renderTopbar()
    } else {
      // First boot with no sessions: show the empty-state guide, not a blank pane.
      renderConversation()
    }
  } catch (error) {
    showError(String(error))
  }
}

async function loadTrace(sessionId: string, resetExpansion = true): Promise<void> {
  captureFeedbackDraft()
  const revision = ++state.traceLoadRevision
  state.selectedSessionId = sessionId
  state.draftChat = false
  let trace: TracePayload
  try {
    trace = asRecord(await window.dshDesktop.trace.read(sessionId)) as unknown as TracePayload
  } catch (error) {
    if (revision !== state.traceLoadRevision || state.selectedSessionId !== sessionId) return
    trace = { found: false, sessionId, header: { id: sessionId }, events: [], rawText: '', feedback: [] }
    showError(String(error))
  }
  if (revision !== state.traceLoadRevision || state.selectedSessionId !== sessionId) return
  applyTrace(trace, resetExpansion)
}

function applyTrace(trace: TracePayload, resetExpansion: boolean): void {
  state.trace = trace
  const sessionId = trace.sessionId
  const live = state.live.get(sessionId)
  if (state.busySessionId !== sessionId && live !== undefined && completedTurnCount(trace) >= live.expectedCompletedTurns) {
    state.live.delete(sessionId)
  }
  if (resetExpansion) {
    state.expandedTrajectoryIds = new Set()
    state.annotateOpenIds = new Set()
  }
  updateSessionSummaryFromTrace(trace)
  rebuildTraceIndexes()
  if (state.selectedTargetId !== undefined && !state.graph.targets.has(state.selectedTargetId)) closeInspector()
  renderSessionList()
  renderTopbar()
  renderConversation()
  renderLiveTurn()
  renderTrajectory()
  renderTrajTree()
  renderWaterfall()
  renderInspector()
  scrollChatToBottom(resetExpansion)
  scheduleTraceCatchup(sessionId)
}

/**
 * Persisted JSONL can lag a finished turn (the runtime flushes asynchronously),
 * which leaves the live turn on screen next to a stale conversation. Poll the
 * trace briefly until the expected turn lands instead of waiting for a user
 * action to trigger the next read.
 */
function scheduleTraceCatchup(sessionId: string): void {
  if (state.traceCatchupTimer !== undefined) {
    window.clearTimeout(state.traceCatchupTimer)
    state.traceCatchupTimer = undefined
  }
  const live = state.live.get(sessionId)
  if (live === undefined || state.busySessionId !== undefined || live.status === 'error') {
    state.traceCatchupAttempts = 0
    return
  }
  if (state.traceCatchupAttempts >= 12) return
  state.traceCatchupAttempts += 1
  state.traceCatchupTimer = window.setTimeout(() => {
    state.traceCatchupTimer = undefined
    if (state.selectedSessionId !== sessionId || state.busySessionId !== undefined) return
    void loadTrace(sessionId, false)
  }, 500)
}

function updateSessionSummaryFromTrace(trace: TracePayload): void {
  const events = trace.events
  const index = state.sessions.findIndex(session => session.id === trace.sessionId)
  if (index < 0) return
  const firstUser = events.find(event => event.type === 'user/message')
  const title = contentText(asRecord(firstUser?.data).content).slice(0, 120)
  const lastActivity = [...events].reverse().find(event => typeof event.time === 'number')?.time
  const current = state.sessions[index]!
  state.sessions[index] = {
    ...current,
    ...(title.length > 0 ? { title } : {}),
    ...(lastActivity === undefined ? {} : { lastActivity }),
    eventCount: events.length,
    turnCount: events.filter(event => event.type === 'turn/start').length,
    stepCount: events.filter(event => event.type === 'step/start').length,
    toolCallCount: events.filter(event => event.type === 'tool/call').length,
  }
}

function rebuildTraceIndexes(): void {
  const events = state.trace?.events ?? []
  state.graph = buildTraceGraph(state.trace?.sessionId ?? '', events)
  state.seqMap = new Map()
  for (const event of events) {
    if (event.seq !== undefined) state.seqMap.set(event.seq, event)
  }
}

function completedTurnCount(trace: TracePayload | undefined): number {
  return (trace?.events ?? []).filter(event => event.type === 'turn/end').length
}

/* ── Live streaming: patch-only updates, never a full re-render ───────────── */

function handleSessionUpdate(payload: SessionUpdatePayload): void {
  const update = payload.update
  const kind = String(update.sessionUpdate ?? '')
  const live = state.live.get(payload.sessionId) ?? { key: ++state.liveTurnCounter, thinking: '', answer: '', tools: [], expectedCompletedTurns: completedTurnCount(state.trace) + 1, status: 'streaming' as const }
  if (kind === 'agent_message_chunk') {
    live.answer += contentText(update.content)
    live.status = 'streaming'
  } else if (kind === 'agent_thought_chunk') {
    live.thinking += contentText(update.content)
    live.status = 'streaming'
  } else if (kind === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : []
    live.plan = entries.map((entry): PlanItem => ({ content: String(asRecord(entry).content ?? ''), status: String(asRecord(entry).status ?? 'pending') }))
    live.status = 'streaming'
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    const callId = String(update.toolCallId ?? `tool-${live.tools.length}`)
    const meta = state.liveToolMeta.get(callId) ?? {}
    if (typeof update.title === 'string' && update.title.length > 0) meta.title = update.title
    if (typeof update.kind === 'string' && update.kind.length > 0) meta.kind = update.kind
    if (Array.isArray(update.locations)) meta.locations = update.locations.map(location => ({ path: String(asRecord(location).path ?? ''), ...(asRecord(location).line === undefined ? {} : { line: Number(asRecord(location).line) }) }))
    state.liveToolMeta.set(callId, meta)
    const existing = live.tools.find(tool => tool.callId === callId)
    const title = String(update.title ?? existing?.title ?? t('chat.toolUse'))
    const status = String(update.status ?? existing?.status ?? '')
    const detail = update.rawInput === undefined ? existing?.detail ?? '' : renderValue(update.rawInput)
    if (existing === undefined) live.tools.push({ callId, title, status, detail })
    else Object.assign(existing, { title, status, detail })
    live.status = 'streaming'
  } else if (kind === 'user_message_chunk') {
    if (live.userText === undefined) live.userText = contentText(update.content)
  } else {
    return
  }
  state.live.set(payload.sessionId, live)
  if (payload.sessionId === state.selectedSessionId || (state.selectedSessionId === undefined && state.draftChat)) {
    renderLiveTurn()
    scrollChatToBottom()
  }
}

function currentLiveTurn(): LiveTurn | undefined {
  return state.live.get(state.selectedSessionId ?? DRAFT_SESSION_ID)
}

/** Rebuild-or-patch the live turn region. Structure is keyed so streaming text updates touch text nodes only. */
function renderLiveTurn(): void {
  const live = currentLiveTurn()
  if (live === undefined) {
    el.liveTurn.innerHTML = ''
    updateLiveJump()
    return
  }
  ensureLiveSkeleton(live)
  const thinking = el.liveTurn.querySelector<HTMLElement>('[data-live="thinking"]')
  if (thinking !== null) {
    thinking.hidden = live.thinking.length === 0
    const summaryText = thinking.querySelector<HTMLElement>('summary strong')
    if (summaryText !== null) summaryText.textContent = truncate(live.thinking, 112)
    const body = thinking.querySelector<HTMLElement>('.activity-body')
    if (body !== null) body.textContent = live.thinking
  }
  for (const tool of live.tools) {
    const row = el.liveTurn.querySelector<HTMLElement>(`[data-live-call="${CSS.escape(tool.callId)}"]`)
    if (row === null) continue
    const label = row.querySelector<HTMLElement>('summary strong')
    if (label !== null) label.textContent = tool.title
    const statusEl = row.querySelector<HTMLElement>('summary span')
    if (statusEl !== null) statusEl.textContent = tool.status === 'failed' ? t('chat.toolFailed') : t('chat.toolUse')
    const body = row.querySelector<HTMLElement>('.activity-body pre')
    if (body !== null) body.textContent = tool.detail
    row.classList.toggle('failed', tool.status === 'failed')
  }
  const planHost = el.liveTurn.querySelector<HTMLElement>('[data-live="plan"]')
  if (planHost !== null) {
    planHost.hidden = live.plan === undefined || live.plan.length === 0
    planHost.innerHTML = live.plan === undefined ? '' : renderPlanList(live.plan)
  }
  const answer = el.liveTurn.querySelector<HTMLElement>('[data-live="answer"]')
  if (answer !== null) {
    answer.hidden = live.answer.length === 0
    answer.innerHTML = renderMarkdown(live.answer)
  }
  const status = el.liveTurn.querySelector<HTMLElement>('[data-live="status"]')
  if (status !== null) {
    status.hidden = live.status !== 'sending' && live.status !== 'streaming' && live.errorText === undefined
    status.textContent = live.errorText ?? (live.status === 'sending' ? t('chat.sending') : t('chat.working'))
    status.classList.toggle('error', live.errorText !== undefined)
  }
  updateLiveJump()
}

/** Creates the live turn DOM skeleton when the turn starts or a new tool appears. */
function ensureLiveSkeleton(live: LiveTurn): void {
  el.conversation.querySelector('.empty-thread')?.remove()
  let root = el.liveTurn.querySelector<HTMLElement>('.message.live')
  // A stale skeleton from an earlier turn (persisted trace still lagging) must
  // never be patched with the new turn's content — its user bubble would keep
  // showing the previous prompt.
  if (root !== null && root.dataset.liveKey !== String(live.key)) {
    el.liveTurn.innerHTML = ''
    root = null
  }
  if (root === null) {
    el.liveTurn.innerHTML = `
      ${live.userText === undefined ? '' : `
        <article class="message user">
          <div class="message-card"><div class="user-bubble">${escapeHtml(live.userText)}</div></div>
        </article>
      `}
      <article class="message assistant live" data-live-key="${live.key}">
        <div class="avatar">A</div>
        <div class="message-card">
          <div class="plan-host" data-live="plan" hidden></div>
          <div class="activity-list">
            <details class="chat-activity thinking" data-live="thinking" hidden>
              <summary><span>${escapeHtml(t('chat.thinking'))}</span><strong></strong></summary>
              <div class="activity-body"></div>
            </details>
            <div data-live="tools"></div>
          </div>
          <div class="assistant-prose" data-live="answer" hidden></div>
          <div class="live-status" role="status" data-live="status">${escapeHtml(t('chat.sending'))}</div>
        </div>
      </article>
    `
    root = el.liveTurn.querySelector<HTMLElement>('.message.live')
  }
  const toolHost = root?.querySelector<HTMLElement>('[data-live="tools"]')
  if (toolHost === undefined || toolHost === null) return
  for (const tool of live.tools) {
    if (toolHost.querySelector(`[data-live-call="${CSS.escape(tool.callId)}"]`) !== null) continue
    const details = document.createElement('details')
    details.className = 'chat-activity tool-use'
    details.dataset.liveCall = tool.callId
    details.innerHTML = '<summary><span></span><strong></strong></summary><div class="activity-body"><pre></pre></div>'
    toolHost.appendChild(details)
  }
}

let scrollToBottomQueued = false

/** Direct user actions scroll immediately; streaming updates coalesce per frame. */
function scrollChatToBottom(force = false): void {
  if (force) {
    scrollToBottomQueued = false
    el.chatView.scrollTop = el.chatView.scrollHeight
    state.stickToBottom = true
    updateLiveJump()
    return
  }
  if (!state.stickToBottom || scrollToBottomQueued) return
  scrollToBottomQueued = true
  window.requestAnimationFrame(() => {
    if (!scrollToBottomQueued) return
    scrollToBottomQueued = false
    el.chatView.scrollTop = el.chatView.scrollHeight
    state.stickToBottom = true
    updateLiveJump()
  })
}

function updateLiveJump(): void {
  const live = currentLiveTurn()
  el.liveJump.hidden = live === undefined || state.stickToBottom
}

/* ── Composer: element is never rebuilt, so typing is never lost ──────────── */

function updateComposerState(): void {
  const busy = state.busySessionId !== undefined
  el.sendButton.disabled = busy || !hasDesktopApi() || el.composerInput.value.trim().length === 0
  el.cancelButton.hidden = !busy
  el.composerHint.textContent = busy ? t('chat.working') : t('composer.hint')
  el.composerForm.classList.toggle('busy', busy)
  el.composerForm.setAttribute('aria-busy', String(busy))
}

async function sendPrompt(prompt: string): Promise<void> {
  if (!hasDesktopApi()) {
    showError(t('error.noDesktopApi'))
    return
  }
  const draftKey = state.selectedSessionId ?? DRAFT_SESSION_ID
  state.live.set(draftKey, {
    key: ++state.liveTurnCounter,
    userText: prompt,
    thinking: '',
    answer: '',
    tools: [],
    expectedCompletedTurns: completedTurnCount(state.trace) + 1,
    status: 'sending',
  })
  state.busySessionId = draftKey
  el.composerInput.value = ''
  updateComposerState()
  showError('')
  renderLiveTurn()
  scrollChatToBottom(true)
  el.composerInput.focus()

  let sessionId = state.selectedSessionId
  try {
    if (sessionId === undefined) {
      const created = asRecord(await window.dshDesktop.sessions.create())
      sessionId = String(created.sessionId)
      const live = state.live.get(DRAFT_SESSION_ID)
      state.live.delete(DRAFT_SESSION_ID)
      if (live !== undefined) state.live.set(sessionId, live)
      state.selectedSessionId = sessionId
      state.draftChat = false
      state.busySessionId = sessionId
      ensureSessionListed(sessionId, prompt)
    }
    state.pendingSessionTitles.set(sessionId, prompt)
    renderSessionList()
    renderTopbar()
    const result = asRecord(await window.dshDesktop.sessions.prompt(sessionId, prompt))
    const returnedTrace = asRecord(result.trace) as unknown as TracePayload
    const completedLive = state.live.get(sessionId)
    if (completedLive !== undefined) completedLive.status = 'complete'
    state.busySessionId = undefined
    updateComposerState()
    if (state.selectedSessionId === sessionId) renderLiveTurn()
    await refreshSessions()
    if (state.selectedSessionId === sessionId && returnedTrace.sessionId === sessionId && completedTurnCount(returnedTrace) >= (completedLive?.expectedCompletedTurns ?? 1)) {
      applyTrace(returnedTrace, false)
    } else if (state.selectedSessionId === sessionId) {
      await loadTrace(sessionId)
    }
    else state.live.delete(sessionId)
  } catch (error) {
    state.busySessionId = undefined
    const live = sessionId === undefined ? state.live.get(DRAFT_SESSION_ID) : state.live.get(sessionId)
    if (live !== undefined) {
      live.status = 'error'
      live.errorText = `${t('chat.sendFailed')}: ${String(error)}`
      if (state.selectedSessionId === sessionId || (sessionId === undefined && state.draftChat)) renderLiveTurn()
    }
    showError(String(error))
    if ((state.selectedSessionId === sessionId || (sessionId === undefined && state.draftChat)) && el.composerInput.value.trim().length === 0) {
      el.composerInput.value = prompt
    }
    updateComposerState()
  } finally {
    el.composerInput.focus()
  }
}

/** Makes a just-created session visible in the sidebar before the next full refresh. */
function ensureSessionListed(sessionId: string, title: string): void {
  if (state.sessions.some(session => session.id === sessionId)) return
  state.sessions = [{
    id: sessionId,
    title,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    eventCount: 0,
    turnCount: 0,
    stepCount: 0,
    toolCallCount: 0,
    live: true,
  }, ...state.sessions]
}

async function cancelActiveTurn(): Promise<void> {
  const sessionId = state.busySessionId
  if (sessionId === undefined || sessionId === DRAFT_SESSION_ID || !hasDesktopApi()) return
  try {
    await window.dshDesktop.sessions.cancel(sessionId)
    toast(t('chat.cancelRequested'))
  } catch (error) {
    showError(String(error))
  }
}

/* ── Sidebar ──────────────────────────────────────────────────────────────── */

function filteredSessions(): SessionSummary[] {
  const query = state.query.trim().toLowerCase()
  if (query.length === 0) return state.sessions
  return state.sessions.filter(session => [session.id, session.title, session.cwd ?? '', session.relativePath ?? '', session.model ?? ''].join('\n').toLowerCase().includes(query))
}

function renderSessionList(): void {
  const matches = new Set(filteredSessions().map(session => session.id))
  const ids = new Set(state.sessions.map(session => session.id))
  const children = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const session of state.sessions) {
    if (session.parentSession !== undefined && ids.has(session.parentSession)) {
      const siblings = children.get(session.parentSession) ?? []
      siblings.push(session)
      children.set(session.parentSession, siblings)
    } else {
      roots.push(session)
    }
  }
  const rows: string[] = []
  for (const root of roots) {
    const nested = (children.get(root.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)
    const matchingChildren = nested.filter(session => matches.has(session.id))
    if (!matches.has(root.id) && matchingChildren.length === 0) continue
    rows.push(renderSessionItem(root, false, nested.length))
    const visibleChildren = matches.has(root.id) ? nested : matchingChildren
    rows.push(...visibleChildren.map(session => renderSessionItem(session, true, 0)))
    if (rows.length >= 40) break
  }
  el.sessionList.innerHTML = rows.join('') || `<div class="empty-list">${escapeHtml(t('app.emptySessions'))}</div>`
}

function renderSessionItem(session: SessionSummary, child: boolean, childCount: number): string {
  return `
    <button class="session-item ${child ? 'child' : ''} ${session.id === state.selectedSessionId ? 'selected' : ''}" data-session="${escapeHtml(session.id)}">
      <span class="session-glyph">${child ? '↳' : session.id === state.busySessionId ? '●' : '○'}</span>
      <span class="session-copy">
        <strong>${escapeHtml(session.title || shortId(session.id))}</strong>
        <small>${session.turnCount} ${t('metric.turns')} · ${session.toolCallCount} ${t('metric.tools')}${childCount > 0 ? ` · ${childCount} ${t('app.subagents')}` : ''} · ${escapeHtml(formatRelativeTime(session.lastActivity))}</small>
      </span>
    </button>
  `
}

function renderFooter(): void {
  el.footerRepo.textContent = shortPath(runtimeRepoRoot())
  el.footerRuntime.textContent = runtimeLabel()
  el.runtimeDot.className = `runtime-dot ${runtimeStateClass()}`
}

function renderTopbar(): void {
  const session = state.sessions.find(item => item.id === state.selectedSessionId)
  const parentTitle = state.trace?.parent?.title
  el.topbarTitle.textContent = state.activeModule === 'develop'
    ? t('app.develop')
    : [parentTitle, session?.title || state.pendingSessionTitles.get(state.selectedSessionId ?? '') || t('app.sessions')].filter(Boolean).join(' / ')
  document.querySelector<HTMLElement>('#surfaceSwitcher')?.toggleAttribute('hidden', state.activeModule !== 'sessions')
  el.revealButton.hidden = state.activeModule !== 'sessions' || state.trace?.found !== true
  el.composerInput.placeholder = state.selectedSessionId === undefined
    ? t('composer.placeholderDraft')
    : t('composer.placeholderSession')
}

/* ── Module and surface switching: views stay mounted, so scroll survives ─── */

function showModule(module: AppModule): void {
  state.activeModule = module
  for (const button of document.querySelectorAll<HTMLElement>('[data-module]')) {
    button.classList.toggle('selected', button.dataset.module === module && button.classList.contains('module-button'))
  }
  el.sessionCanvas.hidden = module !== 'sessions'
  el.devCanvas.hidden = module !== 'develop'
  el.composerForm.hidden = module !== 'sessions'
  if (module === 'develop') renderDevelop()
  renderTopbar()
}

function showSurface(surface: SessionSurface): void {
  state.activeSurface = surface
  for (const button of document.querySelectorAll<HTMLElement>('[data-surface]')) {
    button.classList.toggle('active', button.dataset.surface === surface)
  }
  el.chatView.classList.toggle('active', surface === 'chat')
  document.querySelector('#trajView')?.classList.toggle('active', surface === 'trajectory')
  document.querySelector('#wfView')?.classList.toggle('active', surface === 'waterfall')
  if (surface !== 'chat' && state.selectedSessionId !== undefined && state.busySessionId !== state.selectedSessionId) {
    void loadTrace(state.selectedSessionId)
  }
}

/* ── Chat (persisted conversation) ────────────────────────────────────────── */

function renderConversation(): void {
  const turns = state.graph.chatTurns
  if (turns.length === 0) {
    el.conversation.innerHTML = currentLiveTurn() === undefined
      ? `<div class="empty-thread"><h2>${escapeHtml(t('chat.emptyTitle'))}</h2><p>${escapeHtml(t('chat.emptyBody'))}</p></div>`
      : ''
    return
  }
  el.conversation.innerHTML = turns.map(renderConversationTurn).join('')
  updateSelectionHighlight()
}

function renderConversationTurn(turn: ChatTurn): string {
  const userTarget = turn.userTargetId === undefined ? undefined : state.graph.targets.get(turn.userTargetId)
  const user = userTarget === undefined ? '' : `
    <article class="message user ${selectedTargetClass(userTarget.id)}" role="button" tabindex="0" data-target-id="${escapeHtml(userTarget.id)}">
      <div class="message-card"><div class="user-bubble">${escapeHtml(contentText(userTarget.output))}</div></div>
    </article>
  `
  if (turn.activities.length === 0) return user
  return `${user}
    <article class="message assistant">
      <div class="avatar">A</div>
      <div class="message-card"><div class="activity-list">${turn.activities.map(renderConversationActivity).join('')}</div></div>
    </article>
  `
}

function renderConversationActivity(activity: ChatActivity): string {
  const target = state.graph.targets.get(activity.targetId)
  if (target === undefined) return ''
  if (activity.kind === 'tool') return renderChatToolActivity(target)
  if (activity.kind === 'plan') {
    return `<section class="plan-activity ${selectedTargetClass(target.id)}" data-target-id="${escapeHtml(target.id)}">${renderPlanList(planItemsOf(target))}</section>`
  }
  if (activity.kind === 'text') {
    return `<section class="assistant-prose assistant-segment ${selectedTargetClass(target.id)}" data-target-id="${escapeHtml(target.id)}">${renderMarkdown(assistantText(target.output) || contentText(target.output))}</section>`
  }
  const expanded = state.expandedActivityIds.has(target.id)
  return `
    <section class="chat-activity thinking ${selectedTargetClass(target.id)}">
      <div class="activity-row">
        <button class="activity-select" type="button" data-target-id="${escapeHtml(target.id)}"><span>${escapeHtml(t('chat.thinking'))}</span><strong>${escapeHtml(truncate(contentText(target.output), 112))}</strong></button>
        <button class="activity-toggle" type="button" data-toggle-activity="${escapeHtml(target.id)}" aria-expanded="${expanded}" aria-controls="act-${escapeHtml(target.id)}" aria-label="${escapeHtml(t(expanded ? 'trace.collapseRow' : 'trace.expandRow'))}">${expanded ? '⌃' : '⌄'}</button>
      </div>
      <div class="activity-body" id="act-${escapeHtml(target.id)}" ${expanded ? '' : 'hidden'} data-target-id="${escapeHtml(target.id)}"><div>${escapeHtml(contentText(target.output))}</div></div>
    </section>
  `
}

/** One checklist card shared by the live turn and the persisted transcript. */
function renderPlanList(items: readonly PlanItem[]): string {
  const done = items.filter(item => item.status === 'completed').length
  const glyph = (status: string): string => status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○'
  return `
    <section class="plan-card">
      <header><strong>${escapeHtml(t('chat.planList'))}</strong><span>${done}/${items.length}</span></header>
      <ul>
        ${items.map(item => `<li class="plan-item ${escapeHtml(item.status)}"><span class="plan-glyph">${glyph(item.status)}</span><span>${escapeHtml(item.content)}</span></li>`).join('')}
      </ul>
    </section>
  `
}

function planItemsOf(target: TraceTarget): PlanItem[] {
  return (Array.isArray(target.output) ? target.output : []).map(item => ({ content: String(asRecord(item).content ?? ''), status: String(asRecord(item).status ?? 'pending') }))
}

/** ACP streams richer tool titles than the persisted name; keep them after the turn. */
function liveToolMetaOf(target: TraceTarget): LiveToolMeta {
  return state.liveToolMeta.get(target.id.replace(/^tool:/, '')) ?? {}
}

function liveToolTitle(target: TraceTarget): string | undefined {
  return liveToolMetaOf(target).title
}

/** Verb label for a tool row: the streamed ACP kind beats the generic noun. */
function toolVerbLabel(target: TraceTarget): string {
  const kind = liveToolMetaOf(target).kind
  if (kind === 'read') return t('kind.verb.read')
  if (kind === 'edit') return t('kind.verb.edit')
  if (kind === 'delete') return t('kind.verb.delete')
  if (kind === 'move') return t('kind.verb.move')
  if (kind === 'search') return t('kind.verb.search')
  if (kind === 'execute') return t('kind.verb.execute')
  if (kind === 'fetch') return t('kind.verb.fetch')
  if (kind === 'think') return t('kind.verb.think')
  return t('chat.toolUse')
}

function renderChatToolActivity(target: TraceTarget): string {
  const failed = target.status === 'error'
  const richTitle = liveToolTitle(target)
  const preview = richTitle === undefined ? toolCallPreview(target.input) : ''
  const expanded = state.expandedActivityIds.has(target.id)
  const inputHtml = `<div class="activity-section-title">${escapeHtml(t('chat.input'))}</div><pre>${escapeHtml(formatPayload(target.input, 'json'))}</pre>`
  const outputHtml = target.output === '' ? '' : `<div class="activity-section-title">${escapeHtml(failed ? t('chat.errorOutput') : t('chat.output'))}</div><pre>${escapeHtml(formatPayload(target.output, 'plain'))}</pre>`
  const callEvent = target.eventSeqs.map(seq => state.seqMap.get(seq)).find(event => event?.type === 'tool/call')
  const spawnedHtml = callEvent === undefined ? '' : renderSpawnedSessions(callEvent)
  return `
    <section class="chat-activity tool-use ${failed ? 'failed' : ''} ${selectedTargetClass(target.id)}">
      <div class="activity-row">
        <button class="activity-select" type="button" data-target-id="${escapeHtml(target.id)}"><span>${escapeHtml(failed ? t('chat.toolFailed') : toolVerbLabel(target))}</span><strong>${escapeHtml(richTitle ?? target.title)}${preview.length > 0 ? `<span class="activity-preview"> · ${escapeHtml(preview)}</span>` : ''}</strong></button>
        <button class="activity-toggle" type="button" data-toggle-activity="${escapeHtml(target.id)}" aria-expanded="${expanded}" aria-controls="act-${escapeHtml(target.id)}" aria-label="${escapeHtml(t(expanded ? 'trace.collapseRow' : 'trace.expandRow'))}">${expanded ? '⌃' : '⌄'}</button>
      </div>
      <div class="activity-body" id="act-${escapeHtml(target.id)}" ${expanded ? '' : 'hidden'} data-target-id="${escapeHtml(target.id)}">${inputHtml}${outputHtml}${toolLocationsHtml(target)}${spawnedHtml}</div>
    </section>
  `
}

function renderSpawnedSessions(event: SessionEvent): string {
  const spawned = spawnedSessionsFor(event)
  if (spawned.length === 0) return ''
  return `
    <section class="spawn-list">
      <strong>${escapeHtml(t('chat.spawnedSessions'))} · ${spawned.length}</strong>
      ${spawned.map(session => `
        <button class="spawn-link" type="button" data-session="${escapeHtml(session.id)}">
          <span>↳</span>
          <span>${escapeHtml(truncate(session.title || session.id, 72))}</span>
          <small>${session.stepCount} ${escapeHtml(t('metric.steps'))} · ${session.toolCallCount} ${escapeHtml(t('metric.tools'))}</small>
        </button>
      `).join('')}
    </section>
  `
}

function spawnedSessionsFor(event: SessionEvent): SessionSummary[] {
  if (event.type !== 'tool/call') return []
  const tool = state.graph.targets.get(`tool:${String(asRecord(event.data).callId ?? '')}`)
  const result = asRecord(tool?.metadata).result as SessionEvent | undefined
  const start = (event.time ?? 0) - 2000
  const end = (result?.time ?? (event.time ?? 0) + 600_000) + 2000
  return (state.trace?.children ?? []).filter(session => session.createdAt >= start && session.createdAt <= end)
}

/** Touched files streamed on the ACP call; each opens in the OS editor. */
function toolLocationsHtml(target: TraceTarget): string {
  const locations = liveToolMetaOf(target).locations ?? []
  if (locations.length === 0) return ''
  return `
    <div class="tool-locations">
      <span>${escapeHtml(t('chat.locations'))}</span>
      ${locations.map(location => `<button type="button" data-open-path="${escapeHtml(location.path)}">${escapeHtml(shortPath(location.path))}${location.line === undefined ? '' : `:${location.line}`}</button>`).join('')}
    </div>
  `
}

function toolCallPreview(value: unknown): string {
  const args = parseMaybeJson(value)
  if (args !== null && typeof args === 'object') {
    const record = asRecord(args)
    const preferred = record.description ?? record.command ?? record.file_path ?? record.path ?? record.name ?? record.url ?? record.query
    if (typeof preferred === 'string' && preferred.length > 0) return truncate(preferred, 90)
    const firstString = Object.values(record).find(candidate => typeof candidate === 'string' && candidate.length > 0)
    if (typeof firstString === 'string') return truncate(firstString, 90)
  }
  return ''
}

/* ── Trajectory: logical graph rows shared with Chat, Waterfall, Inspector ── */

function renderTrajectory(): void {
  if (state.graph.trajectoryRows.length === 0) {
    el.trajectory.innerHTML = `<div class="empty-thread compact"><h2>${escapeHtml(t('empty.traceTitle'))}</h2><p>${escapeHtml(t('empty.traceBody'))}</p></div>`
    return
  }
  const header = `
    <div class="traj-head-row" aria-hidden="true">
      <span>${escapeHtml(t('trace.columnNumber'))}</span>
      <span>${escapeHtml(t('trace.columnEvent'))}</span>
      <span>${escapeHtml(t('trace.columnContent'))}</span>
      <span class="num">${escapeHtml(t('trace.columnInput'))}</span>
      <span class="num">${escapeHtml(t('trace.columnOutput'))}</span>
      <span class="num">${escapeHtml(t('trace.columnThink'))}</span>
      <span class="num">${escapeHtml(t('trace.columnTime'))}</span>
      <span></span>
    </div>
  `
  const body = state.graph.trajectoryGroups.map((group) => {
    const groupTargets = group.rowTargetIds.map(id => state.graph.targets.get(id)).filter((target): target is TraceTarget => target !== undefined)
    const toolSummary = groupTargets.filter(target => target.kind === 'tool').map(target => target.title).join(' · ')
    const head = `
      <div class="traj-group-head ${group.status === 'error' ? 'error' : ''}" data-group-anchor="${escapeHtml(group.id)}">
        <span>${escapeHtml(graphGroupLabel(group))}</span>
        <span class="g-dur">${escapeHtml(formatMs(group.endTime - group.startTime))}</span>
        ${toolSummary.length > 0 ? `<span class="g-meta">${escapeHtml(toolSummary)}</span>` : ''}
      </div>
    `
    return head + group.rowTargetIds.map(targetId => renderGraphTrajectoryRow(targetId)).join('')
  }).join('')
  el.trajectory.innerHTML = header + body
  updateSelectionHighlight()
}

function graphGroupLabel(group: GraphTrajectoryGroup): string {
  return group.step === null ? `${t('trace.turn')} ${group.turn} · ${t('trace.message')}` : `${t('trace.step')} ${group.step}`
}

function renderGraphTrajectoryRow(targetId: string): string {
  const target = state.graph.targets.get(targetId)
  if (target === undefined) return ''
  const index = state.graph.trajectoryRows.findIndex(row => row.targetId === targetId) + 1
  const expanded = state.expandedTrajectoryIds.has(targetId)
  const fbCount = feedbackFor(targetId).length
  const usage = target.kind === 'assistant' ? usageOfTarget(target) : { input: '', output: '', think: '' }
  const statusChip = target.status === 'error'
    ? `<span class="event-chip error">${escapeHtml(t('trace.error'))}</span>`
    : target.status === 'running' ? `<span class="event-chip">${escapeHtml(t('trace.running'))}</span>` : ''
  return `
    <article class="traj-row ${escapeHtml(target.kind)} ${target.status === 'error' ? 'error' : ''} ${expanded ? 'expanded' : ''} ${selectedTargetClass(target.id)}" data-traj-row="${escapeHtml(target.id)}" data-target-id="${escapeHtml(target.id)}">
      <div class="traj-summary" role="button" tabindex="0" data-target-id="${escapeHtml(target.id)}">
        <span class="traj-index">#${index}</span>
        <span class="role-chip ${escapeHtml(target.kind)}">${escapeHtml(kindLabel(target.kind))}</span>
        <span class="traj-content">${statusChip}<span class="traj-title">${escapeHtml(trajectoryRowTitle(target))}</span>${fbCount > 0 ? `<span class="fb-chip">✎${fbCount}</span>` : ''}</span>
        <span class="token-cell">${escapeHtml(usage.input)}</span>
        <span class="token-cell">${escapeHtml(usage.output)}</span>
        <span class="token-cell">${escapeHtml(usage.think)}</span>
        <span class="token-cell offset">+${escapeHtml(formatMs(target.startTime - state.graph.startTime))}</span>
        <button class="chevron traj-expand" type="button" data-toggle-traj="${escapeHtml(target.id)}" aria-expanded="${expanded}" aria-label="${escapeHtml(t(expanded ? 'trace.collapseRow' : 'trace.expandRow'))}">${expanded ? '▾' : '▸'}</button>
      </div>
      ${expanded ? renderGraphTrajectoryBody(target) : ''}
    </article>
  `
}

function kindLabel(kind: TraceTarget['kind']): string {
  return t(`kind.${kind}`)
}

function planRowTitle(target: TraceTarget): string {
  const items = planItemsOf(target)
  const done = items.filter(item => item.status === 'completed').length
  const active = items.find(item => item.status === 'in_progress')
  return `${done}/${items.length}${active === undefined ? '' : ` · ${truncate(active.content, 80)}`}`
}

/** Content preview beats the kind name: the chip already says what a row is. */
function trajectoryRowTitle(target: TraceTarget): string {
  if (target.kind === 'assistant') {
    const preview = truncate(assistantText(target.output) || contentText(target.output), 120)
    if (preview.length > 0) return preview
  }
  if (target.kind === 'user' || target.kind === 'reasoning' || target.kind === 'context') {
    const preview = truncate(contentText(target.output), 120)
    if (preview.length > 0) return preview
  }
  if (target.kind === 'plan') return `${t('chat.planList')} · ${planRowTitle(target)}`
  if (target.kind === 'tool') {
    const rich = liveToolTitle(target)
    if (rich !== undefined) return rich
    const preview = toolCallPreview(target.input)
    return preview.length > 0 ? `${target.title} · ${preview}` : `${target.title} · ${target.subtitle}`
  }
  return `${target.title} · ${target.subtitle}`
}

function rerenderTrajRow(id: string): void {
  const existing = el.trajectory.querySelector(`[data-traj-row="${CSS.escape(id)}"]`)
  if (!state.graph.targets.has(id) || existing === null) {
    renderTrajectory()
    return
  }
  existing.outerHTML = renderGraphTrajectoryRow(id)
  updateSelectionHighlight()
}

function renderGraphTrajectoryBody(target: TraceTarget): string {
  const tools = graphTargetTools(target)
  return `
    <div class="traj-body" data-target-id="${escapeHtml(target.id)}">
      <section class="traj-card ${target.status === 'error' ? 'error' : ''}"><header><strong>${escapeHtml(t('chat.input'))}</strong><span>${escapeHtml(target.subtitle)}</span></header><pre>${escapeHtml(formatPayload(target.input, 'json'))}</pre></section>
      <section class="traj-card ${target.status === 'error' ? 'error' : ''}"><header><strong>${escapeHtml(target.status === 'error' ? t('chat.errorOutput') : t('chat.output'))}</strong><span>${escapeHtml(formatMs(target.endTime - target.startTime))}</span></header><pre>${escapeHtml(formatPayload(target.output, 'plain'))}</pre></section>
      <details class="metadata-line"><summary>${escapeHtml(t('trace.metadata'))}</summary><pre>${escapeHtml(formatPayload(target.metadata, 'json'))}</pre></details>
      ${tools}
    </div>
  `
}

function usageOfTarget(target: TraceTarget): { input: string; output: string; think: string } {
  const event = target.eventSeqs.map(seq => state.seqMap.get(seq)).find(candidate => candidate?.type === 'assistant/message')
  return event === undefined ? { input: '', output: '', think: '' } : usageOfEvent(event)
}

/** Inline row utilities attached to one logical graph target. */
function graphTargetTools(target: TraceTarget): string {
  const feedback = feedbackFor(target.id)
  const annotateOpen = state.annotateOpenIds.has(target.id)
  const author = localStorage.getItem(AUTHOR_KEY) ?? DEFAULT_FEEDBACK_AUTHOR
  const feedbackList = feedback.length === 0 ? '' : `
    <div class="inline-fb-list">
      ${feedback.map(item => `
        <article class="feedback-entry">
          <header><strong>${escapeHtml(item.data.author)}</strong><time>${escapeHtml(new Date(item.time).toLocaleString())}</time></header>
          <p>${escapeHtml(item.data.text)}</p>
        </article>
      `).join('')}
    </div>
  `
  const feedbackForm = !annotateOpen ? '' : `
    <form class="inline-fb" data-fb-row="${escapeHtml(target.id)}" data-session-id="${escapeHtml(state.selectedSessionId ?? '')}">
      <textarea name="text" placeholder="${escapeHtml(t('feedback.placeholder'))}" required></textarea>
      <div class="inline-fb-row">
        <input name="author" type="text" value="${escapeHtml(author)}" placeholder="${escapeHtml(t('feedback.author'))}">
        <span class="fb-hint">${escapeHtml(target.kind)} · ${escapeHtml(target.title)}</span>
        <button class="fb-send" type="submit">${escapeHtml(t('feedback.add'))}</button>
      </div>
    </form>
  `
  const rawEvents = target.eventSeqs.map(seq => state.seqMap.get(seq)).filter((event): event is SessionEvent => event !== undefined)
  return `
    <div class="row-tools">
      <button type="button" data-copy-target="${escapeHtml(target.id)}">${escapeHtml(t('trace.copyJson'))}</button>
      <button type="button" data-annotate-row="${escapeHtml(target.id)}">${annotateOpen ? escapeHtml(t('trace.annotateClose')) : `${escapeHtml(t('trace.annotate'))}${feedback.length > 0 ? ` (${feedback.length})` : ''}`}</button>
      <button type="button" data-target-id="${escapeHtml(target.id)}">${escapeHtml(t('chat.openInspector'))}</button>
    </div>
    ${feedbackForm}${feedbackList}<details class="metadata-line"><summary>${escapeHtml(t('trace.rawEvent'))}</summary><pre>${escapeHtml(formatPayload(rawEvents, 'jsonl'))}</pre></details>
  `
}

/* Tree + scroll-spy */

function renderTrajTree(): void {
  const turns = new Map<number, GraphTrajectoryGroup[]>()
  for (const group of state.graph.trajectoryGroups) {
    const list = turns.get(group.turn) ?? []
    list.push(group)
    turns.set(group.turn, list)
  }
  el.trajTree.innerHTML = [...turns.entries()].map(([turn, groups]) => {
    const turnTarget = state.graph.targets.get(`turn:${turn}`)
    const duration = turnTarget === undefined ? '' : formatMs(turnTarget.endTime - turnTarget.startTime)
    const steps = groups.map((group) => {
      const sub = group.rowTargetIds.map(id => state.graph.targets.get(id)).filter((target): target is TraceTarget => target?.kind === 'tool').map(target => target.title).join(' · ')
      return `
        <button class="tree-step ${group.status === 'error' ? 'error' : ''}" type="button" data-jump-group="${escapeHtml(group.id)}">
          <span class="t-name">${escapeHtml(graphGroupLabel(group))}</span>
          <span class="t-dur">${escapeHtml(formatMs(group.endTime - group.startTime))}</span>
          ${sub.length > 0 ? `<span class="t-sub">${escapeHtml(sub)}</span>` : ''}
        </button>
      `
    }).join('')
    return `
      <details class="tree-turn" open>
        <summary class="tree-turn-head"><span class="tt-label">${escapeHtml(t('trace.turn'))} ${turn}${turnTarget === undefined ? '' : ` · ${escapeHtml(turnTarget.status)}`}</span><span class="t-dur">${escapeHtml(duration)}</span></summary>
        <div class="tree-steps">${steps}</div>
      </details>
    `
  }).join('') || `<div class="empty-list">${escapeHtml(t('empty.traceTitle'))}</div>`
}

function markActiveGroup(groupKey: string): void {
  let activeStep: HTMLElement | null = null
  for (const step of el.trajTree.querySelectorAll<HTMLElement>('.tree-step')) {
    const on = step.dataset.jumpGroup === groupKey
    step.classList.toggle('active', on)
    if (on) activeStep = step
  }
  for (const turn of el.trajTree.querySelectorAll<HTMLElement>('.tree-turn')) {
    turn.querySelector('.tree-turn-head')?.classList.toggle('active', turn.querySelector('.tree-step.active') !== null)
  }
  if (activeStep !== null) {
    const stepRect = activeStep.getBoundingClientRect()
    const treeRect = el.trajTree.getBoundingClientRect()
    if (stepRect.top < treeRect.top || stepRect.bottom > treeRect.bottom) activeStep.scrollIntoView({ block: 'nearest' })
  }
}

function updateScrollSpy(): void {
  const anchors = [...el.trajMain.querySelectorAll<HTMLElement>('[data-group-anchor]')]
  if (anchors.length === 0) return
  const topEdge = el.trajMain.getBoundingClientRect().top + 70
  let current = anchors[0]!
  for (const anchor of anchors) {
    if (anchor.getBoundingClientRect().top <= topEdge) current = anchor
    else break
  }
  markActiveGroup(current.dataset.groupAnchor ?? '')
}

function jumpToGroup(groupKey: string): void {
  showSurface('trajectory')
  flashAndScroll(`[data-group-anchor="${CSS.escape(groupKey)}"]`, 'start')
  markActiveGroup(groupKey)
}

function jumpToTrajectoryTarget(targetId: string): void {
  showSurface('trajectory')
  const target = state.graph.targets.get(targetId)
  if (target?.kind === 'step') {
    jumpToGroup(target.id)
    return
  }
  if (target?.kind === 'turn') {
    const group = state.graph.trajectoryGroups.find(candidate => candidate.turn === target.turn)
    if (group !== undefined) jumpToGroup(group.id)
    return
  }
  const row = state.graph.trajectoryRows.find(item => item.targetId === targetId)
  if (row === undefined) return
  if (!state.expandedTrajectoryIds.has(targetId)) {
    state.expandedTrajectoryIds.add(targetId)
    rerenderTrajRow(targetId)
  }
  flashAndScroll(`[data-traj-row="${CSS.escape(targetId)}"]`)
}

function flashAndScroll(selector: string, block: ScrollLogicalPosition = 'center'): void {
  const target = document.querySelector<HTMLElement>(selector)
  if (target === null) return
  target.scrollIntoView({ block })
  target.classList.remove('flash')
  void target.offsetWidth
  target.classList.add('flash')
}

/* ── Waterfall: graph timing spans sharing targets with every view ───────── */

function renderWaterfall(): void {
  const spans = state.graph.waterfallSpans
  if (spans.length === 0) {
    el.waterfall.innerHTML = `<div class="empty-thread compact"><h2>${escapeHtml(t('empty.traceTitle'))}</h2><p>${escapeHtml(t('empty.traceBody'))}</p></div>`
    return
  }
  const totalMs = Math.max(1, state.graph.endTime - state.graph.startTime)
  const total = state.graph.targets.get('summary:total')!
  const llm = state.graph.targets.get('summary:llm')!
  const tools = state.graph.targets.get('summary:tools')!
  const errors = state.graph.targets.get('summary:errors')!
  const slowest = state.graph.targets.get('summary:slowest')!
  const summary = `
    <section class="wf-summary">
      ${renderWaterfallStat(total, t('waterfall.total'), formatMs(Number(total.output)))}
      ${renderWaterfallStat(llm, t('waterfall.llmTime'), formatMs(Number(llm.output)))}
      ${renderWaterfallStat(tools, t('waterfall.toolTime'), formatMs(Number(tools.output)))}
      ${renderWaterfallStat(errors, t('waterfall.errors'), String(errors.output), Number(errors.output) > 0)}
      ${renderWaterfallStat(slowest, t('waterfall.slowestStep'), formatMs(Number(slowest.output)))}
      ${renderWaterfallStat(state.graph.targets.get(`session:${state.graph.sessionId}`)!, t('waterfall.tokens'), `${sumTokens('input')}/${sumTokens('output')}`)}
    </section>
  `
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(part => `<span>${escapeHtml(formatMs(totalMs * part))}</span>`).join('')
  el.waterfall.innerHTML = summary + `
    <div class="wf">
      <div class="wf-row wf-head-row"><div class="wf-label-col"></div><div class="wf-axis">${ticks}</div></div>
      ${spans.map((span) => {
        const target = state.graph.targets.get(span.targetId)
        if (target === undefined) return ''
        const left = Math.max(0, ((target.startTime - state.graph.startTime) / totalMs) * 100)
        const width = Math.max(0.35, ((target.endTime - target.startTime) / totalMs) * 100)
        return `
          <div class="wf-row">
            <button class="wf-label-col ${selectedTargetClass(target.id)}" type="button" data-target-id="${escapeHtml(target.id)}" style="--depth:${span.depth}">
              <span class="wf-glyph ${target.kind} ${target.status === 'error' ? 'error' : ''}">${nodeGlyph(target.kind)}</span>
              <span class="wf-name">${escapeHtml(waterfallLabel(target))}</span>
              <span class="wf-dur">${escapeHtml(formatMs(target.endTime - target.startTime))}</span>
            </button>
            <div class="wf-track">
              <button class="wf-bar ${target.kind} ${target.status === 'error' ? 'error' : ''} ${selectedTargetClass(target.id)}" type="button" data-target-id="${escapeHtml(target.id)}" style="left:${left.toFixed(2)}%;width:${Math.min(width, 100 - left).toFixed(2)}%" title="${escapeHtml(`${target.title} · ${formatMs(target.endTime - target.startTime)}`)}"></button>
            </div>
          </div>
        `
      }).join('')}
    </div>
  `
}

function renderWaterfallStat(target: TraceTarget, label: string, value: string, error = false): string {
  return `<button class="wf-stat link ${error ? 'error' : ''} ${selectedTargetClass(target.id)}" type="button" data-target-id="${escapeHtml(target.id)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></button>`
}

function nodeGlyph(kind: string): string {
  if (kind === 'turn') return 'T'
  if (kind === 'step') return 'ST'
  if (kind === 'tool') return 'TL'
  if (kind === 'assistant' || kind === 'reasoning' || kind === 'request') return 'AI'
  return 'EV'
}

/* ── Inspector: one drawer shared by every surface through graph target ids ── */

function openInspectorForTarget(targetId: string): void {
  const target = state.graph.targets.get(targetId)
  if (target === undefined) return
  captureFeedbackDraft()
  state.selectedTargetId = targetId
  state.activeInspectorTab = target.kind === 'tool' || target.kind === 'request'
    ? 'input'
    : target.kind === 'user' || target.kind === 'reasoning' || target.kind === 'assistant' || target.kind === 'context'
      ? 'output'
      : 'metadata'
  openInspector()
}

function openInspector(): void {
  el.inspector.hidden = false
  document.querySelector('#dividerInspector')?.toggleAttribute('hidden', false)
  document.querySelector('#shell')?.classList.add('inspector-open')
  renderInspector()
  updateSelectionHighlight()
}

function closeInspector(): void {
  captureFeedbackDraft()
  state.selectedTargetId = undefined
  el.inspector.hidden = true
  document.querySelector('#dividerInspector')?.toggleAttribute('hidden', true)
  document.querySelector('#shell')?.classList.remove('inspector-open')
  updateSelectionHighlight()
}

function currentTargetId(): string {
  return state.selectedTargetId ?? `session:${state.selectedSessionId ?? ''}`
}

interface InspectorPayloads {
  kindLabel: string
  title: string
  subtitle: string
  input: unknown
  output: unknown
  metadata: unknown
}

function inspectorPayloads(): InspectorPayloads {
  const target = state.graph.targets.get(currentTargetId())
  if (target === undefined) return { kindLabel: t('app.sessionLabel'), title: state.selectedSessionId ?? '', subtitle: '', input: '', output: '', metadata: {} }
  const metadata = target.kind === 'session'
    ? { ...asRecord(target.metadata), header: state.trace?.header, path: state.trace?.relativePath, children: state.trace?.children, parent: state.trace?.parent }
    : target.metadata
  return { kindLabel: kindLabel(target.kind), title: waterfallLabel(target), subtitle: `${target.subtitle} · ${formatMs(target.endTime - target.startTime)}`, input: target.input, output: target.output, metadata }
}

/** Localized display name for a graph target (turn/step numbers, kind names, tool titles). */
function waterfallLabel(target: TraceTarget): string {
  if (target.kind === 'turn') return `${t('kind.turn')} ${target.turn ?? ''}`
  if (target.kind === 'step') return `${t('kind.step')} ${target.step ?? ''}`
  if (target.kind === 'assistant') return t('kind.assistant')
  if (target.kind === 'reasoning') return t('kind.reasoning')
  if (target.kind === 'user') return t('kind.user')
  if (target.kind === 'request') return t('kind.request')
  return target.title
}

function renderInspector(): void {
  if (el.inspector.hidden) return
  const payloads = inspectorPayloads()
  const jumpButton = document.querySelector<HTMLButtonElement>('[data-action="jump-traj"]')
  if (jumpButton !== null) jumpButton.hidden = state.selectedTargetId === undefined || !state.graph.trajectoryRows.some(row => row.targetId === state.selectedTargetId) && !['turn', 'step'].includes(state.graph.targets.get(state.selectedTargetId)?.kind ?? '')
  el.inspectorKind.textContent = payloads.kindLabel
  el.inspectorTitle.textContent = payloads.title
  el.inspectorSubtitle.textContent = payloads.subtitle
  for (const button of el.inspectorTabs.querySelectorAll<HTMLElement>('[data-inspector-tab]')) {
    button.classList.toggle('active', button.dataset.inspectorTab === state.activeInspectorTab)
  }
  if (state.activeInspectorTab === 'feedback') {
    renderInspectorFeedback()
    return
  }
  const key = state.activeInspectorTab
  const value = payloads[key]
  const format = state.inspectorFormats[key]
  el.inspectorBody.innerHTML = `
    <div class="format-row">
      <strong>${escapeHtml(t(`inspector.${key}`))}</strong>
      <select data-format-target="${key}">
        ${(['plain', 'json', 'jsonl', 'yaml'] as const).map(option => `<option value="${option}" ${option === format ? 'selected' : ''}>${option.toUpperCase()}</option>`).join('')}
      </select>
    </div>
    <pre class="code-block">${escapeHtml(formatPayload(value, format))}</pre>
  `
}

function renderInspectorFeedback(): void {
  const targetId = currentTargetId()
  const feedback = feedbackFor(targetId)
  const draft = state.feedbackDrafts.get(feedbackDraftKey(state.selectedSessionId, targetId))
  const author = draft?.author ?? localStorage.getItem(AUTHOR_KEY) ?? DEFAULT_FEEDBACK_AUTHOR
  const text = draft?.text ?? ''
  const title = inspectorPayloads().title
  el.inspectorBody.innerHTML = `
    <div class="feedback-list">
      ${feedback.map(record => `
        <article class="feedback-entry">
          <header><strong>${escapeHtml(record.data.author)}</strong><span>${escapeHtml(new Date(record.time).toLocaleString())}</span></header>
          <p>${escapeHtml(record.data.text)}</p>
        </article>
      `).join('') || `<p class="empty-panel">${escapeHtml(t('feedback.empty'))}</p>`}
    </div>
    <form class="feedback-form" data-feedback-form="true" data-session-id="${escapeHtml(state.selectedSessionId ?? '')}" data-target-id="${escapeHtml(targetId)}" data-target-title="${escapeHtml(title)}">
      <input name="author" value="${escapeHtml(author)}" aria-label="${escapeHtml(t('feedback.author'))}" />
      <textarea name="text" rows="4" placeholder="${escapeHtml(t('feedback.placeholder'))}">${escapeHtml(text)}</textarea>
      <button type="submit">${escapeHtml(t('feedback.add'))}</button>
    </form>
  `
}

function feedbackDraftKey(sessionId: string | undefined, targetId: string): string {
  return `${sessionId ?? ''}:${targetId}`
}

function captureFeedbackDraft(): void {
  const form = el?.inspectorBody?.querySelector<HTMLFormElement>('[data-feedback-form="true"]')
  if (form === null || form === undefined) return
  const data = new FormData(form)
  const sessionId = form.dataset.sessionId ?? ''
  const targetId = form.dataset.targetId ?? ''
  if (targetId.length === 0) return
  state.feedbackDrafts.set(feedbackDraftKey(sessionId, targetId), {
    author: String(data.get('author') ?? ''),
    text: String(data.get('text') ?? ''),
  })
}

function feedbackFor(targetId: string): FeedbackRecord[] {
  return (state.trace?.feedback ?? []).filter(record => record.data?.targetId === targetId)
}

async function submitFeedback(form: HTMLFormElement, sessionId: string, targetId: string, targetTitle: string): Promise<boolean> {
  if (!hasDesktopApi() || sessionId.length === 0) return false
  const data = new FormData(form)
  const text = String(data.get('text') ?? '').trim()
  const author = String(data.get('author') ?? '').trim() || DEFAULT_FEEDBACK_AUTHOR
  if (text.length === 0) return false
  localStorage.setItem(AUTHOR_KEY, author)
  try {
    const record = await window.dshDesktop.feedback.add({
      sessionId,
      targetId,
      targetTitle,
      targetKind: state.graph.targets.get(targetId)?.kind ?? 'event',
      author,
      text,
    }) as FeedbackRecord
    if (state.selectedSessionId === sessionId && state.trace?.sessionId === sessionId) {
      state.trace.feedback = [...(state.trace.feedback ?? []), record]
    }
    state.feedbackDrafts.delete(feedbackDraftKey(sessionId, targetId))
    form.querySelector('.form-error')?.remove()
    toast(t('feedback.saved'))
    return true
  } catch (error) {
    // The error belongs next to the form, not only in a transient toast.
    let errorLine = form.querySelector<HTMLElement>('.form-error')
    if (errorLine === null) {
      errorLine = document.createElement('p')
      errorLine.className = 'form-error'
      errorLine.setAttribute('role', 'alert')
      form.appendChild(errorLine)
    }
    errorLine.textContent = `${t('feedback.failed')}: ${String(error)}`
    return false
  }
}

function updateSelectionHighlight(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-target-id]')) {
    node.classList.toggle('is-selected', state.selectedTargetId !== undefined && node.dataset.targetId === state.selectedTargetId)
  }
}

function selectedTargetClass(targetId: string): string {
  return state.selectedTargetId === targetId ? 'is-selected' : ''
}

/* ── Static event wiring ──────────────────────────────────────────────────── */

function wireStaticEvents(): void {
  el.searchInput.addEventListener('input', () => {
    state.query = el.searchInput.value
    renderSessionList()
  })

  el.composerInput.addEventListener('input', () => {
    updateComposerState()
  })
  el.composerInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    el.composerForm.requestSubmit()
  })
  el.composerForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const prompt = el.composerInput.value.trim()
    if (prompt.length === 0 || state.busySessionId !== undefined) return
    void sendPrompt(prompt)
  })
  el.cancelButton.addEventListener('click', () => {
    void cancelActiveTurn()
  })

  el.chatView.addEventListener('scroll', () => {
    state.stickToBottom = el.chatView.scrollTop + el.chatView.clientHeight >= el.chatView.scrollHeight - 48
    updateLiveJump()
  })
  el.liveJump.addEventListener('click', () => {
    scrollChatToBottom(true)
  })
  el.trajMain.addEventListener('scroll', () => {
    window.requestAnimationFrame(updateScrollSpy)
  })

  document.addEventListener('keydown', (event) => {
    if (event.metaKey && event.key.toLowerCase() === 'n') {
      event.preventDefault()
      startDraftChat()
      return
    }
    if (event.key === 'Escape' && !el.inspector.hidden) {
      closeInspector()
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLElement && event.target.matches('.traj-summary')) {
      event.preventDefault()
      openInspectorForTarget(event.target.dataset.targetId ?? '')
    }
  })

  document.addEventListener('change', (event) => {
    const select = event.target instanceof HTMLSelectElement ? event.target : undefined
    const formatTarget = select?.dataset.formatTarget as 'input' | 'output' | 'metadata' | undefined
    if (select !== undefined && formatTarget !== undefined) {
      state.inspectorFormats[formatTarget] = select.value as PayloadFormat
      renderInspector()
    }
  })

  document.addEventListener('submit', (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : undefined
    if (form === undefined) return
    if (form.dataset.feedbackForm === 'true') {
      event.preventDefault()
      const sessionId = form.dataset.sessionId ?? ''
      const targetId = form.dataset.targetId ?? ''
      const targetTitle = form.dataset.targetTitle ?? targetId
      void submitFeedback(form, sessionId, targetId, targetTitle).then((saved) => {
        if (saved && state.selectedSessionId === sessionId && currentTargetId() === targetId) renderInspectorFeedback()
      })
    } else if (form.classList.contains('inline-fb')) {
      event.preventDefault()
      const rowId = form.dataset.fbRow ?? ''
      const graphTarget = state.graph.targets.get(rowId)
      const sessionId = form.dataset.sessionId ?? state.selectedSessionId ?? ''
      void submitFeedback(form, sessionId, rowId, graphTarget?.title ?? rowId).then((saved) => {
        if (saved && state.selectedSessionId === sessionId) rerenderTrajRow(rowId)
      })
    }
  })

  document.addEventListener('click', (event) => {
    void handleDelegatedClick(event)
  })
}

async function handleDelegatedClick(event: MouseEvent): Promise<void> {
  if (!(event.target instanceof Element)) return
  const target = event.target

  const moduleButton = target.closest<HTMLElement>('[data-module]')
  if (moduleButton !== null) {
    showModule(moduleButton.dataset.module as AppModule)
    return
  }
  const surfaceButton = target.closest<HTMLElement>('[data-surface]')
  if (surfaceButton !== null) {
    showSurface(surfaceButton.dataset.surface as SessionSurface)
    return
  }
  const sessionButton = target.closest<HTMLElement>('[data-session]')
  if (sessionButton !== null) {
    showModule('sessions')
    await loadTrace(sessionButton.dataset.session ?? '')
    return
  }
  const devArtifact = target.closest<HTMLElement>('[data-dev-artifact]')
  if (devArtifact !== null) {
    selectDevArtifact(devArtifact.dataset.devArtifact ?? '')
    return
  }

  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
  if (action !== undefined) {
    await handleAction(action)
    return
  }

  const openPath = target.closest<HTMLElement>('[data-open-path]')?.dataset.openPath
  if (openPath !== undefined) {
    try {
      await window.dshDesktop.dev.openPath(openPath)
      toast(t('dev.openedInEditor'))
    } catch (error) {
      toast(`${t('dev.openFailed')}: ${String(error)}`)
    }
    return
  }

  const copyTarget = target.closest<HTMLElement>('[data-copy-target]')
  if (copyTarget !== null) {
    const graphTarget = state.graph.targets.get(copyTarget.dataset.copyTarget ?? '')
    if (graphTarget !== undefined) {
      await navigator.clipboard.writeText(JSON.stringify({ input: graphTarget.input, output: graphTarget.output, metadata: graphTarget.metadata }, null, 2))
      toast(t('toast.copied'))
    }
    return
  }
  const annotateRow = target.closest<HTMLElement>('[data-annotate-row]')
  if (annotateRow !== null) {
    const id = annotateRow.dataset.annotateRow ?? ''
    if (state.annotateOpenIds.has(id)) state.annotateOpenIds.delete(id)
    else state.annotateOpenIds.add(id)
    rerenderTrajRow(id)
    return
  }
  const jumpGroup = target.closest<HTMLElement>('[data-jump-group]')
  if (jumpGroup !== null) {
    jumpToGroup(jumpGroup.dataset.jumpGroup ?? '')
    return
  }
  const activityToggle = target.closest<HTMLElement>('[data-toggle-activity]')
  if (activityToggle !== null) {
    const id = activityToggle.dataset.toggleActivity ?? ''
    if (state.expandedActivityIds.has(id)) state.expandedActivityIds.delete(id)
    else state.expandedActivityIds.add(id)
    renderConversation()
    return
  }
  if (target.closest('#conversation a') !== null) return
  const trajToggle = target.closest<HTMLElement>('[data-toggle-traj]')
  if (trajToggle !== null) {
    if (window.getSelection()?.toString()) return
    toggleTrajRow(trajToggle.dataset.toggleTraj ?? '')
    return
  }
  const graphTarget = target.closest<HTMLElement>('[data-target-id]')
  if (graphTarget !== null) {
    if (window.getSelection()?.toString()) return
    openInspectorForTarget(graphTarget.dataset.targetId ?? '')
    return
  }
  const inspectorTab = target.closest<HTMLElement>('[data-inspector-tab]')
  if (inspectorTab !== null) {
    captureFeedbackDraft()
    state.activeInspectorTab = inspectorTab.dataset.inspectorTab as InspectorTab
    renderInspector()
    return
  }

  // Expanded trajectory bodies and their <details> handle their own clicks.
  if (target.closest('.traj-body') !== null || target.closest('.traj-row details') !== null) return

}

async function handleAction(action: string): Promise<void> {
  if (action === 'toggle-locale') {
    state.locale = state.locale === 'zh-CN' ? 'en-US' : 'zh-CN'
    localStorage.setItem('dsh.locale', state.locale)
    applyStaticText()
    renderSessionList()
    renderTopbar()
    renderConversation()
    renderLiveTurn()
    renderTrajectory()
    renderTrajTree()
    renderWaterfall()
    renderInspector()
    if (state.activeModule === 'develop') renderDevelop()
  } else if (action === 'close-inspector') {
    closeInspector()
  } else if (action === 'jump-traj') {
    if (state.selectedTargetId !== undefined) jumpToTrajectoryTarget(state.selectedTargetId)
  } else if (action === 'new-session') {
    startDraftChat()
  } else if (action === 'expand-traj') {
    state.expandedTrajectoryIds = new Set(state.graph.trajectoryRows.map(row => row.targetId))
    renderTrajectory()
  } else if (action === 'collapse-traj') {
    state.expandedTrajectoryIds = new Set()
    renderTrajectory()
  } else if (action === 'restart-runtime') {
    if (!hasDesktopApi()) return
    await window.dshDesktop.runtime.restart()
    await refreshRuntime()
  } else if (action === 'reveal-session') {
    if (!hasDesktopApi() || state.selectedSessionId === undefined) return
    try {
      await window.dshDesktop.sessions.reveal(state.selectedSessionId)
    } catch (error) {
      showError(String(error))
    }
  }
}

function toggleTrajRow(id: string): void {
  if (id.length === 0) return
  if (state.expandedTrajectoryIds.has(id)) state.expandedTrajectoryIds.delete(id)
  else state.expandedTrajectoryIds.add(id)
  rerenderTrajRow(id)
}

function startDraftChat(): void {
  captureFeedbackDraft()
  state.traceLoadRevision += 1
  state.activeModule = 'sessions'
  state.selectedSessionId = undefined
  state.trace = undefined
  state.draftChat = true
  closeInspector()
  showModule('sessions')
  showSurface('chat')
  rebuildTraceIndexes()
  renderSessionList()
  renderTopbar()
  renderConversation()
  renderLiveTurn()
  renderTrajectory()
  renderTrajTree()
  renderWaterfall()
  applyStaticText()
  el.composerInput.focus()
}

/* ── Pane resizers: clamped drag on CSS variables, widths persist ─────────── */

function initPaneResizers(): void {
  const shell = document.querySelector<HTMLElement>('#shell')
  if (shell === null) return
  let saved: Record<string, number> = {}
  try {
    saved = JSON.parse(localStorage.getItem(PANE_WIDTH_KEY) ?? '{}') as Record<string, number>
  } catch {
    // Corrupt localStorage entry: fall back to defaults; the next drag rewrites it.
  }
  if (saved.left !== undefined) shell.style.setProperty('--left-w', `${saved.left}px`)
  if (saved.inspector !== undefined) shell.style.setProperty('--inspector-w', `${saved.inspector}px`)
  const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value))
  const persist = (): void => {
    localStorage.setItem(PANE_WIDTH_KEY, JSON.stringify({
      left: parseInt(shell.style.getPropertyValue('--left-w')) || undefined,
      inspector: parseInt(shell.style.getPropertyValue('--inspector-w')) || undefined,
    }))
  }
  const attach = (divider: HTMLElement | null, apply: (event: PointerEvent) => void): void => {
    if (divider === null) return
    divider.addEventListener('pointerdown', (down) => {
      down.preventDefault()
      divider.classList.add('dragging')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const move = (event: PointerEvent): void => {
        apply(event)
      }
      const up = (): void => {
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
  attach(document.querySelector('#dividerLeft'), (event) => {
    const rect = shell.getBoundingClientRect()
    shell.style.setProperty('--left-w', `${clamp(event.clientX - rect.left, 200, Math.min(440, rect.width * 0.4))}px`)
  })
  attach(document.querySelector('#dividerInspector'), (event) => {
    const rect = shell.getBoundingClientRect()
    shell.style.setProperty('--inspector-w', `${clamp(rect.right - event.clientX, 300, Math.min(680, rect.width * 0.6))}px`)
  })
}

/* ── Develop module (unchanged product shape; rendered into its own canvas) ── */

function renderDevelop(): void {
  const groups = developArtifactGroups()
  const artifacts = groups.flatMap(group => group.artifacts)
  const selected = selectedDevArtifact(artifacts)
  el.devCanvas.innerHTML = `
    <div class="develop-browser">
      <aside class="develop-artifact-rail" aria-label="${escapeHtml(t('dev.agentArtifacts'))}">
        ${groups.map(group => `
          <section class="dev-artifact-group">
            <h3>${escapeHtml(devGroupLabel(group.title))}</h3>
            <div>
              ${group.artifacts.map(artifact => `
                <button class="dev-artifact-row ${artifact.id === selected?.id ? 'selected' : ''} ${artifact.kind}" data-dev-artifact="${artifact.id}">
                  <div>
                    <strong>${escapeHtml(artifact.title)}</strong>
                    <span>${escapeHtml(devListSubtitle(artifact))}</span>
                  </div>
                  <em>${escapeHtml(artifact.status ?? artifact.kind)}</em>
                </button>
              `).join('')}
            </div>
          </section>
        `).join('')}
      </aside>
      <section class="develop-artifact-detail">
        ${selected === undefined
          ? `<section class="dev-empty"><strong>${escapeHtml(t('dev.emptyTitle'))}</strong><span>${escapeHtml(t('dev.emptyBody'))}</span></section>`
          : renderDevArtifactDetail(selected)}
      </section>
    </div>
  `
}

function selectDevArtifact(id: string): void {
  const artifacts = developArtifactGroups().flatMap(group => group.artifacts)
  const selected = artifacts.find(artifact => artifact.id === id)
  if (selected === undefined) return
  state.activeDevArtifactId = id
  for (const row of el.devCanvas.querySelectorAll<HTMLElement>('[data-dev-artifact]')) {
    row.classList.toggle('selected', row.dataset.devArtifact === id)
  }
  const detail = el.devCanvas.querySelector<HTMLElement>('.develop-artifact-detail')
  if (detail !== null) detail.innerHTML = renderDevArtifactDetail(selected)
}

function selectedDevArtifact(artifacts: DevArtifact[]): DevArtifact | undefined {
  const explicit = artifacts.find(artifact => artifact.id === state.activeDevArtifactId)
  if (explicit !== undefined) return explicit
  return artifacts.find(artifact => artifact.id === 'prompt:request-system' && artifact.status === t('dev.statusActive'))
    ?? artifacts.find(artifact => artifact.id === 'prompt:persona' && artifact.status === t('dev.statusActive'))
    ?? artifacts.find(artifact => artifact.id === 'prompt:assembly')
    ?? artifacts[0]
}

function devGroupLabel(group: DevArtifact['group']): string {
  if (group === 'Prompts') return t('dev.group.prompts')
  if (group === 'Tools') return t('dev.group.tools')
  if (group === 'Plugins / Context Providers') return t('dev.group.plugins')
  return t('dev.group.config')
}

function devListSubtitle(artifact: DevArtifact): string {
  if (artifact.kind === 'tool') return `${t('dev.toolSchema')} · ${shortPath(artifact.source ?? '')}`
  if (artifact.kind === 'plugin') return artifact.source ?? t('dev.cordisConfigEntry')
  if (artifact.kind === 'source') return `${t('dev.sourceFile')} · ${shortPath(artifact.source ?? '')}`
  return artifact.subtitle
}

/** A source is editable through the OS editor only when it is a repository path. */
function editableSourcePath(artifact: DevArtifact): string | undefined {
  const source = artifact.source ?? ''
  if (/^(packages|examples|plugins|cordis\.yml)/.test(source)) return source.replace(/\/$/, '')
  return undefined
}

function renderDevArtifactDetail(artifact: DevArtifact): string {
  const editablePath = editableSourcePath(artifact)
  return `
    <article class="dev-detail-card ${artifact.kind}">
      <header class="dev-detail-head">
        <div>
          <span>${escapeHtml(devGroupLabel(artifact.group))}</span>
          <h3>${escapeHtml(artifact.title)}</h3>
          <p>${escapeHtml(artifact.subtitle)}</p>
        </div>
        <div class="dev-detail-actions">
          ${editablePath === undefined ? '' : `<button type="button" data-open-path="${escapeHtml(editablePath)}">${escapeHtml(t('dev.openInEditor'))}</button>`}
        </div>
      </header>
      <section class="dev-detail-grid">
        ${renderDevFact(t('dev.source'), artifact.source ?? t('dev.unknown'))}
        ${renderDevFact(t('dev.owner'), artifact.owner ?? t('dev.unknown'))}
        ${renderDevFact(t('dev.recentlyUsed'), artifact.recent ?? t('dev.noRecentEvidence'))}
        ${renderDevFact(t('dev.reload'), reloadLabelForArtifact(artifact))}
      </section>
      ${renderDevRelationshipPanel(artifact)}
      ${renderDevCodePanel(contentTitleForArtifact(artifact), contentMetaForArtifact(artifact), artifact.value ?? '')}
      ${artifact.kind === 'prompt' ? renderDevRegistrySnapshot() : ''}
      ${artifact.metadata === undefined ? '' : renderDevCodePanel(t('dev.metadata'), t('dev.metadataSubtitle'), artifact.metadata)}
      ${artifact.kind === 'runtime' ? renderRuntimePanel() : ''}
    </article>
  `
}

function renderDevFact(labelText: string, value: string): string {
  return `<div class="dev-fact"><span>${escapeHtml(labelText)}</span><strong>${escapeHtml(value)}</strong></div>`
}

function renderDevRegistrySnapshot(): string {
  const groups = developArtifactGroups()
  const plugins = (groups.find(group => group.title === 'Plugins / Context Providers')?.artifacts ?? []).filter(artifact => artifact.kind === 'plugin')
  const tools = (groups.find(group => group.title === 'Tools')?.artifacts ?? []).filter(artifact => artifact.kind === 'tool')
  return `
    <section class="dev-registry-snapshot">
      <div><h4>${escapeHtml(t('dev.registeredPlugins'))}</h4>${renderDevPillList(plugins, t('dev.noPlugins'))}</div>
      <div><h4>${escapeHtml(t('dev.registeredTools'))}</h4>${renderDevPillList(tools, t('dev.noTools'))}</div>
    </section>
  `
}

function renderDevRelationshipPanel(artifact: DevArtifact): string {
  if (artifact.kind !== 'plugin' && artifact.kind !== 'source' && artifact.kind !== 'prompt') return ''
  const metadata = asRecord(artifact.metadata)
  const rows = [
    metadata.injectsPrompt === true ? t('dev.injectsPrompt') : '',
    metadata.registersTool === true ? t('dev.registersTool') : '',
    metadata.injectsContext === true ? t('dev.injectsContext') : '',
    artifact.kind === 'source' ? t('dev.sourceOwnsArtifact') : '',
  ].filter(Boolean)
  if (rows.length === 0) return ''
  return `<section class="dev-relationship-strip">${rows.map(row => `<span>${escapeHtml(row)}</span>`).join('')}</section>`
}

function renderDevPillList(artifacts: DevArtifact[], empty: string): string {
  if (artifacts.length === 0) return `<p>${escapeHtml(empty)}</p>`
  return `<ul>${artifacts.map(artifact => `<li><strong>${escapeHtml(artifact.title)}</strong><span>${escapeHtml(artifact.status ?? artifact.kind)}</span></li>`).join('')}</ul>`
}

function contentTitleForArtifact(artifact: DevArtifact): string {
  if (artifact.kind === 'prompt') return t('dev.effectivePromptContent')
  if (artifact.kind === 'tool') return t('dev.toolSchema')
  if (artifact.kind === 'plugin') return t('dev.pluginContribution')
  if (artifact.kind === 'source') return t('dev.sourceFileContent')
  if (artifact.kind === 'config') return t('dev.activeConfiguration')
  return t('dev.runtimeState')
}

function contentMetaForArtifact(artifact: DevArtifact): string {
  if (artifact.kind === 'prompt') return t('dev.promptMeta')
  if (artifact.kind === 'tool') return t('dev.toolMeta')
  if (artifact.kind === 'plugin') return t('dev.pluginMeta')
  if (artifact.kind === 'source') return t('dev.sourceMeta')
  if (artifact.kind === 'config') return t('dev.configMeta')
  return t('dev.runtimeMeta')
}

function reloadLabelForArtifact(artifact: DevArtifact): string {
  if (artifact.kind === 'runtime') return t('dev.manualRestart')
  return t('dev.restartAfterEdit')
}

function renderRuntimePanel(): string {
  return `
    <section class="module-card dev-status">
      <dl>${renderKeyValue(t('app.repo'), shortPath(runtimeRepoRoot()))}${renderKeyValue(t('app.branch'), gitField('branch'))}${renderKeyValue(t('app.commit'), gitField('commit'))}${renderKeyValue(t('app.dirty'), gitField('dirty'))}${renderKeyValue(t('app.acp'), runtimeLabel())}${renderKeyValue(t('app.restartNeeded'), String(asRecord(state.dev).restartNeeded ?? false))}</dl>
      <button data-action="restart-runtime" ${hasDesktopApi() ? '' : 'disabled'}>${escapeHtml(t('dev.restartRuntime'))}</button>
    </section>
  `
}

function renderDevCodePanel(title: string, meta: string, value: unknown): string {
  return `
    <section class="dev-section">
      <header class="dev-section-head"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(meta)}</p></div></header>
      <pre class="dev-code"><code>${escapeHtml(formatDevValue(value))}</code></pre>
    </section>
  `
}

function renderKeyValue(key: string, value: unknown): string {
  return `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`
}

function developArtifactGroups(): DevArtifactGroup[] {
  const dev = asRecord(state.dev)
  const composition = asRecord(dev.appComposition)
  const sourceFiles = Array.isArray(composition.sourceFiles) ? composition.sourceFiles : []
  const configPath = String(composition.configPath ?? 'examples/acp-agent/cordis.yml')
  const configText = String(composition.configText ?? '')
  const plugins = Array.isArray(composition.plugins) && composition.plugins.length > 0
    ? composition.plugins
    : pluginsFromConfigText(configText, configPath)
  const recentPromptUses = Array.isArray(dev.recentPromptUses) ? dev.recentPromptUses : []
  const recentToolCalls = Array.isArray(dev.recentToolCalls) ? dev.recentToolCalls : []
  const request = latestRequestContext()
  const persona = extractPersonaFromConfig(configText)
  const promptOwner = sourceFiles.find(file => asRecord(file).label === 'System prompt service')
  const toolRegistryOwner = sourceFiles.find(file => asRecord(file).label === 'Tool registry')
  const promptSources = sourceFiles.filter(file => asRecord(file).label === 'System prompt service').map(sourceFileToArtifact)
  const compositionSources = sourceFiles.filter(file => asRecord(file).label === 'Agent spine' || asRecord(file).label === 'ACP front door').map(sourceFileToArtifact)
  const toolSources = sourceFiles.filter(file => asRecord(file).label === 'Tool registry').map(sourceFileToArtifact)
  const promptArtifacts: DevArtifact[] = [
    {
      id: 'prompt:request-system',
      group: 'Prompts',
      kind: 'prompt',
      title: t('dev.requestSystemPrompt'),
      subtitle: t('dev.requestSystemPromptSubtitle'),
      status: request.system.length > 0 ? t('dev.statusActive') : t('dev.statusMissing'),
      source: request.event === undefined ? t('dev.noRequestEvidence') : `${t('dev.sourceRequestHeader')} · ${t('common.seq')} ${request.seq}`,
      owner: '@deepseek-ai/dsh-system-prompt',
      value: request.system || t('dev.noRequestSystemPrompt'),
      metadata: request.event?.data ?? request.header,
      recent: recentPromptSummary(recentPromptUses, request),
    },
    {
      id: 'prompt:persona',
      group: 'Prompts',
      kind: 'prompt',
      title: t('dev.systemPersona'),
      subtitle: t('dev.systemPersonaSubtitle'),
      status: persona.length > 0 ? t('dev.statusActive') : t('dev.statusMissing'),
      source: configPath,
      owner: '@deepseek-ai/dsh-acp-demo -> @deepseek-ai/dsh-system-prompt',
      value: persona || t('dev.noPersona'),
      metadata: promptOwner ?? { path: PATH_SYSTEM_PROMPT },
      recent: recentPromptSummary(recentPromptUses, request),
    },
    {
      id: 'prompt:assembly',
      group: 'Prompts',
      kind: 'prompt',
      title: t('dev.promptAssemblyService'),
      subtitle: t('dev.promptAssemblySubtitle'),
      status: t('dev.statusSource'),
      source: String(asRecord(promptOwner).path ?? PATH_SYSTEM_PROMPT),
      owner: '@deepseek-ai/dsh-system-prompt',
      value: sourceFileText(promptOwner) || promptOwner || { path: PATH_SYSTEM_PROMPT },
      metadata: {
        sourceFile: promptOwner ?? { path: PATH_SYSTEM_PROMPT },
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
      title: t('dev.activeCordis'),
      subtitle: t('dev.activeCordisSubtitle'),
      status: t('dev.statusActive'),
      source: configPath,
      owner: 'packages/examples/acp-demo/src/bin.ts',
      value: configText || t('dev.noConfigText'),
      metadata: {
        entrypoint: composition.entrypoint ?? 'packages/examples/acp-demo/src/bin.ts',
        model: modelFromConfigText(configText),
        watchedPaths: dev.watchedPaths ?? [],
      },
      recent: runtimeLabel(),
    },
    {
      id: 'runtime:acp',
      group: 'Config / Runtime',
      kind: 'runtime',
      title: t('dev.acpRuntime'),
      subtitle: t('dev.acpRuntimeSubtitle'),
      status: runtimeLabel(),
      source: 'packages/ui/desktop/src/main.mjs',
      owner: 'Electron main',
      value: { runtime: state.runtime, dev: state.dev },
      metadata: {
        repo: runtimeRepoRoot(),
        dirty: gitField('dirty'),
        branch: gitField('branch'),
        commit: gitField('commit'),
      },
      recent: String(asRecord(state.runtime).pid ?? t('dev.noPid')),
    },
  ]
  return [
    { title: 'Prompts', artifacts: [...promptArtifacts, ...promptSources] },
    { title: 'Tools', artifacts: [...toolArtifacts, ...toolSources] },
    { title: 'Plugins / Context Providers', artifacts: [...pluginArtifacts, ...compositionSources] },
    { title: 'Config / Runtime', artifacts: configArtifacts },
  ]
}

function sourceFileToArtifact(file: unknown): DevArtifact {
  const record = asRecord(file)
  const label = String(record.label ?? t('dev.sourceFile'))
  const path = String(record.path ?? '')
  return {
    id: `source:${path || label}`,
    group: sourceFileGroup(label),
    kind: 'source',
    title: sourceFileLabel(label),
    subtitle: sourceFilePurpose(label, String(record.purpose ?? t('dev.sourceFilePurposeFallback'))),
    status: t('dev.statusSource'),
    source: path,
    owner: sourceFileOwner(label),
    value: sourceFileText(file) || record,
    metadata: {
      ...record,
      injectsPrompt: label === 'System prompt service' || label === 'Agent spine',
      registersTool: label === 'Tool registry' || label === 'Agent spine',
      injectsContext: label === 'Agent spine',
    },
    recent: t('dev.loadedFromRuntimeComposition'),
  }
}

function sourceFileGroup(label: string): DevArtifact['group'] {
  if (label === 'System prompt service') return 'Prompts'
  if (label === 'Tool registry') return 'Tools'
  return 'Plugins / Context Providers'
}

function sourceFileText(file: unknown): string {
  const text = asRecord(file).text
  return typeof text === 'string' ? text : ''
}

function sourceFileLabel(label: string): string {
  if (label === 'ACP front door') return t('dev.sourceAcpFrontDoor')
  if (label === 'Agent spine') return t('dev.sourceAgentSpine')
  if (label === 'System prompt service') return t('dev.sourceSystemPromptService')
  if (label === 'Tool registry') return t('dev.sourceToolRegistry')
  return label
}

function sourceFilePurpose(label: string, fallback: string): string {
  if (label === 'ACP front door') return t('dev.sourceAcpFrontDoorPurpose')
  if (label === 'Agent spine') return t('dev.sourceAgentSpinePurpose')
  if (label === 'System prompt service') return t('dev.sourceSystemPromptServicePurpose')
  if (label === 'Tool registry') return t('dev.sourceToolRegistryPurpose')
  return fallback
}

function sourceFileOwner(label: string): string {
  if (label === 'ACP front door') return '@deepseek-ai/dsh-acp-demo'
  if (label === 'Agent spine') return '@deepseek-ai/dsh-agent-spine-demo'
  if (label === 'System prompt service') return '@deepseek-ai/dsh-system-prompt'
  if (label === 'Tool registry') return '@deepseek-ai/dsh-tools'
  return 'DeepSeek Harness'
}

function pluginsFromConfigText(configText: string, source: string): unknown[] {
  const blocks = configText.split(/\n(?=-\s+id:\s*)/)
  return blocks.map((block) => {
    const id = block.match(/-\s+id:\s*['"]?([^'"\n]+)['"]?/)?.[1]?.trim()
    const name = block.match(/\n\s*name:\s*['"]?([^'"\n]+)['"]?/)?.[1]?.trim()
    if (id === undefined && name === undefined) return undefined
    return {
      id: id ?? name ?? '',
      name: name ?? id ?? '',
      source,
      configPreview: block.trim(),
    }
  }).filter(plugin => plugin !== undefined)
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
        subtitle: String(record.description ?? record.summary ?? t('dev.registeredModelTool')),
        status: t('dev.statusRegistered'),
        source: toolImplementationSource(name, plugin),
        owner: String(asRecord(plugin).name ?? asRecord(owner).path ?? '@deepseek-ai/dsh-tools'),
        value: schema,
        metadata: {
          fullTool: tool,
          ownerPlugin: plugin ?? t('dev.noMatchingPlugin'),
          registry: owner ?? { path: PATH_TOOL_REGISTRY },
          recentToolCall: recent ?? t('dev.noPersistedCall'),
        },
        recent: recentToolSummary(recent) || (request.event === undefined ? t('dev.noRequestEvidence') : `${t('dev.schemaLastSeen')} ${request.seq}`),
      } satisfies DevArtifact
    })
  }
  const toolPlugins = plugins.filter((plugin) => {
    const record = asRecord(plugin)
    const id = String(record.id ?? '')
    const name = String(record.name ?? '')
    return id.includes('tool') || name.includes('tool') || id === 'bash' || id.includes('subagent') || id.includes('workflow')
  })
  return toolPlugins.map((plugin) => {
    const record = asRecord(plugin)
    const id = String(record.id ?? 'tool')
    const recent = recentToolCalls.find((call) => {
      const name = String(asRecord(call).name)
      return toolLikelyOwnedByPlugin(name, record) || id.includes(name)
    })
    return {
      id: `tool-plugin:${id}`,
      group: 'Tools',
      kind: 'tool',
      title: id,
      subtitle: String(record.name ?? t('dev.toolProviderPlugin')),
      status: t('dev.statusProvider'),
      source: toolImplementationSource(id, plugin),
      owner: String(record.name ?? '@deepseek-ai/dsh-tools'),
      value: String(record.configPreview ?? '').trim() || t('dev.toolSchemaAfterRequest'),
      metadata: {
        plugin,
        registry: owner ?? { path: PATH_TOOL_REGISTRY },
        recentToolCall: recent ?? t('dev.noPersistedCall'),
      },
      recent: recentToolSummary(recent) || t('dev.noRequestSchema'),
    }
  })
}

function recentPromptSummary(recentPromptUses: unknown[], request: RequestContextSnapshot): string {
  const latest = asRecord(recentPromptUses[0])
  if (latest.sessionId !== undefined) return `${t('dev.lastUsedIn')} ${shortId(String(latest.sessionId))} · ${t('common.seq')} ${String(latest.seq ?? '?')}`
  if (request.event !== undefined) return `${t('dev.observedInSelectedTrace')} · ${t('common.seq')} ${request.seq}`
  return t('dev.noRequestEvidence')
}

function recentToolSummary(call: unknown): string {
  const record = asRecord(call)
  if (record.name === undefined) return ''
  return `${String(record.count ?? 0)} ${t('dev.calls')} · ${t('dev.last')} ${shortId(String(record.lastSessionId ?? 'session'))} ${t('common.seq')} ${String(record.lastSeq ?? '?')}`
}

function pluginToArtifact(plugin: unknown): DevArtifact {
  const record = asRecord(plugin)
  const id = String(record.id ?? 'plugin')
  const name = String(record.name ?? '')
  const role = pluginRoleKind(record)
  return {
    id: `plugin:${id}`,
    group: 'Plugins / Context Providers',
    kind: 'plugin',
    title: id,
    subtitle: name || t('dev.cordisConfigEntry'),
    status: pluginRoleLabel(role),
    source: String(record.source ?? 'examples/acp-agent/cordis.yml'),
    owner: name || id,
    value: String(record.configPreview ?? '').trim() || { id, name },
    metadata: {
      injectsPrompt: role === 'prompt',
      registersTool: role === 'tool',
      injectsContext: role === 'context-policy' || id.includes('hooks') || id.includes('repeat'),
      dependencyNote: t('dev.dependencyNote'),
    },
    recent: t('dev.loadedFromConfig'),
  }
}

function pluginRoleKind(plugin: Record<string, unknown>): PluginRole {
  const id = String(plugin.id ?? '')
  const name = String(plugin.name ?? '')
  if (id.includes('tool') || name.includes('tool') || id === 'bash' || id.includes('workflow') || id.includes('subagent')) return 'tool'
  if (id.includes('prompt') || name.includes('prompt') || id === 'acp-agent') return 'prompt'
  if (id.includes('hooks') || id.includes('guard') || id.includes('permission')) return 'context-policy'
  if (id.includes('llm')) return 'model'
  return 'plugin'
}

function pluginRoleLabel(role: PluginRole): string {
  if (role === 'tool') return t('dev.registersTool')
  if (role === 'prompt') return t('dev.injectsPrompt')
  if (role === 'context-policy') return t('dev.contextPolicyProvider')
  if (role === 'model') return t('dev.modelProvider')
  return t('dev.plugin')
}

function toolLikelyOwnedByPlugin(toolName: string, plugin: Record<string, unknown>): boolean {
  const id = String(plugin.id ?? '').replace(/^tool-/, '')
  const name = String(plugin.name ?? '')
  return toolName.includes(id) || id.includes(toolName) || name.includes(toolName)
}

function toolImplementationSource(toolName: string, plugin: unknown): string {
  const packageName = String(asRecord(plugin).name ?? '')
  if (packageName.startsWith('@deepseek-ai/dsh-')) return `packages/${packageName.replace('@deepseek-ai/dsh-', '').replace(/^tool-/, 'tool-')}/`
  if (toolName === 'bash') return PATH_TOOL_BASH
  if (toolName === 'subagent' || toolName === 'subagent_fork') return PATH_TOOL_SUBAGENT
  return PATH_TOOL_REGISTRY
}

function modelFromConfigText(text: string): string {
  const match = text.match(/^\s*model:\s*(.+?)\s*$/m)
  return match?.[1] ?? 'unknown'
}

function extractPersonaFromConfig(text: string): string {
  const match = text.match(/persona:\s*\|\n([\s\S]*?)(?:\n\S|\n\s*#|$)/)
  if (match === null) return ''
  return (match[1] ?? '').split('\n').map(line => line.replace(/^ {6}/, '')).join('\n').trim()
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
    system: typeof systemValue === 'string' ? systemValue : renderValue(systemValue),
    tools: Array.isArray(toolsValue) ? toolsValue : [],
    messagePrefix: header.messagePrefix ?? delta.messagePrefix ?? [],
  }
}

/* ── Shared event/value helpers ───────────────────────────────────────────── */

function usageOfEvent(event: SessionEvent): { input: string; output: string; think: string } {
  const usage = asRecord(asRecord(event.data).usage)
  const cell = (value: unknown): string => {
    const numberValue = Number(value)
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue.toLocaleString() : ''
  }
  return {
    input: cell(usage.inputTokens ?? usage.input_tokens),
    output: cell(usage.outputTokens ?? usage.output_tokens),
    think: cell(usage.reasoningTokens ?? usage.reasoning_tokens),
  }
}

function sumTokens(kind: 'input' | 'output'): string {
  let total = 0
  for (const event of state.trace?.events ?? []) {
    if (event.type !== 'assistant/message') continue
    const usage = asRecord(asRecord(event.data).usage)
    const value = kind === 'input' ? usage.inputTokens ?? usage.input_tokens : usage.outputTokens ?? usage.output_tokens
    const numberValue = Number(value)
    if (Number.isFinite(numberValue)) total += numberValue
  }
  return total.toLocaleString()
}

function runtimeStateLabel(value: string): string {
  if (value === 'running') return t('runtime.running')
  if (value === 'error') return t('runtime.error')
  if (value === 'starting') return t('runtime.starting')
  return value
}

function runtimeLabel(): string {
  return `ACP ${runtimeStateLabel(String(asRecord(state.runtime).state ?? 'starting'))}`
}

function runtimeStateClass(): string {
  const value = String(asRecord(state.runtime).state ?? 'starting')
  if (value === 'running') return 'running'
  if (value === 'error') return 'error'
  return 'starting'
}

function runtimeRepoRoot(): string {
  return String(asRecord(state.runtime).repoRoot ?? '')
}

function gitField(key: string): string {
  const git = asRecord(asRecord(state.dev).git)
  return String(git[key] ?? t('dev.unknown'))
}


function asSessionUpdate(value: unknown): SessionUpdatePayload {
  const record = asRecord(value)
  return { sessionId: String(record.sessionId ?? ''), update: asRecord(record.update) }
}

function hasDesktopApi(): boolean {
  return window.dshDesktop !== undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
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
  if (value === undefined) return t('dev.unknown')
  return renderValue(value)
}

/** Formats an inspector payload as plain text, pretty JSON, JSONL rows, or YAML. */
function formatPayload(value: unknown, format: PayloadFormat): string {
  if (value === undefined || value === null || value === '') return ''
  if (format === 'json') return JSON.stringify(value, null, 2)
  if (format === 'jsonl') {
    const rows = Array.isArray(value) ? value : [value]
    return rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n')
  }
  if (format === 'yaml') return toYaml(value)
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(item => asRecord(item).type !== undefined)) return contentText(value)
  return JSON.stringify(value, null, 2)
}

function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent)
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object') return `${pad}-\n${toYaml(item, indent + 2)}`
      return `${pad}- ${toYaml(item)}`
    }).join('\n')
  }
  return Object.entries(value).map(([key, item]) => {
    if (item !== null && typeof item === 'object') return `${pad}${key}:\n${toYaml(item, indent + 2)}`
    return `${pad}${key}: ${toYaml(item)}`
  }).join('\n')
}

function formatMs(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '0ms'
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(2)}s` : `${Math.round(milliseconds)}ms`
}

function formatRelativeTime(time: number): string {
  const diff = Date.now() - time
  if (!Number.isFinite(diff) || diff < 60_000) return t('common.now')
  if (diff < 3_600_000) return relativeTime(Math.round(diff / 60_000), t('common.minutesAgo'))
  if (diff < 86_400_000) return relativeTime(Math.round(diff / 3_600_000), t('common.hoursAgo'))
  return relativeTime(Math.round(diff / 86_400_000), t('common.daysAgo'))
}

function relativeTime(value: number, unit: string): string {
  return state.locale === 'zh-CN' ? `${value}${unit}前` : `${value} ${unit}${value === 1 ? '' : 's'} ago`
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

/* ── Markdown (ported from trace-workbench): escape first, then structure ─── */

function mdInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

function mdSplitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

const MD_TABLE_ROW = /^\s*\|.*\|\s*$/
const MD_TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/

function renderMarkdown(text: string): string {
  const lines = escapeHtml(text).split('\n')
  const out: string[] = []
  let inCode = false
  let listType: 'ul' | 'ol' | null = null
  const closeList = (): void => {
    if (listType !== null) {
      out.push(`</${listType}>`)
      listType = null
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
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
    if (MD_TABLE_ROW.test(line) && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      closeList()
      const header = mdSplitRow(line)
      const aligns = mdSplitRow(lines[i + 1]!).map((cell) => {
        if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
        if (cell.endsWith(':')) return 'right'
        return ''
      })
      i += 1
      const tableRows: string[][] = []
      while (i + 1 < lines.length && MD_TABLE_ROW.test(lines[i + 1]!)) {
        i += 1
        tableRows.push(mdSplitRow(lines[i]!))
      }
      const cellHtml = (tag: string, cells: string[]): string => cells.map((cell, k) =>
        `<${tag}${aligns[k] !== undefined && aligns[k] !== '' ? ` style="text-align:${aligns[k]}"` : ''}>${mdInline(cell)}</${tag}>`).join('')
      out.push('<div class="md-table-wrap"><table class="md-table">')
      out.push(`<thead><tr>${cellHtml('th', header)}</tr></thead>`)
      out.push(`<tbody>${tableRows.map(row => `<tr>${cellHtml('td', row)}</tr>`).join('')}</tbody>`)
      out.push('</table></div>')
      continue
    }
    if (/^\s*&gt;\s?/.test(line)) {
      closeList()
      const quote: string[] = []
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*&gt;\s?/, ''))
        i += 1
      }
      i -= 1
      out.push(`<blockquote>${quote.map(entry => mdInline(entry)).join('<br>')}</blockquote>`)
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading !== null) {
      closeList()
      const level = Math.min(heading[1]!.length + 2, 5)
      out.push(`<h${level} class="md-h">${mdInline(heading[2]!)}</h${level}>`)
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
    if (ordered !== null) {
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li value="${ordered[1]}">${mdInline(ordered[2]!)}</li>`)
      continue
    }
    if (line.trim().length === 0) {
      closeList()
      continue
    }
    out.push(`<p>${mdInline(line)}</p>`)
  }
  if (inCode) out.push('</pre>')
  closeList()
  return out.join('\n')
}
