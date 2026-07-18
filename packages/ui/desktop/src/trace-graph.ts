import { assistantText, reasoningText } from './renderer-content.ts'

/** Minimal durable session event shape consumed by the desktop trace graph. */
export interface TraceEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: Record<string, unknown>
  readonly sourceEventSeqs?: number[]
  readonly surfaceOp?: unknown
}

/** Logical object classes shared by Chat, Trajectory, Waterfall, and Inspector. */
export type TraceTargetKind = 'session' | 'turn' | 'step' | 'request' | 'user' | 'reasoning' | 'assistant' | 'tool' | 'context' | 'summary'

/** One selectable logical trace object with its complete inspector payload. */
export interface TraceTarget {
  readonly id: string
  readonly kind: TraceTargetKind
  readonly title: string
  readonly subtitle: string
  readonly status: 'ok' | 'error' | 'running'
  readonly turn?: number
  readonly step?: number
  readonly startTime: number
  readonly endTime: number
  readonly eventSeqs: readonly number[]
  readonly input: unknown
  readonly output: unknown
  readonly metadata: unknown
}

/** One ordered block in a turn's assistant response. */
export interface ChatActivity {
  readonly kind: 'reasoning' | 'tool' | 'text'
  readonly targetId: string
}

/** One user turn and its single assistant response shell. */
export interface ChatTurn {
  readonly turn: number
  readonly userTargetId?: string
  readonly activities: readonly ChatActivity[]
}

/** One logical row in the structural trajectory. */
export interface TrajectoryRow {
  readonly targetId: string
  readonly groupId: string
}

/** Turn/step grouping metadata for trajectory navigation. */
export interface TrajectoryGroup {
  readonly id: string
  readonly turn: number
  readonly step: number | null
  readonly startTime: number
  readonly endTime: number
  readonly status: 'ok' | 'error' | 'running'
  readonly rowTargetIds: readonly string[]
}

/** One timing span that resolves to the same target used by other views. */
export interface WaterfallSpan {
  readonly targetId: string
  readonly parentTargetId?: string
  readonly depth: number
}

/** Single normalized source consumed by every session analysis view. */
export interface TraceGraph {
  readonly sessionId: string
  readonly startTime: number
  readonly endTime: number
  readonly targets: ReadonlyMap<string, TraceTarget>
  readonly chatTurns: readonly ChatTurn[]
  readonly trajectoryGroups: readonly TrajectoryGroup[]
  readonly trajectoryRows: readonly TrajectoryRow[]
  readonly waterfallSpans: readonly WaterfallSpan[]
}

interface MutableTarget {
  id: string
  kind: TraceTargetKind
  title: string
  subtitle: string
  status: 'ok' | 'error' | 'running'
  turn?: number
  step?: number
  startTime: number
  endTime: number
  eventSeqs: number[]
  input: unknown
  output: unknown
  metadata: unknown
}

interface MutableGroup {
  id: string
  turn: number
  step: number | null
  startTime: number
  endTime: number
  status: 'ok' | 'error' | 'running'
  rowTargetIds: string[]
}

interface MutableChatTurn {
  turn: number
  userTargetId?: string
  activities: ChatActivity[]
}

/**
 * Fold raw session events into one graph shared by every desktop trace view.
 * @param sessionId - Session that owns the events.
 * @param events - Durable events in log order.
 * @returns Logical targets, structural groups, chat turns, and timing spans.
 */
