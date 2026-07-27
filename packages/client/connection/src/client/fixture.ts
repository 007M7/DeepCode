// FixtureApi: standalone UI development without a server. Real contract shape: unary takes
// RpcRequest<P> and returns RpcResponse<T> (echoing the rpcId); streams yield RpcRequest<frame>
// (the fixture IS the fake server, so it mints frame rpcIds); root respond takes ClientResponse
// and returns RpcReceipt. fx-alpha carries a hand-built history script (60 turns, pageable);
// prompt triggers a chunked streaming replay; cancel stops the replay; resident pending
// approval/question requests exercise replay and composer takeover with stable rpcIds.

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, SessionId, TodoItem } from '@deepseek-ai/dsh-session/types'
import type {
  ApiProxy, ClientRequest, ClientResponse, HistoryEntry, HostFrame, MuxFrame, RpcReceipt,
  RpcRequest, RpcResponse, RpcResult, ServerRequest, ServerResponse, SessionSummary,
  ToolCallView, ToolEventView, ToolResultView, WorkspaceId, WorkspaceView,
} from './api.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient, RpcId } from './api.ts'

/** The fake carrier mints like a real one (business code never mints). */
function rpcRequest<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(crypto.randomUUID()), payload }
}

function text(t: string): ContentBlock[] {
  return [{ type: 'text', text: t }]
}

const MARKDOWN_FIXTURE = [
  '# Markdown fixture',
  '',
  'Assistant output renders **strong text**, *emphasis*, and `inline code`.',
  '',
  '- first item',
  '  - nested item',
  '',
  '| Surface | State |',
  '| --- | --- |',
  '| history | rendered |',
  '| streaming | stable |',
  '',
  '[DeepSeek](https://www.deepseek.com)',
  '',
  '```ts',
  'const markdown = true',
  '```',
].join('\n')

const USER_MARKDOWN_LITERAL = '用户字面量：# 不渲染 `code` [link](https://example.com)'

function sid(id: string): SessionId {
  return id as SessionId
}

/** fx-alpha history script: 60 turns (~130+ messages -> 3 pages at PAGE_MESSAGES=50),
 *  mixing reasoning blocks / tool call+result / steering / context. */
