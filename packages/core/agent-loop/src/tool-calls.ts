/**
 * The agent loop's per-step tool-call scheduler. `runStep` (loop.ts) hands it
 * the assistant message's `tool-call` blocks; this module parses each call's
 * arguments once, classifies it via `ctx.tools.executionMode`, partitions the
 * calls into ordered groups (one exclusive call, or a run of consecutive
 * parallel-safe calls), and runs every group through the same rolling pool
 * bounded by the agent-loop's `maxParallelToolCalls` config — an exclusive
 * group is a pool of one.
 *
 * The session log stays the source of truth and is reconstructable regardless
 * of dispatch timing: each STARTED call appends its own `tool/call` before its
 * body runs, `tool/result` events are appended in MODEL order (slot-buffered
 * behind a commit cursor), and buffered `additionalContext` is injected in model
 * call order after every result. A `tool/call`'s log position may interleave
 * with a sibling's `tool/result` as the pool replenishes; that is safe because
 * `tool/call` is log-only and derived history pairs the assistant message's
 * `tool-call` blocks with the ordered `tool/result`s by `callId`.
 *
 * @module dsh-agent-loop/tool-calls
 */

import type { Context } from 'cordis'
import { assertNever, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { HookContext } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { TOOL_REGISTRY_SCHEDULER, type ToolExecution, type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ReactLoopAgent } from './agent.ts'

/** One tool call after argument parsing, ready to schedule. */
interface PlannedCall {
  /** The model-transcript call (authoritative `id`/`name`/raw `arguments`). */
  block: ToolCallBlock
  /** The distinct per-call execution input handed to the tool pipeline. */
  exec: ToolExecutionInput
}

/** A settled call's slot, filled in model order before ordered finalization. */
interface Slot {
  /** The registry-minted execution object, carrying this call's token. */
  exec: ToolExecution
  /** The raw dispatch/pre result. */
  result: ToolExecutionResult
  /** Whether the result still needs ordered `tools/post-execute` finalization. */
  needsPost: boolean
}

/**
 * Execute one assistant step's tool calls, honoring per-call concurrency safety.
 *
 * Appends `tool/call` (per started call) and `tool/result` (in model order) to
 * the session, and returns the ordered `additionalContext` buffer for the loop
 * to inject after the batch. On abort it drains only already-started calls to
 * results, drops buffered context, and throws the abort error so `runTurn` owns
 * the turn-end reason.
 *
 * @param ctx - the loop context (reaches `ctx.tools`).
 * @param agent - the agent being driven (owns the session, options, and is
 *   passed to each `ToolExecution`).
 * @param turn - the current turn number (for the session events).
 * @param step - the current step number (for the session events).
 * @param toolCalls - the assistant message's `tool-call` blocks, in model order.
 * @param signal - the step's abort signal (shared by every call).
 * @param maxParallel - the already-validated cap snapshot for parallel groups.
 * @returns the per-step `additionalContext` buffer in model call order.
 */
export async function executeToolCalls(
  ctx: Context,
  agent: ReactLoopAgent,
  turn: number,
  step: number,
  toolCalls: ToolCallBlock[],
  signal: AbortSignal,
  maxParallel: number,
): Promise<HookContext[]> {
  const { session } = agent

  // Plan: parse each call's raw JSON arguments exactly once, and build one
  // distinct ToolExecution per call so a `tools/execute` wrapper that mutates
  // `exec` in place (e.g. replacing exec.signal with a per-call deadline) cannot
  // race through a shared payload.
  const planned: PlannedCall[] = toolCalls.map(block => ({
    block,
    exec: {
      callId: block.id,
      name: block.name,
      arguments: parseArguments(block.arguments),
      agent,
      signal,
    },
  }))

  // Partition into ordered groups: an exclusive call is its own group (a
  // barrier), a run of consecutive parallel-safe calls is one group. Grouping
  // uses executionMode so an exclusive tool between two reads splits them into
  // separate ordered groups (no read/write race inside one assistant step).
  const groups = groupByMode(ctx, planned)

  // Every group runs through the same rolling pool: an exclusive call is a
  // singleton group (pool of one, a barrier), a parallel-safe run is one group
  // bounded by the cap. `groupByMode` already classified each call, so the loop
  // does not re-query `executionMode` here.
  const pendingContext: HookContext[] = []
  for (const group of groups) {
    await runGroup(ctx, session, turn, step, group, signal, maxParallel, pendingContext)
  }
  return pendingContext
}

/** Parse a model-produced raw arguments string, falling back to the raw string on invalid JSON (empty ⇒ `{}`). */
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}

/**
 * Group planned calls into ordered runs: each exclusive call is a singleton
 * group; consecutive parallel-safe calls coalesce into one group. `executionMode`
 * is the sole classification point — the caller runs every group through the
 * rolling pool without re-querying it. The read is pure and cheap.
 */
function groupByMode(ctx: Context, planned: PlannedCall[]): PlannedCall[][] {
  const groups: PlannedCall[][] = []
  let run: PlannedCall[] = []
  const flush = (): void => {
    if (run.length > 0) {
      groups.push(run)
      run = []
    }
  }
  for (const call of planned) {
    if (ctx.tools.executionMode(call.exec).kind === 'parallel') {
      run.push(call)
    } else {
      flush()
      groups.push([call])
    }
  }
  flush()
  return groups
}

