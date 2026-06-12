/**
 * The agent loop driver: one `runLoop()` invocation drives one agent for its
 * whole lifetime. Error-contained at the turn level — a throwing plugin ends
 * the turn, never kills the loop. See the JSDoc on `runLoop()` for the full
 * lifecycle pseudo-code.
 *
 * @module dsh-agent-loop/loop
 */

import type { Context } from 'cordis'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { Session, TurnEndReason, TurnTrigger } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { LoopAgent } from './agent.ts'

/** An Error with an optional machine-readable code (e.g., from LlmError or a throwing plugin). */
type CodedError = Error & { code?: string }

/** Normalize an arbitrary thrown value into a (possibly coded) Error. */
function toError(error: unknown): CodedError {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Map a model-call {@link FinishReason} to the step error it should raise, or
 * `undefined` when the step completed normally.
 *
 * Adapters report provider/transport failures one of two sanctioned ways (see
 * the StreamChunk contract in dsh-llm): throw from `stream()` (handled by the
 * caller's try/catch), OR end the stream with a finish-error/aborted chunk
 * (the only option for adapters that can't throw mid-stream, e.g.
 * library-backed ones). This translates the latter into a thrown step error
 * so the turn ends error/aborted with a logged `error` event, never as a
 * normal `completed` assistant message.
 *
 * `FinishReason` is merge-extensible (plugins/adapters can add `kind`s), so
 * the switch handles the known terminal-failure kinds and treats every other
 * kind — `stop`, `tool-calls`, `max-tokens`, future additions — as success.
 */
function finishError(finish: FinishReason): CodedError | undefined {
  switch (finish.kind) {
    case 'error': {
      const error: CodedError = new Error(finish.message)
      if (finish.code !== undefined) error.code = finish.code
      return error
    }
    case 'aborted': {
      const error: CodedError = new Error('model stream aborted')
      error.code = 'ABORTED'
      return error
    }
    // stop / tool-calls / max-tokens / plugin-added kinds → not a failure.
    default:
      return undefined
  }
}

/**
 * Build the `{ message, code? }` part of an error payload, omitting the
 * `code` key entirely when absent (exactOptionalPropertyTypes-correct).
 */
function errorData(err: CodedError): { message: string; code?: string } {
  return { message: err.message, ...typeof err.code === 'string' ? { code: err.code } : {} }
}

/**
 * Ambient handles the loop driver receives from the agent. Decouples the
 * pure function `runLoop` from the mutable LoopAgent fields, making the
 * loop testable without a real agent.
 */
export interface LoopHandle {
  setStatus(status: 'idle' | 'running'): void
  setAbort(controller: AbortController | undefined): void
  /** Resolves when the agent is disposed — unblocks the idle wait. */
  disposed: Promise<void>
  isDisposed(): boolean
}

/**
 * The agent loop. One invocation drives one agent for its whole lifetime:
 *
 * ```
 * forever:
 *   wait for queued messages (idle)
 *   TURN (error-contained — a throwing plugin ends the turn, never the loop):
 *     drain queued → session('user/message'…) → 'turn/start' → emit agent/turn-start
 *     STEP loop:
 *       drain steering → session('steering/message')  ⟵ catches late steering
 *       emit agent/step-start
 *       assembly = ctx.systemPrompt.assemble()        ⟵ waterfall system-prompt/assemble
 *       req = {model, system, tools, messages: session.deriveMessages(), signal}
 *       req = waterfall agent/request                 ⟵ hooks/compaction/model-switch
 *       stream ctx.llm.stream(req)                    ⟵ waterfall llm/stream (raw chunks)
 *         session('assistant/chunk'); emit agent/stream-chunk
 *       msg = waterfall agent/step-result             ⟵ BEFORE the log append, so the
 *       session('assistant/message','usage')             session records what actually ran
 *       each tool-call in msg (sequential, abort-checked):
 *         session('tool/call'); ctx.tools.execute()   ⟵ waterfall tools/execute
 *         session('tool/result')
 *       drain steering → session('steering/message'); emit agent/steering
 *       emit agent/step-end
 *       cont = waterfall agent/turn-continuation(default = hadToolCalls || steered)
 *       if !cont && steering arrived from step-end/continuation listeners: cont = true
 *       if !cont: break
 *     session('turn/end'); emit agent/turn-end
 *     await ctx.parallel('session/flush', session)    ⟵ durability checkpoint
 *     re-enqueue leftover steering as queued          ⟵ steering is never stranded
 *   idle (emit agent/status) unless more queued
 * ```
 */
export async function runLoop(ctx: Context, agent: LoopAgent, handle: LoopHandle): Promise<void> {
  const { session } = agent
  let turn = lastTurnNumber(session) // seeded/forked sessions continue numbering

  while (!handle.isDisposed()) {
    await agent.inbox.waitForQueued(handle.disposed)
    if (handle.isDisposed()) break

    handle.setStatus('running')
    turn += 1
    try {
      await runTurn(ctx, agent, handle, turn)
    } catch (error: unknown) {
      // Backstop: a throwing emit listener (turn boundaries) or a broken
      // finalizer must not kill the driver. Record what we can and move on.
      try {
        const err = toError(error)
        session.append('error', { turn, step: 0, ...errorData(err) })
        ctx.emit('agent/error', agent, turn, 0, err)
      } catch { /* the error path itself is broken; nothing left to do */ }
    }

    // Steering that arrived too late to join this turn (turn-end listeners,
    // flush) becomes a queued message — it must never be stranded.
    for (const message of agent.inbox.drainSteering()) {
      agent.inbox.enqueue(message)
    }

    if (!agent.inbox.hasQueued) handle.setStatus('idle')
  }
}

async function runTurn(ctx: Context, agent: LoopAgent, handle: LoopHandle, turn: number): Promise<void> {
  const { session } = agent

  // Drain queued messages into the session — they trigger this turn.
  const queued = agent.inbox.drainQueued()
  const first = queued[0]
  /* v8 ignore next 3 -- invariant guard: runLoop only calls runTurn when hasQueued */
  if (!first) throw new Error('runTurn invariant violated: no queued message at turn start')
  const trigger: TurnTrigger = { kind: 'message', source: first.source }
  for (const message of queued) {
    session.append('user/message', { content: message.content, source: message.source })
  }

  session.append('turn/start', { turn, trigger })
  ctx.emit('agent/turn-start', agent, turn)

  let reason: TurnEndReason = { kind: 'completed' }
  let step = 0

  while (true) {
    step += 1

    // Steering from the previous round's step-end/continuation listeners
    // (or turn-start listeners on the first step) joins before the request.
    drainSteering(ctx, agent, turn)

    ctx.emit('agent/step-start', agent, turn, step)
    session.append('step/start', { turn, step })

    const abort = new AbortController()
    handle.setAbort(abort)

    let stepOutcome: { hadToolCalls: boolean } | { error: Error }
    try {
      stepOutcome = await runStep(ctx, agent, turn, step, abort.signal)
    } catch (error: unknown) {
      stepOutcome = { error: error instanceof Error ? error : new Error(String(error)) }
    } finally {
      handle.setAbort(undefined)
    }

    if ('error' in stepOutcome) {
      // Steering that arrived during the failed step stays in the inbox —
      // runLoop re-enqueues it as a queued message, so an abort-then-steer
      // starts a fresh turn instead of being silently consumed.
      session.append('step/end', { turn, step })
      ctx.emit('agent/step-end', agent, turn, step)
      const { error } = stepOutcome
      if (handle.isDisposed()) {
        reason = { kind: 'disposed' }
      } else if (abort.signal.aborted) {
        /* v8 ignore next -- abort.signal.reason always set by agent.abort() which provides a default */
        reason = { kind: 'aborted', reason: String(abort.signal.reason ?? 'aborted') }
      } else {
        const coded = error as CodedError
        session.append('error', { turn, step, ...errorData(coded) })
        ctx.emit('agent/error', agent, turn, step, error)
        reason = { kind: 'error', ...errorData(coded) }
      }
      break
    }

    // Steering that arrived during streaming/tool execution.
    const steered = drainSteering(ctx, agent, turn)

    session.append('step/end', { turn, step })
    ctx.emit('agent/step-end', agent, turn, step)

    const defaultDecision = stepOutcome.hadToolCalls || steered
    let shouldContinue: boolean
    try {
      shouldContinue = await ctx.waterfall(
        'agent/turn-continuation', agent, turn, defaultDecision,
        () => Promise.resolve(defaultDecision),
      )
    } catch (error: unknown) {
      // A broken continuation plugin ends the turn, not the loop.
      const err = toError(error)
      session.append('error', { turn, step, ...errorData(err) })
      ctx.emit('agent/error', agent, turn, step, err)
      reason = { kind: 'error', ...errorData(err) }
      break
    }

    // Steering from step-end/continuation listeners (the /goal pattern)
    // demands the model see it — it overrides a negative decision; the
    // next iteration's drain records it.
    if (!shouldContinue && agent.inbox.hasSteering) shouldContinue = true

    if (!shouldContinue || handle.isDisposed()) {
      /* v8 ignore next -- disposal during continuation-decision window is a narrow race; error-path disposal is covered elsewhere */
      if (handle.isDisposed()) reason = { kind: 'disposed' }
      break
    }
  }

  session.append('turn/end', { turn, reason })
  ctx.emit('agent/turn-end', agent, turn, reason)

  // Durability checkpoint: persistence plugins drain write-behind buffers.
  // A failing persistence plugin is reported but doesn't kill the agent.
  try {
    await ctx.parallel('session/flush', session)
  } catch (error: unknown) {
    const err = toError(error)
    session.append('error', { turn, step, ...errorData(err) })
    ctx.emit('agent/error', agent, turn, step, err)
  }
}

/** Drain the steering queue into the session. Returns whether any arrived. */
function drainSteering(ctx: Context, agent: LoopAgent, turn: number): boolean {
  const messages = agent.inbox.drainSteering()
  for (const message of messages) {
    agent.session.append('steering/message', { turn, content: message.content, source: message.source })
    ctx.emit('agent/steering', agent, turn, message.content, message.source)
  }
  return messages.length > 0
}

/** One step: assemble request → stream model → record → execute tools. */
async function runStep(
  ctx: Context,
  agent: LoopAgent,
  turn: number,
  step: number,
  signal: AbortSignal,
): Promise<{ hadToolCalls: boolean }> {
  const { session, options } = agent

  // --- Request assembly ---
  const assembly = await ctx.systemPrompt.assemble()
  const system = [renderPrompt(assembly), options.systemPrompt ?? '']
    .filter(text => text.length > 0)
    .join('\n\n')

  let request: GenerateOptions = {
    model: options.model ?? '',
    messages: session.deriveMessages(),
    ...system ? { system } : {},
    ...assembly.tools.length > 0 ? { tools: assembly.tools } : {},
    signal,
  }
  request = await ctx.waterfall('agent/request', agent, turn, step, request, () => Promise.resolve(request))
  if (!request.model) {
    throw new Error(`agent "${agent.id}" has no model: set AgentOptions.model or supply one via the agent/request waterfall`)
  }

  // --- Model call (streaming-first; raw chunks are the replay record) ---
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(request)) {
    /* v8 ignore next -- signal.reason always set by agent.abort() which provides a default */
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    session.append('assistant/chunk', { turn, step, chunk })
    ctx.emit('agent/stream-chunk', agent, turn, step, chunk)
    assembler.push(chunk)
  }

  // Adapters report provider/transport failures one of two sanctioned ways
  // (see the StreamChunk contract in dsh-llm): throw from stream() — already
  // handled by the caller's try/catch — OR end the stream with a
  // finish-error/aborted chunk. finishError() maps the latter to the step
  // error to raise (turn ends error/aborted, not a normal completed message).
  const stepError = finishError(assembler.finish)
  if (stepError) throw stepError

  // The step-result waterfall runs BEFORE the session append so the log (the
  // source of truth for derived history and replay) records the message that
  // tool dispatch actually uses.
  let message: Message = assembler.message()
  message = await ctx.waterfall('agent/step-result', agent, turn, step, message, () => Promise.resolve(message))

  session.append('assistant/message', { turn, step, content: message.content })
  if (assembler.usage) {
    session.append('usage', { turn, step, usage: assembler.usage })
  }

  // --- Tool execution (sequential; parallel execution is a TODO) ---
  // ToolRegistry.execute converts tool failures (including aborts) into
  // isError results, so abort is re-checked around every call here.
  const toolCalls = message.content.filter(block => block.type === 'tool-call')
  for (const call of toolCalls) {
    /* v8 ignore next -- signal.reason always set by agent.abort() which provides a default */
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    session.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
    let parsedArguments: unknown
    try {
      parsedArguments = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      parsedArguments = call.arguments
    }
    const result = await ctx.tools.execute({
      callId: call.id,
      name: call.name,
      arguments: parsedArguments,
      agent,
      signal,
    })
    session.append('tool/result', {
      turn, step,
      callId: result.callId,
      content: result.content,
      isError: result.isError,
    })
    // signal CAN flip during the await above (abort() inside a tool);
    // the analyzer can't see through the await boundary.
    // signal can flip during the await above (abort() inside a tool);
    // the analyzer can't see through the await boundary.
    /* v8 ignore start -- signal.reason default unreachable via agent.abort() */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    /* v8 ignore stop */
  }

  return { hadToolCalls: toolCalls.length > 0 }
}

/** The last turn number in a (possibly seeded) session log, or 0. */
function lastTurnNumber(session: Session): number {
  const lastStart = session.events.findLast(event => event.type === 'turn/start')
  return lastStart?.data.turn ?? 0
}
