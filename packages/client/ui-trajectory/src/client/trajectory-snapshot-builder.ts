import type { Context } from 'cordis'
import type {
  AssistantMessageNode, ConversationNode, ConversationPromptSnapshot,
  ConversationViewBuilder, ConversationViewDefinition, RequestView,
  ToolCallBlock,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryConversationViewNode, TrajectoryRequestHeaderState,
  TrajectorySnapshot,
} from './trajectory-contract.ts'

const EMPTY_LIST: readonly never[] = []
const EMPTY_CONTEXTS = [{ id: 0, nodes: EMPTY_LIST }]

/** Stable empty target used until a Session has assembled Trajectory records. */
export const EMPTY_TRAJECTORY_SNAPSHOT: TrajectorySnapshot = {
  eventNodes: EMPTY_LIST,
  contexts: EMPTY_CONTEXTS,
  requests: EMPTY_LIST,
  callSchemas: new Map(),
  interruptedNodes: EMPTY_LIST,
  partial: null,
  runningCalls: EMPTY_LIST,
}

function coordinates(
  header: TrajectoryRequestHeaderState,
): { turn?: number; step?: number } {
  const location = header.location
  if (location.kind === 'step') return { turn: location.turn.turn, step: location.step.step }
  if (location.kind === 'turn') return { turn: location.turn.turn }
  return {}
}

function headerFor(
  request: Extract<RequestView, { purpose: 'assistant' }>,
  headers: readonly TrajectoryRequestHeaderState[],
): TrajectoryRequestHeaderState | undefined {
  const exact = headers.findLast((header) => {
    const location = coordinates(header)
    return location.turn === request.turn && location.step === request.step
  })
  return exact ?? headers.findLast(header => header.seq < request.startSeq)
}

function applyHeader(
  request: Extract<RequestView, { purpose: 'assistant' }>,
  header: TrajectoryRequestHeaderState | undefined,
  includeChange: boolean,
): Extract<RequestView, { purpose: 'assistant' }> {
  return header === undefined
    ? request
    : {
      ...request,
      prompt: header.prompt,
      requestConfig: header.prompt.config,
      ...(includeChange && header.change !== undefined ? { promptChange: header.change } : {}),
    }
}

function withRequestConfig(
  node: AssistantMessageNode,
  prompt: ConversationPromptSnapshot | undefined,
): AssistantMessageNode {
  return prompt === undefined ? node : { ...node, requestConfig: prompt.config }
}

function captureSchemas(
  block: ToolCallBlock,
  tools: readonly ConversationPromptSnapshot['tools'][number][],
  output: Map<string, ConversationPromptSnapshot['tools'][number]>,
): void {
  const name = 'kind' in block ? block.call?.name : block.name
  const schema = name === undefined
    ? undefined
    : tools.find(candidate => candidate.name === name)
  if (schema !== undefined) output.set(block.callId, schema)
  for (const child of block.subCalls) captureSchemas(child, tools, output)
}

function interruptCompactions(
  requests: RequestView[],
  boundaries: readonly { seq: number; time: number }[],
): void {
  for (const boundary of boundaries) {
    const index = requests.findLastIndex(request =>
      request.purpose === 'compaction'
      && request.startSeq < boundary.seq
      && request.status === 'running')
    const request = requests[index]
    if (request?.purpose !== 'compaction') continue
    requests[index] = {
      ...request,
      completedAt: boundary.time,
      status: 'error',
      error: 'Compaction was interrupted before completion.',
    }
  }
}

function applyTurnErrors(
  requests: RequestView[],
  endings: readonly { turn: number; time: number; error?: string }[],
): void {
  for (const ending of endings) {
    if (ending.error === undefined) continue
    const index = requests.findLastIndex(request =>
      request.purpose === 'assistant' && request.turn === ending.turn)
    const request = requests[index]
    if (request?.purpose !== 'assistant') continue
    requests[index] = {
      ...request,
      completedAt: request.completedAt ?? ending.time,
      status: 'error',
      error: ending.error,
    }
  }
}

/** Simple keyed adapter retaining the old Trajectory snapshot and stage layout. */
export class TrajectorySnapshotBuilder implements ConversationViewBuilder<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> {
  private readonly nodes = new Map<string, TrajectoryConversationViewNode>()
  readonly empty = EMPTY_TRAJECTORY_SNAPSHOT

  replace(input: {
    readonly nodes: readonly TrajectoryConversationViewNode[]
  }): TrajectorySnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  apply(input: {
    readonly upserts: readonly TrajectoryConversationViewNode[]
  }): TrajectorySnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  private snapshot(): TrajectorySnapshot {
    const contributions = [...this.nodes.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    const headers = contributions.flatMap(node => node.data.kind === 'request-header'
      ? [node.data.header]
      : [])
    const finalized: ConversationNode[] = []
    const requests: RequestView[] = []
    const boundaries: { seq: number; time: number }[] = []
    const turnEndings: { turn: number; time: number; error?: string }[] = []
    const callSchemas = new Map<string, ConversationPromptSnapshot['tools'][number]>()
    const consumedPromptChanges = new Set<number>()
    let partial: TrajectorySnapshot['partial'] = null
    const runningCalls: TrajectorySnapshot['runningCalls'][number][] = []

    for (const contribution of contributions) {
      const data = contribution.data
      if (data.kind === 'node') {
        finalized.push(data.node)
        continue
      }
      if (data.kind === 'assistant') {
        const header = data.request === undefined ? undefined : headerFor(data.request, headers)
        if (data.node !== undefined) finalized.push(withRequestConfig(data.node, header?.prompt))
        if (data.partial !== null) partial = data.partial
        if (data.request !== undefined) {
          const includeChange = header?.change !== undefined
            && !consumedPromptChanges.has(header.seq)
          requests.push(applyHeader(data.request, header, includeChange))
          if (includeChange) consumedPromptChanges.add(header.seq)
        }
        continue
      }
      if (data.kind === 'tool') {
        if ('kind' in data.root) finalized.push(data.root)
        else runningCalls.push(data.root)
        const header = headers.findLast(candidate => candidate.seq < contribution.anchorSeq)
        if (header !== undefined) captureSchemas(data.root, header.prompt.tools, callSchemas)
        continue
      }
      if (data.kind === 'compaction') {
        requests.push(data.request)
        continue
      }
      if (data.kind === 'session-end') {
        boundaries.push({ seq: data.seq, time: data.time })
        continue
      }
      if (data.kind === 'turn-end') {
        turnEndings.push({
          turn: data.turn,
          time: data.time,
          ...(data.error === undefined ? {} : { error: data.error }),
        })
      }
    }

    requests.sort((left, right) => left.startSeq - right.startSeq)
    interruptCompactions(requests, boundaries)
    applyTurnErrors(requests, turnEndings)
    finalized.sort((left, right) => left.seq - right.seq)
    const eventNodes = finalized
    return {
      eventNodes,
      contexts: [{ id: 0, nodes: eventNodes }],
      requests,
      callSchemas,
      interruptedNodes: EMPTY_LIST,
      partial,
      runningCalls,
    }
  }
}

/** Trajectory target factory preserving the existing stage-oriented view model. */
export const trajectoryViewDefinition: ConversationViewDefinition<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> = {
  target: 'trajectory',
  create: () => new TrajectorySnapshotBuilder(),
}

/**
 * Register the stage-oriented Trajectory target builder.
 *
 * @param ctx - Plugin context receiving the view Definition.
 */
export function registerTrajectoryConversationView(ctx: Context): void {
  ctx.conversationViews.register(trajectoryViewDefinition)
}