function buildAlphaLog(): SessionEvent[] {
  const events: Record<string, unknown>[] = []
  let time = Date.now() - 3_600_000
  const push = (e: Record<string, unknown>): number => {
    const seq = events.length
    events.push({ seq, time: (time += 800), ...e })
    return seq
  }
  for (let turn = 0; turn < 60; turn++) {
    push({ type: 'turn/start', data: { turn, trigger: { kind: 'message', source: { kind: 'user' } } } })
    const userSeq = push({
      type: 'user/message', surfaceOp: 'append',
      data: {
        content: text(turn === 59 ? USER_MARKDOWN_LITERAL : `问题 ${turn}：fixture 历史消息，用于翻页与渲染验收。`),
        source: { kind: 'user' },
      },
    })
    if (turn === 0) {
      push({
        type: 'session/title',
        data: { title: 'Fixture 历史会话', messageSeqs: [userSeq], source: { kind: 'fallback' } },
      })
    }
    if (turn % 9 === 4) {
      push({ type: 'user/message', surfaceOp: 'append', data: { content: text(`[fixture] 上下文注入（turn ${turn}）`), source: { kind: 'plugin', plugin: 'fixture' } } })
    }
    push({ type: 'step/start', data: { turn, step: 0 } })
    const withTool = turn % 5 === 2
    const withReasoning = turn % 3 === 1
    const blocks: ContentBlock[] = []
    if (withReasoning) blocks.push({ type: 'reasoning', text: `思考过程 ${turn}：这是一段可折叠的 reasoning 内容。` })
    blocks.push({ type: 'text', text: turn === 59 ? MARKDOWN_FIXTURE : `回答 ${turn}：这是 fixture 生成的历史回复正文。` })
    if (withTool) {
      const callId = `fx-call-${turn}`
      blocks.push({ type: 'tool-call', id: callId, name: 'echo', arguments: `{"text":"turn ${turn}"}` } as ContentBlock)
      push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 0, content: blocks, provenance: { provider: 'fixture', model: 'fx-1' } } })
      push({ type: 'tool/call', data: { turn, step: 0, callId, name: 'echo', arguments: `{"text":"turn ${turn}"}` } })
      push({ type: 'tool/result', surfaceOp: 'append', data: { turn, step: 0, callId, content: text(`ECHO: TURN ${turn}`), isError: turn % 25 === 12 } })
      push({ type: 'step/end', data: { turn, step: 0 } })
      push({ type: 'step/start', data: { turn, step: 1 } })
      push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, content: text(`工具结果已消化（turn ${turn}）。`), provenance: { provider: 'fixture', model: 'fx-1' } } })
      push({ type: 'step/end', data: { turn, step: 1 } })
    } else {
      push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 0, content: blocks, provenance: { provider: 'fixture', model: 'fx-1' } } })
      push({ type: 'step/end', data: { turn, step: 0 } })
    }
    if (turn % 13 === 6) {
      push({ type: 'steering/message', surfaceOp: 'append', data: { turn, content: text(`插话 ${turn}：fixture steering 消息。`), source: { kind: 'user' } } })
    }
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  // Three view-sample turns (60-62) cover the built-in card types. The real filesystem names in
  // turns 62-63 also exercise their dedicated generic-row icon/title/path summaries. `echo` above
  // stays presenter-less as the unknown fallback.
  const toolTurn = (turn: number, name: string, args: string, resultText: string): void => {
    const callId = `fx-call-${turn}`
    push({ type: 'turn/start', data: { turn, trigger: { kind: 'message', source: { kind: 'user' } } } })
    push({ type: 'user/message', surfaceOp: 'append', data: { content: text(`问题 ${turn}：${name} 样本。`), source: { kind: 'user' } } })
    push({ type: 'step/start', data: { turn, step: 0 } })
    push({
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn, step: 0, content: [{ type: 'tool-call', id: callId, name, arguments: args } as ContentBlock], provenance: { provider: 'fixture', model: 'fx-1' } },
    })
    push({ type: 'tool/call', data: { turn, step: 0, callId, name, arguments: args } })
    push({ type: 'tool/result', surfaceOp: 'append', data: { turn, step: 0, callId, content: text(resultText), isError: false } })
    push({ type: 'step/end', data: { turn, step: 0 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  toolTurn(60, 'fx-bash', '{"command":"ls -la","cwd":"/tmp/fixture"}', 'total 2\ndrwxr-xr-x fixture\n-rw-r--r-- demo.txt')
  toolTurn(61, 'fx-write', '{"path":"notes/demo.txt","content":"hello fixture\\n"}', 'wrote notes/demo.txt')
  toolTurn(62, 'edit', '{"file_path":"notes/demo.txt","old_string":"hello","new_string":"hello fixture"}', '已编辑')
  toolTurn(63, 'write', '{"file_path":"notes/new-demo.txt","content":"hello fixture\\n"}', '已写入')
  // Turn 64: one run_code turn with three logged sub-dispatches — the Code
  // Mode acceptance surface (parent code row + nested native-identical rows,
  // including an isError sub-call and a bash sub-call that must hit the same
  // keyed registration a top-level bash row uses).
  {
    const turn = 64
    const callId = `fx-call-${turn}`
    const program = 'const listing = await tools.bash({ command: "ls notes", description: "List notes" })\n'
      + 'const demo = await tools.read({ path: "notes/demo.txt" })\n'
      + 'await tools.read({ path: "notes/missing.txt" }).catch(() => "tolerated")\n'
      + 'return { listing, demo }'
    const args = JSON.stringify({ code: program, description: 'Read the notes files and summarize' })
    push({ type: 'turn/start', data: { turn, trigger: { kind: 'message', source: { kind: 'user' } } } })
    push({ type: 'user/message', surfaceOp: 'append', data: { content: text(`问题 ${turn}：run_code 样本。`), source: { kind: 'user' } } })
    push({ type: 'step/start', data: { turn, step: 0 } })
    push({
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn, step: 0, content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: args } as ContentBlock], provenance: { provider: 'fixture', model: 'fx-1' } },
    })
    push({ type: 'tool/call', data: { turn, step: 0, callId, name: 'run_code', arguments: args } })
    const dispatchPair = (n: number, name: string, dispatchArgs: Record<string, unknown>, resultText: string, isError = false): void => {
      push({
        type: 'tool/code-dispatch-start',
        data: { parentCallId: callId, subCallId: `${callId}:code:${n}`, name, arguments: dispatchArgs },
      })
      push({
        type: 'tool/code-dispatch',
        data: {
          parentCallId: callId, subCallId: `${callId}:code:${n}`, name,
          arguments: dispatchArgs, isError, content: [{ type: 'text', text: resultText }],
        },
      })
    }
    dispatchPair(1, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt\nnew-demo.txt')
    dispatchPair(2, 'read', { path: 'notes/demo.txt' }, 'hello fixture\n')
    dispatchPair(3, 'read', { path: 'notes/missing.txt' }, 'Error: ENOENT: notes/missing.txt not found', true)
    push({
      type: 'tool/result', surfaceOp: 'append',
      data: { turn, step: 0, callId, content: text('{"listing":"demo.txt\\nnew-demo.txt","demo":"hello fixture\\n"}'), isError: false },
    })
    push({ type: 'step/end', data: { turn, step: 0 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  // Turn 65: todo_write sample — the TodoRow toolview in the flow plus the
  // todo/write snapshot event feeding the TodoPanel plan strip.
  const fixtureTodos = [
    { content: '梳理需求', status: 'completed' },
    { content: '实现 fixture 样本', status: 'in_progress' },
    { content: '浏览器验收', status: 'pending' },
  ]
  const todoArgs = JSON.stringify({ todos: fixtureTodos })
  toolTurn(65, 'todo_write', todoArgs, 'Updated todo list: 1 pending, 1 in progress, 1 completed.')
  // The real tool appends the snapshot mid-execution — between tool/call and
  // tool/result — so the fixture reproduces that exact ordering (the last
  // toolTurn events run ... tool/call, tool/result, step/end, turn/end).
  const callIndex = events.length - 4
  const callTime = events[callIndex]?.time as number
  events.splice(callIndex + 1, 0, { type: 'todo/write', time: callTime + 400, data: { todos: fixtureTodos } })
  events.forEach((e, i) => { e.seq = i })
  return events as unknown as SessionEvent[]
}

/** Narrows a parsed-JSON field to string; fixture args are authored in-file, so non-strings only mean a typo here. */
/* v8 ignore next -- the fallback arm is the same in-file-typo guard as the JSON.parse catch above. */
const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback

/** Fixture presenter registry (mirrors host viewFor): pure derivation, undefined = no view. */
function presentCall(name: string, argsRaw: string): ToolCallView | undefined {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsRaw) as Record<string, unknown>
  } catch {
    /* v8 ignore next 2 -- defensive: fixture args are authored in-file as valid JSON; only an in-file typo could reach the catch. */
    return undefined
  }
  switch (name) {
    case 'fx-bash':
      return { card: 'terminal', title: str(args.command), cwd: str(args.cwd, '/tmp/fixture'), description: 'fixture 终端样本' }
    case 'fx-write':
      return {
        card: 'diff', title: `Write ${str(args.path)}`,
        diffs: [{ path: str(args.path), oldText: null, newText: str(args.content) }],
      }
    case 'edit':
      return { card: 'generic', title: `Edit ${str(args.file_path)}`, kind: 'edit', rawInput: args }
    case 'write':
      return { card: 'generic', title: `Write ${str(args.file_path)}`, kind: 'edit', rawInput: args }
    default:
      return undefined // echo et al: the documented no-view fallback path
  }
}

function presentResult(name: string, argsRaw: string, resultText: string): ToolResultView | undefined {
  const call = presentCall(name, argsRaw)
  if (call === undefined) return undefined
  switch (call.card) {
    case 'terminal':
      return { card: 'terminal', output: resultText, exitCode: 0 }
    case 'diff':
      return { card: 'diff', diffs: call.diffs }
    case 'generic':
      return { card: 'generic', content: text(resultText) }
  }
}

/** Host-side viewFor mirror: tool/call presents from its own args; tool/result back-scans the log for the paired call. */
function viewFor(event: SessionEvent, log: readonly SessionEvent[]): ToolEventView | undefined {
  if (event.type === 'tool/call') {
    const view = presentCall(event.data.name, event.data.arguments)
    return view === undefined ? undefined : { for: 'call', view }
  }
  if (event.type === 'tool/result') {
    const callId = String(event.data.callId)
    for (let i = log.length - 1; i >= 0; i--) {
      const candidate = log[i]
      /* v8 ignore next -- dense-array guard: i stays within [0, log.length),
      so the undefined arm needs a sparse log no code path builds. */
      if (candidate !== undefined && candidate.type === 'tool/call' && String(candidate.data.callId) === callId) {
        const resultText = event.data.content.map(b => (b.type === 'text' ? b.text : '')).join('')
        const view = presentResult(candidate.data.name, candidate.data.arguments, resultText)
        return view === undefined ? undefined : { for: 'result', view }
      }
    }
    return undefined // cross-page unpaired: documented default
  }
  return undefined
}

/** Fold the latest fixture title into the host's control-frame projection. */
function titleFrameOf(id: SessionId, log: readonly SessionEvent[]): Extract<MuxFrame, { type: 'session/title' }> | undefined {
  const event = log.findLast(item => (item as { type: string }).type === 'session/title')
  if (event === undefined) return undefined
  const titleEvent = event as unknown as { seq: number; time: number; data: { title: string } }
  return {
    type: 'session/title',
    sessionId: id,
    title: titleEvent.data.title,
    eventSeq: titleEvent.seq,
    updatedAt: titleEvent.time,
  }
}

/**
 * Message-boundary paging (mirrors the host's paging contract): count
 * maxMessages messages
 *  backwards from end, cut at a turn/start boundary.
 Entries carry pagination-time views
 *  (the host analogue computes viewFor per entry at page time). */
function pageOf(
  log: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { events: HistoryEntry[]; hasMore: boolean } {
  const end = beforeSeq === undefined ? log.length : Math.max(0, Math.min(beforeSeq, log.length))
  let start = 0
  let messages = 0
  for (let i = end - 1; i >= 0; i--) {
    const event = log[i]
    /* v8 ignore next -- dense-array guard: log seqs are array indexes, i stays within [0, end). */
    if (event === undefined) break
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'steering/message') messages++
    if (event.type === 'turn/start' && messages >= maxMessages) {
      start = i
      break
    }
  }
  const events = log.slice(start, end).map((event): HistoryEntry => {
    const view = viewFor(event, log)
    return view === undefined ? { event } : { event, view }
  })
  return { events, hasMore: start > 0 }
}

/** Current todo projection over the full log (host parallel: latest todo/write, last write wins). */
function backscanTodos(log: readonly SessionEvent[]): TodoItem[] | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i]
    if (event !== undefined && event.type === 'todo/write') return event.data.todos
  }
  return undefined
}