export function buildTraceGraph(sessionId: string, events: readonly TraceEvent[]): TraceGraph {
  const firstTime = events.find(event => event.time !== undefined)?.time ?? 0
  const lastTime = [...events].reverse().find(event => event.time !== undefined)?.time ?? firstTime
  const targets = new Map<string, MutableTarget>()
  const chatTurns = new Map<number, MutableChatTurn>()
  const groups: MutableGroup[] = []
  const groupById = new Map<string, MutableGroup>()
  const rows: TrajectoryRow[] = []
  const spans: WaterfallSpan[] = []
  const toolTargets = new Map<string, MutableTarget>()
  const reasoningTargets = new Map<string, MutableTarget>()
  const requestByStep = new Map<string, MutableTarget>()
  let latestRequestInput: unknown = ''
  let currentTurn = 0
  let currentStep: number | null = null
  let currentGroup: MutableGroup | undefined

  targets.set(`session:${sessionId}`, {
    id: `session:${sessionId}`,
    kind: 'session',
    title: sessionId,
    subtitle: `${events.length} events`,
    status: 'ok',
    startTime: firstTime,
    endTime: lastTime,
    eventSeqs: events.flatMap(event => event.seq === undefined ? [] : [event.seq]),
    input: '',
    output: '',
    metadata: { sessionId, eventCount: events.length },
  })

  const getChatTurn = (turn: number): MutableChatTurn => {
    const existing = chatTurns.get(turn)
    if (existing !== undefined) return existing
    const created: MutableChatTurn = { turn, activities: [] }
    chatTurns.set(turn, created)
    return created
  }
  const addTarget = (target: MutableTarget, group: MutableGroup | null | undefined = currentGroup): MutableTarget => {
    targets.set(target.id, target)
    if (group !== undefined && group !== null) {
      group.rowTargetIds.push(target.id)
      rows.push({ targetId: target.id, groupId: group.id })
    }
    return target
  }
  const ensureGroup = (turn: number, step: number | null, time: number): MutableGroup => {
    const id = step === null ? `turn:${turn}:input` : `step:${turn}:${step}`
    const existing = groupById.get(id)
    if (existing !== undefined) return existing
    const created: MutableGroup = { id, turn, step, startTime: time, endTime: time, status: 'running', rowTargetIds: [] }
    groups.push(created)
    groupById.set(id, created)
    return created
  }
  const seqs = (event: TraceEvent): number[] => event.seq === undefined ? [] : [event.seq]
  const stepKey = (turn: number, step: number): string => `${turn}:${step}`

  for (const event of events) {
    const data = asRecord(event.data)
    const time = event.time ?? lastTime
    if (event.type === 'turn/start') {
      currentTurn = numberValue(data.turn, currentTurn + 1)
      currentStep = null
      currentGroup = ensureGroup(currentTurn, null, time)
      const target = addTarget({
        id: `turn:${currentTurn}`,
        kind: 'turn',
        title: `Turn ${currentTurn}`,
        subtitle: stringValue(asRecord(data.trigger).kind) || 'turn',
        status: 'running',
        turn: currentTurn,
        startTime: time,
        endTime: time,
        eventSeqs: seqs(event),
        input: data.trigger ?? '',
        output: '',
        metadata: event,
      }, null)
      spans.push({ targetId: target.id, depth: 0 })
      getChatTurn(currentTurn)
      continue
    }
    const turn = numberValue(data.turn, currentTurn)
    if (turn > 0) currentTurn = turn
    if (event.type === 'turn/end') {
      const target = targets.get(`turn:${turn}`)
      if (target !== undefined) {
        target.endTime = time
        target.status = stringValue(asRecord(data.reason).kind) === 'completed' ? 'ok' : 'error'
        target.output = data.reason ?? ''
        target.eventSeqs.push(...seqs(event))
      }
      for (const group of groups.filter(group => group.turn === turn && group.status === 'running')) {
        group.endTime = Math.max(group.endTime, time)
        group.status = target?.status ?? 'ok'
      }
      continue
    }
    if (event.type === 'step/start') {
      currentStep = numberValue(data.step, 0)
      currentGroup = ensureGroup(turn, currentStep, time)
      const target = addTarget({
        id: `step:${turn}:${currentStep}`,
        kind: 'step',
        title: `Step ${currentStep}`,
        subtitle: `Turn ${turn}`,
        status: 'running',
        turn,
        step: currentStep,
        startTime: time,
        endTime: time,
        eventSeqs: seqs(event),
        input: '',
        output: '',
        metadata: event,
      }, null)
      spans.push({ targetId: target.id, parentTargetId: `turn:${turn}`, depth: 1 })
      continue
    }
    const step = numberValue(data.step, currentStep ?? 0)
    if (event.type === 'step/end') {
      const target = targets.get(`step:${turn}:${step}`)
      if (target !== undefined) {
        target.endTime = time
        target.status = 'ok'
        target.eventSeqs.push(...seqs(event))
      }
      const group = groupById.get(`step:${turn}:${step}`)
      if (group !== undefined) {
        group.endTime = time
        group.status = group.status === 'error' ? 'error' : 'ok'
      }
      continue
    }
    if (currentGroup === undefined || currentGroup.turn !== turn || currentGroup.step !== (step || null)) {
      currentGroup = ensureGroup(turn, step > 0 ? step : null, time)
    }
    currentGroup.endTime = Math.max(currentGroup.endTime, time)
    const chatTurn = getChatTurn(turn)

    if (event.type === 'user/message') {
      const id = `user:${event.seq ?? currentGroup.rowTargetIds.length}`
      addTarget({ id, kind: 'user', title: 'User message', subtitle: `Turn ${turn}`, status: 'ok', turn, startTime: time, endTime: time, eventSeqs: seqs(event), input: '', output: data.content ?? '', metadata: event })
      chatTurn.userTargetId = id
    } else if (event.type === 'request/header' || event.type === 'request/header-delta') {
      const id = `request:${event.seq ?? currentGroup.rowTargetIds.length}`
      const header = asRecord(data.header)
      const input = event.type === 'request/header' ? header : data
      const target = addTarget({ id, kind: 'request', title: event.type, subtitle: `Turn ${turn} · Step ${step}`, status: 'ok', turn, step, startTime: time, endTime: time, eventSeqs: seqs(event), input, output: '', metadata: event }, null)
      requestByStep.set(stepKey(turn, step), target)
      latestRequestInput = input
    } else if (event.type === 'assistant/chunk') {
      const chunk = asRecord(data.chunk)
      if (chunk.type === 'reasoning-delta') {
        const key = stepKey(turn, step)
        let target = reasoningTargets.get(key)
        if (target === undefined) {
          const id = `reasoning:${turn}:${step}`
          target = addTarget({ id, kind: 'reasoning', title: 'Thinking', subtitle: `Turn ${turn} · Step ${step}`, status: 'running', turn, step, startTime: time, endTime: time, eventSeqs: [], input: requestByStep.get(key)?.input ?? latestRequestInput, output: '', metadata: { chunks: [] as TraceEvent[] } })
          reasoningTargets.set(key, target)
          chatTurn.activities.push({ kind: 'reasoning', targetId: id })
        }
        target.endTime = time
        target.eventSeqs.push(...seqs(event))
        target.output = `${stringValue(target.output)}${stringValue(chunk.text)}`
        const metadata = asRecord(target.metadata)
        const chunks = metadata.chunks as TraceEvent[]
        chunks.push(event)
        target.metadata = { chunks }
      }
    } else if (event.type === 'tool/call') {
      const callId = stringValue(data.callId)
      const id = `tool:${callId}`
      const target = addTarget({ id, kind: 'tool', title: stringValue(data.name) || 'Tool', subtitle: callId, status: 'running', turn, step, startTime: time, endTime: time, eventSeqs: seqs(event), input: parseMaybeJson(data.arguments ?? data.rawInput ?? data), output: '', metadata: { call: event } })
      toolTargets.set(callId, target)
      chatTurn.activities.push({ kind: 'tool', targetId: id })
      spans.push({ targetId: id, parentTargetId: `step:${turn}:${step}`, depth: 2 })
    } else if (event.type === 'tool/result') {
      const callId = stringValue(data.callId)
      const target = toolTargets.get(callId)
      if (target !== undefined) {
        target.endTime = time
        target.status = data.isError === true ? 'error' : 'ok'
        target.eventSeqs.push(...seqs(event))
        target.output = { content: data.content, isError: data.isError, error: data.error, meta: data.meta }
        target.metadata = { ...asRecord(target.metadata), result: event }
        if (target.status === 'error') currentGroup.status = 'error'
      }
    } else if (event.type === 'assistant/message') {
      const reasoning = reasoningText(data.content)
      const key = stepKey(turn, step)
      if (reasoning.length > 0 && !reasoningTargets.has(key)) {
        const id = `reasoning:${turn}:${step}`
        const target = addTarget({ id, kind: 'reasoning', title: 'Thinking', subtitle: `Turn ${turn} · Step ${step}`, status: 'ok', turn, step, startTime: time, endTime: time, eventSeqs: seqs(event), input: requestByStep.get(key)?.input ?? latestRequestInput, output: reasoning, metadata: event })
        reasoningTargets.set(key, target)
        chatTurn.activities.push({ kind: 'reasoning', targetId: id })
      } else {
        const target = reasoningTargets.get(key)
        if (target !== undefined) target.status = 'ok'
      }
      const text = assistantText(data.content)
      const id = `assistant:${event.seq ?? currentGroup.rowTargetIds.length}`
      addTarget({ id, kind: 'assistant', title: 'Model response', subtitle: `Turn ${turn} · Step ${step}`, status: 'ok', turn, step, startTime: requestByStep.get(key)?.startTime ?? time, endTime: time, eventSeqs: seqs(event), input: requestByStep.get(key)?.input ?? latestRequestInput, output: data.content ?? text, metadata: { event, usage: data.usage } })
      spans.push({ targetId: id, parentTargetId: `step:${turn}:${step}`, depth: 2 })
      if (text.length > 0) {
        chatTurn.activities.push({ kind: 'text', targetId: id })
      }
    } else if (event.type === 'context/message' || event.type === 'steering/message') {
      const id = `context:${event.seq ?? currentGroup.rowTargetIds.length}`
      addTarget({ id, kind: 'context', title: event.type, subtitle: `Turn ${turn} · Step ${step}`, status: 'ok', turn, step, startTime: time, endTime: time, eventSeqs: seqs(event), input: '', output: data.content ?? '', metadata: event })
    }
  }

  for (const target of targets.values()) {
    if (target.status === 'running' && target.kind !== 'session') target.status = 'ok'
  }
  const assistantTargets = [...targets.values()].filter(target => target.kind === 'assistant')
  const pairedToolTargets = [...targets.values()].filter(target => target.kind === 'tool')
  const errorTargets = [...targets.values()].filter(target => target.status === 'error')
  const slowestStep = [...targets.values()].filter(target => target.kind === 'step').sort((a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime))[0]
  const summaries: MutableTarget[] = [
    summaryTarget('summary:total', 'Total', lastTime - firstTime, firstTime, lastTime, { eventCount: events.length }),
    summaryTarget('summary:llm', 'LLM time', assistantTargets.reduce((sum, target) => sum + target.endTime - target.startTime, 0), firstTime, lastTime, { targets: assistantTargets.map(target => target.id) }),
    summaryTarget('summary:tools', 'Tool time', pairedToolTargets.reduce((sum, target) => sum + target.endTime - target.startTime, 0), firstTime, lastTime, { targets: pairedToolTargets.map(target => target.id) }),
    summaryTarget('summary:errors', 'Errors', errorTargets.length, firstTime, lastTime, { targets: errorTargets.map(target => target.id) }),
    summaryTarget('summary:slowest', 'Slowest step', slowestStep === undefined ? 0 : slowestStep.endTime - slowestStep.startTime, firstTime, lastTime, { target: slowestStep?.id }),
  ]
  for (const target of summaries) targets.set(target.id, target)
  return {
    sessionId,
    startTime: firstTime,
    endTime: lastTime,
    targets: new Map([...targets].map(([id, target]) => [id, Object.freeze({ ...target, eventSeqs: [...target.eventSeqs] })])),
    chatTurns: [...chatTurns.values()].filter(turn => turn.userTargetId !== undefined || turn.activities.length > 0),
    trajectoryGroups: groups.map(group => ({ ...group, rowTargetIds: [...group.rowTargetIds] })),
    trajectoryRows: rows,
    waterfallSpans: spans,
  }
}

function summaryTarget(id: string, title: string, value: number, startTime: number, endTime: number, metadata: unknown): MutableTarget {
  return { id, kind: 'summary', title, subtitle: String(value), status: 'ok', startTime, endTime, eventSeqs: [], input: '', output: value, metadata }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
