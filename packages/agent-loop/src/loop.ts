import type { Context } from 'cordis'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason, TurnTrigger } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { LoopAgent } from './agent.ts'

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
 *   TURN: drain queued → session('turn/start') → emit agent/turn-start
 *     STEP loop:
 *       emit agent/step-start
 *       assembly = ctx.systemPrompt.assemble()          ⟵ waterfall system-prompt/assemble
 *       req = {model, system, tools, messages: session.deriveMessages(), signal}
 *       req = waterfall agent/request                   ⟵ hooks/compaction/model-switch
 *       stream ctx.llm.stream(req)                      ⟵ waterfall llm/stream (raw chunks)
 *         session('assistant/chunk'); emit agent/stream-chunk; assembler.push
 *       session('assistant/message','usage')
 *       msg = waterfall agent/step-result               ⟵ post-process before tool dispatch
 *       each tool-call (sequential):
 *         session('tool/call'); ctx.tools.execute()     ⟵ waterfall tools/execute
 *         session('tool/result')
 *       drain steering → session('steering/message'); emit agent/steering
 *       emit agent/step-end
 *       cont = waterfall agent/turn-continuation(default = hadToolCalls || steered)
 *     session('turn/end'); emit agent/turn-end
 *     await ctx.parallel('session/flush', session)      ⟵ durability checkpoint
 * ```
 */
export async function runLoop(ctx: Context, agent: LoopAgent, handle: LoopHandle): Promise<void> {
  const { session } = agent

  while (!handle.isDisposed()) {
    await agent.inbox.waitForQueued(handle.disposed)
    if (handle.isDisposed()) break

    handle.setStatus('running')
    const turn = nextTurnNumber(session)

    // Drain queued messages into the session — they trigger this turn.
    const queued = agent.inbox.drainQueued()
    const trigger: TurnTrigger = { kind: 'message', source: queued[0]!.source }
    for (const message of queued) {
      session.append('user/message', { content: message.content, source: message.source })
    }

    session.append('turn/start', { turn, trigger })
    ctx.emit('agent/turn-start', agent, turn)

    let reason: TurnEndReason = { kind: 'completed' }
    let step = 0

    while (true) {
      step += 1
      ctx.emit('agent/step-start', agent, turn, step)
      session.append('step/start', { turn, step })

      const abort = new AbortController()
      handle.setAbort(abort)

      let stepOutcome: { hadToolCalls: boolean } | { error: Error }
      try {
        stepOutcome = await runStep(ctx, agent, turn, step, abort.signal)
      } catch (error: any) {
        stepOutcome = { error: error instanceof Error ? error : new Error(String(error)) }
      } finally {
        handle.setAbort(undefined)
      }

      // Steering arrives between steps: drain before deciding continuation
      // so the decision (and the next request) sees it.
      const steered = agent.inbox.drainSteering()
      for (const message of steered) {
        session.append('steering/message', { turn, content: message.content, source: message.source })
        ctx.emit('agent/steering', agent, turn, message.content)
      }

      session.append('step/end', { turn, step })
      ctx.emit('agent/step-end', agent, turn, step)

      if ('error' in stepOutcome) {
        const { error } = stepOutcome
        if (abort.signal.aborted || handle.isDisposed()) {
          reason = { kind: 'aborted', reason: String(abort.signal.reason ?? 'aborted') }
        } else {
          session.append('error', { turn, step, message: error.message, code: (error as any).code })
          ctx.emit('agent/error', agent, turn, step, error)
          reason = { kind: 'error', message: error.message, code: (error as any).code }
        }
        break
      }

      const defaultDecision = stepOutcome.hadToolCalls || steered.length > 0
      const shouldContinue = await ctx.waterfall(
        'agent/turn-continuation', agent, turn, defaultDecision,
        async () => defaultDecision,
      )
      if (!shouldContinue || handle.isDisposed()) break
    }

    if (handle.isDisposed() && reason.kind === 'completed') {
      reason = { kind: 'disposed' }
    }
    session.append('turn/end', { turn, reason })
    ctx.emit('agent/turn-end', agent, turn, reason)

    // Durability checkpoint: persistence plugins drain write-behind buffers.
    await ctx.parallel('session/flush', session)

    if (!agent.inbox.hasQueued) handle.setStatus('idle')
  }
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
    model: options.model ?? 'default',
    messages: session.deriveMessages(),
    system: system || undefined,
    tools: assembly.tools.length > 0 ? assembly.tools : undefined,
    signal,
  }
  request = await ctx.waterfall('agent/request', agent, turn, step, request, async () => request)

  // --- Model call (streaming-first; raw chunks are the replay record) ---
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(request)) {
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    session.append('assistant/chunk', { turn, step, chunk })
    ctx.emit('agent/stream-chunk', agent, turn, step, chunk)
    assembler.push(chunk)
  }

  let message: Message = assembler.message()
  session.append('assistant/message', { turn, step, content: message.content })
  if (assembler.usage) {
    session.append('usage', { turn, step, usage: assembler.usage })
  }

  message = await ctx.waterfall('agent/step-result', agent, turn, step, message, async () => message)

  // --- Tool execution (sequential; parallel execution is a TODO) ---
  const toolCalls = message.content.filter(block => block.type === 'tool-call')
  for (const call of toolCalls) {
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
  }

  return { hadToolCalls: toolCalls.length > 0 }
}

function nextTurnNumber(session: LoopAgent['session']): number {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event.type === 'turn/start') {
      return (event.data as { turn: number }).turn + 1
    }
  }
  return 1
}