/**
 * The rolling-pool path for one ordered group. A singleton exclusive group runs
 * as a pool of one (a barrier); a parallel-safe run starts calls in model order
 * up to `maxParallel`, and whenever one settles starts the next unstarted call
 * until the group is exhausted. Settled dispatches land in model-order slots; a
 * commit cursor appends `tool/result` (and collects `additionalContext`) only
 * while the next slot is ready, so the log stays model-ordered regardless of
 * completion order.
 *
 * Abort: an already-aborted signal starts nothing and throws before any
 * `tool/call`. An abort mid-group stops replenishment, awaits only the started
 * calls, commits their results in order, drops buffered context, and throws.
 */
async function runGroup(
  ctx: Context,
  session: Session,
  turn: number,
  step: number,
  group: PlannedCall[],
  signal: AbortSignal,
  maxParallel: number,
  pendingContext: HookContext[],
): Promise<void> {
  /* v8 ignore next -- signal.reason always set: cancel()/disposal provide a default */
  if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
  const slots: (Slot | undefined)[] = group.map(() => undefined)
  // callSeqs[i] is the `tool/call` event seq for started slot i (its provenance
  // for the matching tool/result). A slot is only committed after it is started,
  // so its callSeq is always set by then.
  const callSeqs: number[] = group.map(() => -1)
  let nextToStart = 0
  let committed = 0
  let started = 0
  let aborted: boolean = signal.aborted

  // Advance the commit cursor over contiguous settled slots: run post-execute in
  // model order, append each tool/result, and collect its additionalContext.
  const commitReady = async (): Promise<void> => {
    while (committed < group.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = group[committed]
      const result = slot.needsPost
        ? await ctx.tools[TOOL_REGISTRY_SCHEDULER].finalize(slot.exec, slot.result)
        : ctx.tools[TOOL_REGISTRY_SCHEDULER].finish(slot.exec, slot.result)
      // committed < group.length, so call and its callSeq (set at start) exist.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded index
      appendToolResult(session, turn, step, call!.block, result, callSeqs[committed]!)
      if (result.additionalContext) pendingContext.push(result.additionalContext)
      committed++
    }
  }

  const inFlight = new Map<number, Promise<number>>()

  const startCall = async (index: number): Promise<void> => {
    // index is always < group.length (bounded by every caller).
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded index
    const call = group[index]!
    callSeqs[index] = appendToolCall(session, turn, step, call.block)
    started++
    const prepared = await ctx.tools[TOOL_REGISTRY_SCHEDULER].prepare(call.exec)
    switch (prepared.kind) {
      case 'dispatch': {
        const promise = ctx.tools[TOOL_REGISTRY_SCHEDULER].dispatch(prepared.exec).then((outcome) => {
          slots[index] = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
          return index
        })
        inFlight.set(index, promise)
        break
      }
      case 'post-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: true }
        break
      case 'final-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: false }
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(prepared, 'tool-call scheduler prepare result')
    }
  }

  const fillPool = async (): Promise<void> => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallel) {
      await startCall(nextToStart)
      nextToStart++
      await commitReady()
      // The signal CAN flip while an ordered pre-execute listener is running.
      if (signal.aborted) aborted = true
    }
  }

  // Prime the pool up to the cap. Ordered pre-execute listeners may be async;
  // dispatch/body is the only stage that overlaps across in-flight calls.
  await fillPool()
  while (inFlight.size > 0) {
    const settledIndex = await Promise.race(inFlight.values())
    inFlight.delete(settledIndex)
    // Commit every contiguous settled slot now available.
    await commitReady()
    // The signal CAN flip during the await above (abort() inside a tool); the
    // analyzer can't see through the await boundary. An abort stops the pool
    // from starting any further calls, but already-started calls still drain.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (signal.aborted) aborted = true
    await fillPool()
  }

  if (aborted) {
    // Every started call has settled and committed in order; buffered context
    // from this aborted step is dropped (not injected). Raise the abort so the
    // existing runTurn catch owns turn/end reason selection. Unstarted calls
    // beyond the cap never appended a tool/call.
    /* v8 ignore next -- signal.reason always set: cancel()/disposal provide a default */
    throw new Error(String(signal.reason ?? 'aborted'))
  }
  // A defensive check the started count matches what we committed — a parallel
  // group with no abort commits every started slot, and started === group.length.
  /* v8 ignore next -- unreachable: a non-aborted group starts and commits all calls */
  if (committed !== started) throw new Error('tool-call scheduler: uncommitted settled calls')
}

/** Append the `tool/call` audit event for one started call; returns its seq (the tool/result's provenance). */
function appendToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): number {
  const event = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
  return event.seq
}

/** Append one call's `tool/result`, keyed by the authoritative model-transcript call id and provenanced to its `tool/call`. */
function appendToolResult(
  session: Session,
  turn: number,
  step: number,
  block: ToolCallBlock,
  result: ToolExecutionResult,
  callSeq: number,
): void {
  session.append('tool/result', {
    turn, step,
    // The correlation id MUST be the loop's authoritative call.id (the
    // model-transcript id deriveMessages turns into toolCallId), NOT
    // result.callId — a post-execute listener returning a mismatched id would
    // otherwise orphan the call↔result pairing in the next model request.
    callId: block.id,
    content: result.content,
    isError: result.isError,
    ...result.error ? { error: result.error } : {},
    // The tool's private presentation payload (e.g. a result-time diff),
    // persisted so a UI bridge reproduces the card on replay.
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