interface StreamConn<F> {
  push(envelope: RpcRequest<F>): void
}

/** Deterministic fixture branches used by keyless Web assembly tests. */
export interface FixtureOptions {
  /** Start with no real Workspace or Session. */
  empty?: boolean
  /** Reject every prompt before appending its user event. */
  rejectPrompt?: boolean
  /** Publish the Session but fail its Workspace account write. */
  failWorkspaceAttach?: boolean
  /** Publish and frame the Session, then throw instead of returning create. */
  dropSessionCreateResponse?: boolean
  /** Order of the two successful create frames. */
  createFrameOrder?: 'session-first' | 'workspace-first'
}

/** Inbox pump shared by both stream generators (FrameQueue pattern: ONE abort listener hung
 *  outside the loop — a per-iteration {once:true} listener never fires for non-final rounds and
 *  piles up for the stream's lifetime, audit C5). breakNow force-ends the stream without the
 *  client's signal (timing hook: simulated connection loss). */
class FxInbox<F> implements StreamConn<F> {
  private readonly inbox: RpcRequest<F>[] = []
  private wake: (() => void) | null = null
  private broken = false

  push(envelope: RpcRequest<F>): void {
    this.inbox.push(envelope)
    this.wake?.()
  }

  breakNow(): void {
    this.broken = true
    this.wake?.()
  }

  /** Read through a method: breakNow()/abort flip state across yields, so narrowing from the loop condition must not stick. */
  private isLive(signal: AbortSignal): boolean {
    return !signal.aborted && !this.broken
  }

