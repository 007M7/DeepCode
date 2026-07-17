/**
 * The agent loop's per-step tool-call scheduler. `runStep` (loop.ts) hands it
 * the assistant message's `tool-call` blocks; this module parses each call's
 * arguments once, classifies pending calls via `ctx.tools.executionMode`, and
 * runs ordered groups through a rolling pool bounded by the agent-loop's
 * `maxParallelToolCalls` config. Exclusive calls are singleton barriers. A
 * parallel group reclassifies each later call before it starts, so registry
 * changes during an earlier barrier or ordered result commit take effect before
 * the pool replenishes.
 *
 * The session log stays the source of truth and is reconstructable regardless
 * of dispatch timing: each STARTED call appends its own `tool/call` before its
 * body runs, `tool/result` events are appended in MODEL order (slot-buffered
 * behind a commit cursor), and buffered `additionalContexts` are injected in model
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
import { TOOL_REGISTRY_SCHEDULER, type ToolExecutionInput, type ToolExecutionMode, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
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
  exec: ToolRunContext
  /** The raw dispatch/pre result. */
  result: ToolExecutionResult
  /** Whether the result still needs ordered `tools/post-execute` finalization. */
  needsPost: boolean
}

/**
 * Execute one assistant step's tool calls, honoring per-call concurrency safety.
 *
 * Appends `tool/call` (per started call) and `tool/result` (in model order) to
 * the session, and returns the ordered `additionalContexts` buffer for the loop
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
 * @returns the per-step `additionalContexts` buffer in model call order.
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

  const pendingContext: HookContext[] = []
  let next = 0
  while (next < planned.length) {
    // Classify the next group only after the previous one has fully committed.
    // A registry mutation in an exclusive call or result observer therefore
    // changes how every not-yet-started call is scheduled.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded by the loop condition
    const first = planned[next]!
    const mode = ctx.tools.executionMode(first.exec).kind
    const group = mode === 'parallel' ? planned.slice(next) : [first]
    next += await runGroup(ctx, session, turn, step, group, mode, signal, maxParallel, pendingContext)
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
 * The rolling-pool path for one ordered group. A singleton exclusive group runs
 * as a pool of one (a barrier). A parallel-safe run starts calls in model order
 * up to `maxParallel`; before each later call starts, the scheduler reclassifies
 * it against the live registry. An exclusive result stops replenishment, drains
 * the current run, and remains for the caller's next singleton group. Settled
 * dispatches land in model-order slots; a commit cursor appends `tool/result`
 * (and collects `additionalContexts`) only while the next slot is ready, so the
 * log stays model-ordered regardless of completion order.
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
  mode: ToolExecutionMode['kind'],
  signal: AbortSignal,
  maxParallel: number,
  pendingContext: HookContext[],
): Promise<number> {
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
  // model order, append each tool/result, and collect its additionalContexts.
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
      pendingContext.push(...result.additionalContexts ?? [])
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
      // The caller classified the first item immediately before entering this
      // group. Re-read every later item after ordered commits so a live registry
      // change can turn it into the next barrier.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded by the loop condition
      const nextCall = group[nextToStart]!
      if (nextToStart > 0 && mode === 'parallel'
        && ctx.tools.executionMode(nextCall.exec).kind !== 'parallel') break
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
  // A defensive check that every started call committed before this group
  // returns; a reclassified barrier may leave the rest of `group` unstarted.
  /* v8 ignore next -- unreachable: a non-aborted group commits every started call */
  if (committed !== started) throw new Error('tool-call scheduler: uncommitted settled calls')
  return started
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
    // Correlation stays with the loop's authoritative model-transcript call id;
    // registry results deliberately do not duplicate it.
    callId: block.id,
    content: result.content,
    isError: result.isError,
    ...result.error ? { error: result.error } : {},
    // The tool's private presentation payload (e.g. a result-time diff),
    // persisted so a UI bridge reproduces the card on replay.
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