  async *drain(signal: AbortSignal): AsyncGenerator<RpcRequest<F>> {
    const onAbort = (): void => this.wake?.()
    signal.addEventListener('abort', onAbort)
    try {
      while (this.isLive(signal)) {
        while (this.inbox.length > 0) yield this.inbox.shift() as RpcRequest<F>
        if (!this.isLive(signal)) break
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
        this.wake = null
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * In-memory fake host: fx-alpha carries history and replay scripts; fx-beta is fx-alpha's child session (lineage indent material).
 * @param options - fixture branches for empty state and failure timing.
 * @returns an ApiProxy backed entirely by in-memory state — no host process, no network.
 */
export function createFixtureApi(options: FixtureOptions = {}): ApiProxy {
  // The resident fixture sessions all carry history, so none of them is blank.
  const sessions: SessionSummary[] = options.empty ? [] : [
    { sessionId: sid('fx-alpha'), updatedAt: Date.now(), running: true, blank: false, cwd: '/tmp/fixture' },
    { sessionId: sid('fx-beta'), updatedAt: Date.now() - 60_000, running: false, blank: false, parentSessionId: sid('fx-alpha'), cwd: '/tmp/fixture' },
    { sessionId: sid('fx-gamma'), updatedAt: Date.now() - 120_000, running: false, blank: false, cwd: '/tmp/fixture' },
  ]
  const logs = new Map<SessionId, SessionEvent[]>([[sid('fx-alpha'), buildAlphaLog()]])
  const nextTurn = new Map<SessionId, number>([[sid('fx-alpha'), 60]])
  let nextSession = 1
  let nextRpc = 1
  let attachedSessions = options.empty ? 0 : 1
  // Workspace entities mirroring the host registry: the fixture sessions all
  // live under one workspace, whose account carries them in attach order.
  const wid = (raw: string): WorkspaceId => raw as WorkspaceId
  const fixtureEpoch = new Date(Date.now() - 300_000).toISOString()
  const workspaces: WorkspaceView[] = options.empty ? [] : [{
    workspaceId: wid('fx-ws-fixture'),
    path: '/tmp/fixture',
    title: 'fixture',
    sessionIds: [sid('fx-alpha'), sid('fx-beta'), sid('fx-gamma')],
    createdAt: fixtureEpoch,
    updatedAt: fixtureEpoch,
  }]
  let nextWorkspace = 1
  const mint = (): ReturnType<typeof RpcId> => RpcId(`fx-rpc-${nextRpc++}`)
  /** Resident pending approval (stable rpcId: every mux open replays the same id, matching host replay semantics). */
  const pendingApprovalRpcId = mint()
  const pendingQuestionRpcId = mint()
  let questionPending = true
  const fixtureQuestions: Extract<MuxFrame, { type: 'question/requested' }>['questions'] = [
    {
      id: 'harness-profile',
      header: '偏好',
      question: '你现在更想招哪类 Agent/Harness 候选人？',
      options: [
        { label: '工程落地型 (Recommended)', description: '更看重能直接做 runtime、tool executor、sandbox、trace 和线上问题排查。' },
        { label: '研究潜力型', description: '更看重 Agent 理解、训练评测思路和长期成长空间。' },
        { label: '均衡型', description: '同时要求工程能力和 Agent 认知，但可能筛选门槛更高。' },
      ],
    },
    {
      id: 'work-mode',
      header: '方式',
      question: '你希望候选人优先展示哪种工作方式？',
      options: [
        { label: '先做小型原型 (Recommended)', description: '用可运行结果尽快验证关键假设。' },
        { label: '先写完整设计', description: '先收敛边界、协议和风险，再开始实现。' },
      ],
    },
    {
      id: 'signals',
      header: '信号',
      question: '哪些面试信号最重要？',
      detail: '按当前招聘目标选择；跳过则视为不设偏好。',
      multiSelect: true,
      options: [
        { label: '系统设计' },
        { label: '代码质量' },
        { label: 'Agent 产品判断' },
      ],
    },
  ]

  const muxConns = new Set<StreamConn<MuxFrame>>()
  const hostConns = new Set<StreamConn<HostFrame>>()
  const emitMux = (frame: MuxFrame): void => {
    for (const conn of muxConns) conn.push({ rpcId: mint(), payload: frame })
  }
  const emitHost = (frame: HostFrame): void => {
    for (const conn of hostConns) conn.push({ rpcId: mint(), payload: frame })
  }

  /** OK response echoing the caller's rpcId (contract: responses always backfill, never mint). */
  function ok<P, T>(request: RpcRequest<P>, value: T): Promise<RpcResponse<T>> {
    return Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value } })
  }
  function err<P, T>(request: RpcRequest<P>, error: Extract<RpcResult<T>, { ok: false }>['error']): Promise<RpcResponse<T>> {
    return Promise.resolve({ rpcId: request.rpcId, result: { ok: false, error } })
  }

  const summaryOf = (id: SessionId): SessionSummary | undefined => sessions.find(s => s.sessionId === id)
  /** Shared session guard for sessionId-addressed catalog routes: the error
   *  response when the session is unknown, undefined when it exists. */
  const requireSession = (request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<never>> | undefined => {
    if (summaryOf(request.payload.sessionId) !== undefined) return undefined
    return err<{ sessionId: SessionId }, never>(request, {
      code: 'session-not-found',
      message: `no session ${request.payload.sessionId}`,
      details: { sessionId: request.payload.sessionId },
    })
  }
  const setRunning = (id: SessionId, running: boolean): void => {
    const summary = summaryOf(id)
    if (summary === undefined || summary.running === running) return
    summary.running = running
    emitHost({ type: 'host/session-status', sessionId: id, running })
  }
  const logOf = (id: SessionId): SessionEvent[] => {
    let log = logs.get(id)
    if (log === undefined) {
      log = []
      logs.set(id, log)
    }
    return log
  }
  const append = (id: SessionId, e: Record<string, unknown>): void => {
    const log = logOf(id)
    const event = { seq: log.length, time: Date.now(), ...e } as unknown as SessionEvent
    log.push(event)
    // Emission-time view derivation (mirrors the host's live path).
    const view = viewFor(event, log)
    /* v8 ignore next 3 -- the view-present arm needs a live tool/call emission,
    but the fixture replay produces text-only turns; view vocabulary is
    exercised through the history samples (turns 60-62). */
    emitMux(view === undefined
      ? { type: 'session/event', sessionId: id, event }
      : { type: 'session/event', sessionId: id, event, view })
    if ((event as { type: string }).type === 'session/title') {
      // The raw title is already in this log, so the latest-title fold must find it.
      emitMux(titleFrameOf(id, log) as Extract<MuxFrame, { type: 'session/title' }>)
    }
  }

  /** At most one in-flight replay per session; cancel clears it. */
  const replays = new Map<SessionId, { timer: ReturnType<typeof setTimeout>; finish(aborted: boolean): void }>()

  /** history transit delay (timing hooks below); the page snapshot is taken at request time, like a real host. */
  let historyDelayMs = 0
  /** One-shot history failure (timing hook: the doomed in-flight request of the S4 reconnect scenario). */
  let failNextHistory = false
  /** Force-enders for currently open stream generators (timing hook: simulated connection loss). */
  const streamBreakers = new Set<() => void>()

  // Timing-acceptance hooks (browser test backdoor): the in-memory fixture is ideally timed, which
  // is exactly what masked the open-window and reconnect-gap bugs (audit S1/S3). These let
  // browser acceptance runs create slow-history, lost-frame, and reconnect
  // windows a real host produces naturally.
  const timingHooks = {
    setHistoryDelay(ms: number): void {
      historyDelayMs = ms
    },
    /** Fail the NEXT history call (after its transit delay) with a transport-level throw. */
    failNextHistory(): void {
      failNextHistory = true
    },
    /** Log append + mux emit (the normal live path). */
    appendUser(id: string, msg: string): void {
      append(sid(id), { type: 'user/message', surfaceOp: 'append', data: { content: text(msg), source: { kind: 'user' } } })
    },
    /** Append a later durable title revision through the normal raw-event + control-frame path. */
    appendTitle(id: string, title: string): void {
      const log = logOf(sid(id))
      const messageSeqs = log.filter(event => event.type === 'user/message').map(event => event.seq)
      append(sid(id), { type: 'session/title', data: { title, messageSeqs, source: { kind: 'provider', provider: 'fixture' } } })
    },
    /** Log append WITHOUT the mux emit: a frame lost in transit — history still serves it, the client must repull. */
    appendSilent(id: string, msg: string): void {
      const log = logOf(sid(id))
      log.push({ type: 'user/message', surfaceOp: 'append', seq: log.length, time: Date.now(), data: { content: text(msg), source: { kind: 'user' } } } as unknown as SessionEvent)
    },
    /** End every open stream generator (client sees both streams close -> reconnect + resync path). */
    breakStreams(): void {
      for (const breakNow of [...streamBreakers]) breakNow()
    },
  }
  ;(globalThis as Record<string, unknown>).__fxTiming = timingHooks

  /** Prompt replay: chunk typewriter (80ms/frame) -> assistant/message finalize -> turn/end + running flip. */
  const startReply = (id: SessionId, turn: number, replyText: string): void => {
    const step = 0
    append(id, { type: 'step/start', data: { turn, step } })
    append(id, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'block-start', index: 0, blockType: 'text' } } })
    /* v8 ignore next -- the ?? arm needs a null match, but every fixture reply is non-empty. */
    const pieces = replyText.match(/[\s\S]{1,6}/gu) ?? [replyText]
    let i = 0
    const finish = (aborted: boolean): void => {
      replays.delete(id)
      const done = pieces.slice(0, i).join('')
      append(id, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: done } } } })
      append(id, { type: 'assistant/message', surfaceOp: 'append', data: { turn, step, content: text(aborted ? `${done}（已中断）` : done), provenance: { provider: 'fixture', model: 'fx-1' } } })
      append(id, { type: 'step/end', data: { turn, step } })
      append(id, { type: 'turn/end', data: { turn, reason: { kind: aborted ? 'cancelled' : 'completed' } } })
      setRunning(id, false)
    }
    const tick = (): void => {
      const piece = pieces[i]
      if (piece === undefined) {
        finish(false)
        return
      }
      i++
      append(id, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'text-delta', index: 0, text: piece } } })
      replays.set(id, { timer: setTimeout(tick, 80), finish })
    }
    replays.set(id, { timer: setTimeout(tick, 80), finish })
  }

  return {
    sessions: {
      list: request => ok(request, { items: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt) }),
      create: async (request) => {
        const workspace = request.payload.workspaceId === undefined
          ? undefined
          : workspaces.find(w => w.workspaceId === request.payload.workspaceId)
        if (request.payload.workspaceId !== undefined && workspace === undefined) {
          return err(request, {
            code: 'workspace-not-found',
            message: `no workspace ${request.payload.workspaceId}`,
            details: { workspaceId: request.payload.workspaceId },
          })
        }
        const cwd = workspace?.path ?? request.payload.cwd ?? '/tmp/fixture'
        const requestedId = request.payload.sessionId
        const attachWorkspace = (sessionId: SessionId): void => {
          /* v8 ignore next -- callers enter only when a target Workspace exists. */
          if (workspace === undefined || workspace.sessionIds.includes(sessionId)) return
          workspace.sessionIds = [sessionId, ...workspace.sessionIds]
          workspace.updatedAt = new Date().toISOString()
          emitHost({ type: 'host/workspace-changed', workspace: { ...workspace } })
        }
        const attachFailure = (
          sessionId: SessionId,
          workspaceId: WorkspaceId,
        ): Promise<RpcResponse<{ sessionId: SessionId }>> => err(request, {
          code: 'workspace-attach-failed' as const,
          message: `fixture rejected Workspace attachment for ${sessionId}`,
          details: { sessionId, workspaceId },
        })
        if (requestedId !== undefined) {
          const existing = summaryOf(requestedId)
          if (existing !== undefined) {
            if (existing.cwd !== cwd) {
              return err(request, {
                code: 'session-conflict',
                message: `session ${requestedId} already uses ${existing.cwd ?? 'no cwd'}`,
                details: { sessionId: requestedId, requestedCwd: cwd, ...existing.cwd === undefined ? {} : { existingCwd: existing.cwd } },
              })
            }
            if (workspace !== undefined && !workspace.sessionIds.includes(requestedId)) {
              if (options.failWorkspaceAttach) return attachFailure(requestedId, workspace.workspaceId)
              attachWorkspace(requestedId)
            }
            return ok(request, { sessionId: requestedId })
          }
        }
        const created: SessionSummary = {
          sessionId: requestedId ?? sid(`fx-${nextSession++}`), updatedAt: Date.now(), running: false, blank: true, cwd,
        }
        sessions.push(created)
        attachedSessions += 1
        const emitSession = (): void => {
          // Mirrors the host: the frame fires at creation, so blank is constantly true.
          emitHost({ type: 'host/session-added', sessionId: created.sessionId, blank: true, cwd })
        }
        if (workspace !== undefined && options.failWorkspaceAttach) {
          emitSession()
          return attachFailure(created.sessionId, workspace.workspaceId)
        }
        if (workspace !== undefined && options.createFrameOrder === 'workspace-first') {
          attachWorkspace(created.sessionId)
          emitSession()
        } else {
          emitSession()
          if (workspace !== undefined) attachWorkspace(created.sessionId)
        }
        if (options.dropSessionCreateResponse) throw new Error('fixture: dropped session.create response after publication')
        return ok(request, { sessionId: created.sessionId })
      },
      history: async (request) => {
        const log = logs.get(request.payload.sessionId) ?? []
        // Snapshot at request time, deliver after the transit delay (mirrors a real host under latency).
        const page = pageOf(log, request.payload.beforeSeq, request.payload.maxMessages ?? 50)
        // Tail page carries the session-level todo projection (host parallel: full-log backscan).
        const todos = request.payload.beforeSeq === undefined ? backscanTodos(log) : undefined
        const doomed = failNextHistory
        failNextHistory = false
        const delay = historyDelayMs
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        if (doomed) throw new Error('fixture: simulated history transport failure')
        return ok(request, { ...page, ...todos === undefined ? {} : { todos } })
      },
      prompt: (request) => {
        const { sessionId: id, mode, content } = request.payload
        const summary = summaryOf(id)
        if (summary === undefined) {
          return err(request, { code: 'session-not-found', message: `no session ${id}`, details: { sessionId: id } })
        }
        if (options.rejectPrompt) {
          return err(request, {
            code: 'agent-busy',
            message: 'fixture: prompt rejected before acceptance',
            details: { reason: 'fixture-prompt-rejection' },
          })
        }
        summary.updatedAt = Date.now()
        // First accepted prompt appends events: the summary stops being blank.
        summary.blank = false
        const userText = content.map(b => (b.type === 'text' ? b.text : '')).join('')
        if (mode === 'steer' && replays.has(id)) {
          // Steering: insert a steering message into the current turn; the replay continues.
          /* v8 ignore next -- the ?? arm needs a missing counter, but a live replay implies a prior prompt already set it. */
          const turn = (nextTurn.get(id) ?? 1) - 1
          append(id, { type: 'steering/message', surfaceOp: 'append', data: { turn, content, source: { kind: 'user' } } })
          return ok(request, { accepted: true as const })
        }
        const turn = nextTurn.get(id) ?? 0
        nextTurn.set(id, turn + 1)
        setRunning(id, true)
        append(id, { type: 'turn/start', data: { turn, trigger: { kind: 'message', source: { kind: 'user' } } } })
        append(id, { type: 'user/message', surfaceOp: 'append', data: { content, source: { kind: 'user' } } })
        startReply(
          id,
          turn,
          userText === 'render markdown'
            ? MARKDOWN_FIXTURE
            : `回声：${userText}。这是 fixture 的流式回复，用于验证打字机增长与定稿切换。`,
        )
        return ok(request, { accepted: true as const })
      },
      cancel: (request) => {
        const replay = replays.get(request.payload.sessionId)
        if (replay !== undefined) {
          clearTimeout(replay.timer)
          replay.finish(true)
        } else {
          setRunning(request.payload.sessionId, false)
        }
        return ok(request, { accepted: true as const })
      },
    },
    host: {
      describe: request => ok(request, { version: '0.0.0-fixture', cwd: '/tmp/fixture', attachedSessions }),
    },
    workspace: {
      list: request => ok(request, { items: workspaces.map(w => ({ ...w })) }),
      create: (request) => {
        const { path, name } = request.payload
        const target = path ?? `/tmp/fixture-workspaces/${name ?? ''}`
        const existing = workspaces.find(w => w.path === target)
        if (existing !== undefined) return ok(request, { workspace: { ...existing }, created: false })
        const now = new Date().toISOString()
        const created: WorkspaceView = {
          workspaceId: wid(`fx-ws-${nextWorkspace++}`),
          path: target,
          title: name ?? target.split('/').filter(Boolean).at(-1) ?? target,
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        }
        workspaces.unshift(created)
        emitHost({ type: 'host/workspace-changed', workspace: { ...created } })
        return ok(request, { workspace: { ...created }, created: true })
      },
      rename: (request) => {
        const { workspaceId, title } = request.payload
        const workspace = workspaces.find(w => w.workspaceId === workspaceId)
        if (workspace === undefined) {
          return err(request, {
            code: 'workspace-not-found',
            message: `no workspace ${workspaceId}`,
            details: { workspaceId },
          })
        }
        const trimmed = title.trim()
        if (trimmed !== workspace.title) {
          if (workspaces.some(w => w.workspaceId !== workspaceId && w.title === trimmed)) {
            return err(request, {
              code: 'workspace-name-conflict',
              message: `workspace name '${trimmed}' is already in use`,
              details: { name: trimmed },
            })
          }
          workspace.title = trimmed
          workspace.updatedAt = new Date().toISOString()
          emitHost({ type: 'host/workspace-changed', workspace: { ...workspace } })
        }
        return ok(request, { workspace: { ...workspace } })
      },
      insertSessionBefore: (request) => {
        const { workspaceId, sessionId, beforeSessionId } = request.payload
        const workspace = workspaces.find(w => w.workspaceId === workspaceId)
        if (workspace === undefined) {
          return err(request, {
            code: 'workspace-not-found',
            message: `no workspace ${workspaceId}`,
            details: { workspaceId },
          })
        }
        if (!workspace.sessionIds.includes(sessionId)
          || (beforeSessionId !== undefined && !workspace.sessionIds.includes(beforeSessionId))) {
          return err(request, {
            code: 'workspace-move-invalid',
            message: `session or anchor is not accounted by workspace ${workspaceId}`,
            details: { workspaceId, sessionId, ...beforeSessionId === undefined ? {} : { beforeSessionId } },
          })
        }
        const without = workspace.sessionIds.filter(id => id !== sessionId)
        const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
        const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
        if (!sessionIds.every((id, index) => id === workspace.sessionIds[index])) {
          workspace.sessionIds = sessionIds
          workspace.updatedAt = new Date().toISOString()
          emitHost({ type: 'host/workspace-changed', workspace: { ...workspace } })
        }
        return ok(request, { workspace: { ...workspace } })
      },
    },
    commands: {
      // The catalog mirrors one session's effective view (every fixture
      // session has an agent, like the real host).
      list: (request) => {
        const missing = requireSession(request)
        if (missing !== undefined) return missing
        return ok(request, {
          commands: [
            { name: 'compact', description: 'fixture：压缩当前会话上下文' },
            { name: 'echo', description: 'fixture：回显参数', input: { hint: 'text to echo' } },
            { name: 'goal-fixture', description: 'fixture：目标样本命令', input: { hint: '<objective>' } },
          ],
        })
      },
      execute: (request) => {
        const missing = requireSession(request)
        if (missing !== undefined) return missing
        const line = request.payload.line.trim()
        const match = /^\/(\S+)(?:\s+(.*))?$/.exec(line)
        const name = match?.[1]
        if (name === 'compact' || name === 'echo') {
          return ok(request, {
            matched: true as const,
            result: { kind: 'success' as const, text: name === 'echo' ? (match?.[2] ?? '') : 'fixture：已压缩（假动作）' },
          })
        }
        if (name === 'goal-fixture') {
          return ok(request, {
            matched: true as const,
            result: { kind: 'success' as const, text: `fixture：goal 已设置（${request.payload.sessionId}）` },
          })
        }
        return ok(request, { matched: false as const })
      },
    },
    skills: {
      list: (request) => {
        const missing = requireSession(request)
        if (missing !== undefined) return missing
        return ok(request, {
          skills: [
            { name: 'fixture-demo', description: 'fixture 技能样本', whenToUse: '仅供 UI 目录渲染验收' },
          ],
        })
      },
    },
    events: {
      async *mux(_request, signal) {
        const conn = new FxInbox<MuxFrame>()
        muxConns.add(conn)
        const breakNow = (): void => { conn.breakNow() }
        streamBreakers.add(breakNow)
        // Open baseline: subscribed sessions + pending interactions replayed with stable rpcIds.
        for (const s of sessions) {
          if (!s.running) continue
          conn.push({ rpcId: mint(), payload: { type: 'session/subscribed', sessionId: s.sessionId, lastSeq: (logs.get(s.sessionId)?.length ?? 0) - 1 } })
          const title = titleFrameOf(s.sessionId, logs.get(s.sessionId) ?? [])
          if (title !== undefined) conn.push({ rpcId: mint(), payload: title })
        }
        conn.push({
          rpcId: pendingApprovalRpcId,
          payload: {
            type: 'approval/requested', sessionId: sid('fx-alpha'),
            approvalId: 'fx-approval-1' as MuxFrame extends never ? never : Extract<MuxFrame, { type: 'approval/requested' }>['approvalId'],
            toolName: 'dangerous_tool', reason: 'fixture 常驻占位审批（可见不可答）',
          },
        })
        if (questionPending) {
          conn.push({
            rpcId: pendingQuestionRpcId,
            payload: {
              type: 'question/requested', sessionId: sid('fx-alpha'), questions: fixtureQuestions,
            },
          })
        }
        try {
          yield* conn.drain(signal)
        } finally {
          streamBreakers.delete(breakNow)
          muxConns.delete(conn)
        }
      },
      async *host(_request, signal) {
        const conn = new FxInbox<HostFrame>()
        hostConns.add(conn)
        const breakNow = (): void => { conn.breakNow() }
        streamBreakers.add(breakNow)
        // Periodic material (the RPC-panel acceptance's clear-then-new-frames step depends on it): flip fx-gamma every 5s.
        // fx-gamma only: never touch fx-alpha's running semantics (the conversation replay drives that).
        const timer = setInterval(() => {
          const gamma = summaryOf(sid('fx-gamma'))
          /* v8 ignore next -- the undefined arm needs fx-gamma deleted, but the fixture never removes sessions. */
          if (gamma !== undefined) setRunning(gamma.sessionId, !gamma.running)
        }, 5000)
        try {
          yield* conn.drain(signal)
        } finally {
          clearInterval(timer)
          streamBreakers.delete(breakNow)
          hostConns.delete(conn)
        }
      },
    },
    respond(message: ClientResponse): Promise<RpcReceipt> {
      if (!questionPending || message.rpcId !== pendingQuestionRpcId) {
        return Promise.resolve({ accepted: false, reason: 'not-pending' })
      }
      questionPending = false
      emitMux({
        type: 'question/resolved', sessionId: sid('fx-alpha'),
        questionRpcId: pendingQuestionRpcId,
        outcome: message.result.ok ? 'answered' : 'cancelled',
      })
      return Promise.resolve({ accepted: true })
    },
  }
}

/**
 * Fixture platform subclass: there is no HTTP at all, so instead of a doFetch transport it
 * overrides the protocol-level virtuals (callUnary/openMux/openHost/respond) to dispatch
 * straight into the in-memory ApiProxy — while still minting rpcIds, fabricating the four
 * named full forms, and feeding the same tap as a real carrier. Delete when the fixture moves
 * to the isomorphic pipeline (InProcessApiClient over toFetchHandler(fixtureImpl)).
 */
export class FixtureApiClient extends AbstractApiClient {
  private readonly api: ApiProxy

  constructor() {
    super()
    this.api = createFixtureApi(fixtureOptionsFromLocation())
  }

  protected doFetch(): Promise<Response> {
    throw new Error('FixtureApiClient overrides all protocol paths; doFetch must be unreachable')
  }

  protected override async callUnary<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
  ): Promise<RpcResponse<ResponseValue<K>>> {
    const request = rpcRequest(payload)
    const full: ClientRequest = { type: 'client-request', rpcId: request.rpcId, method, payload }
    this.onEnvelope(full)
    const response = await this.dispatch(method, request as RpcRequest<never>) as RpcResponse<ResponseValue<K>>
    const fullResponse: ServerResponse = { type: 'server-response', rpcId: response.rpcId, result: response.result }
    this.onEnvelope(fullResponse)
    return response
  }

  /** Method-key dispatch into the in-memory contract impl (a real carrier routes by URL path instead). */
  private dispatch(method: keyof RpcMethodMap, request: RpcRequest<never>): Promise<RpcResponse<unknown>> {
    switch (method) {
      case 'session.list': return this.api.sessions.list(request)
      case 'session.create': return this.api.sessions.create(request)
      case 'session.history': return this.api.sessions.history(request)
      case 'session.prompt': return this.api.sessions.prompt(request)
      case 'session.cancel': return this.api.sessions.cancel(request)
      case 'host.describe': return this.api.host.describe(request)
      case 'workspace.list': return this.api.workspace.list(request)
      case 'workspace.create': return this.api.workspace.create(request)
      case 'workspace.rename': return this.api.workspace.rename(request)
      case 'workspace.insertSessionBefore': return this.api.workspace.insertSessionBefore(request)
      case 'command.list': return this.api.commands.list(request)
      // The in-memory execute never blocks, so a never-aborting signal is faithful here.
      case 'command.execute': return this.api.commands.execute(request, new AbortController().signal)
      case 'skill.list': return this.api.skills.list(request)
    }
  }

  protected override openMux(
    payload: { since?: Record<SessionId, number> },
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.tapStream(this.api.events.mux(rpcRequest(payload), signal), onOpen)
  }

  protected override openHost(
    payload: Record<never, never>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.tapStream(this.api.events.host(rpcRequest(payload), signal), onOpen)
  }

  private async *tapStream<F extends MuxFrame | HostFrame>(
    stream: AsyncIterable<RpcRequest<F>>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    // No HTTP here: the in-memory stream is established the moment iteration starts (mirrors
    // readSse firing onOpen after response headers, before any frame).
    onOpen?.()
    for await (const envelope of stream) {
      const full: ServerRequest = { type: 'server-request', rpcId: envelope.rpcId, method: envelope.payload.type, payload: envelope.payload }
      this.onEnvelope(full)
      yield envelope
    }
  }

  /**
   * Deliver a client response to the in-memory contract impl (no HTTP POST),
   * echoing the envelope to the observation tap like every other path.
   * @param message - the client-response envelope answering a server request.
   * @returns the carrier receipt from the fixture impl.
   */
  override async respond(message: ClientResponse): Promise<RpcReceipt> {
    this.onEnvelope(message)
    return this.api.respond(message)
  }
}

/** Browser query mapping; direct unit callers pass FixtureOptions explicitly. */
function fixtureOptionsFromLocation(): FixtureOptions {
  if (typeof location === 'undefined') return {}
  const query = new URLSearchParams(location.search)
  return {
    empty: query.get('fixture') === 'empty',
    rejectPrompt: query.get('fixturePrompt') === 'reject',
    failWorkspaceAttach: query.get('fixtureAttach') === 'fail',
    dropSessionCreateResponse: query.get('fixtureSessionCreate') === 'drop-response',
    createFrameOrder: query.get('fixtureFrames') === 'workspace-first' ? 'workspace-first' : 'session-first',
  }
}
