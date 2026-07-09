/**
 * Tests for the queue-aware `Agent.cancel()` primitive. `cancel()` is the
 * broad verb — it clears queued + steering work, aborts an in-flight step, and
 * drops a turn about to start — whereas a bare step abort (the loop's private
 * `AbortController`) kills only the current step and leaves the queue intact.
 * These tests exercise every window where a cancel can land (idle, pre-step,
 * mid-step, continuation) and the marker's arm/reset rules that keep a cancel
 * from leaking to a later prompt or hanging `whenIdle()`.
 *
 * @module dsh-agent-loop/tests/cancel
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { type Message } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: ReactLoopAgent, text: string) {
  agent.send([{ type: 'text', text }])
}

/** Resolve on the agent's next idle transition (event-based, not status poll). */
function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** All user-message texts recorded in the log (to assert what actually ran). */
function userTexts(agent: ReactLoopAgent): string[] {
  return agent.session.events
    .filter(e => e.type === 'user/message')
    .flatMap(e => e.type === 'user/message' ? e.data.content : [])
    .flatMap(b => b.type === 'text' ? [b.text] : [])
}

describe('Agent.cancel()', () => {
  it('cancel() on an idle agent with nothing queued is a no-op; the next prompt runs (F2 leak guard)', async () => {
    const adapter = new MockAdapter([textResponse('reply')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // The loop is parked at the idle wait with nothing queued. A cancel here must
    // NOT arm the marker — otherwise the next legitimate prompt would be dropped.
    agent.cancel('nothing to cancel')

    send(agent, 'real prompt')
    await waitForIdle(ctx, agent)

    // The prompt ran: its user message is in the log and one turn completed.
    expect(userTexts(agent)).toEqual(['real prompt'])
    expect(agent.session.events.some(e => e.type === 'turn/end')).toBe(true)
  })

  it('pre-step cancel drops the about-to-start turn (no turn is opened)', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // send() queues synchronously (status still idle, loop microtask not yet
    // resumed). Cancel in that pre-step window: the queued turn must not run.
    send(agent, 'drop me')
    agent.cancel('pre-step')

    // Give the loop a chance to wake and process the cancel.
    await new Promise(r => setTimeout(r, 30))

    // No turn was opened — the queued prompt was dropped, never recorded.
    expect(userTexts(agent)).toEqual([])
    expect(agent.session.events.some(e => e.type === 'turn/start')).toBe(false)
    expect(agent.status).toBe('idle')
  })

  it('a whenIdle() waiter registered BEFORE a pre-step cancel resolves (F1 hang guard)', async () => {
    const adapter = new MockAdapter([textResponse('x')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // Queue work, then register a whenIdle() waiter while in the pre-step window
    // (status idle, hasQueued true) — it does NOT take the fast path. Then cancel.
    // The skip path must settle this waiter directly (no running→idle transition
    // ever fires), or it would hang forever.
    send(agent, 'q')
    const idle = agent.whenIdle()
    agent.cancel('pre-step')

    // Must resolve (not hang). A timeout makes the failure a clear test failure.
    await Promise.race([
      idle,
      new Promise((_r, reject) => setTimeout(() => { reject(new Error('whenIdle hung after pre-step cancel')) }, 1000)),
    ])
    expect(agent.status).toBe('idle')
  })

  it('cancel() mid-step aborts the in-flight model call; the turn ends aborted', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    agent.cancel('mid-step')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'aborted', reason: 'mid-step' }])
  })

  it('cancel() with no reason defaults to "cancelled" when aborting an in-flight step', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel() // no reason → default 'cancelled'
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'aborted', reason: 'cancelled' }])
  })

  it('a prompt sent AFTER a cancelled turn settles runs normally (marker reset)', async () => {
    const adapter = new MockAdapter(['hang', textResponse('second reply')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // First turn hangs; cancel it mid-step.
    send(agent, 'first')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel('cancel first')
    await waitForIdle(ctx, agent)

    // The marker must have been reset after the cancelled turn — a fresh prompt
    // runs to completion rather than being dropped by a stale marker.
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(userTexts(agent)).toContain('second')
    // The second turn completed (its reply was streamed).
    const reasons = agent.session.events.filter(e => e.type === 'turn/end')
    expect(reasons.length).toBe(2)
  })

  it('cancel from inside the agent/session-prefix waterfall drops the step (prefix-composition window)', async () => {
    const adapter = new MockAdapter([textResponse('should not stream')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // Prefix composition runs before the pre-step seam on the instance's first
    // step; a cancel landing inside it must drop the about-to-start step
    // without running the seam or the model.
    let streamed = false
    ctx.on('session/event', (_s, event) => { if (event.type === 'assistant/chunk') streamed = true })
    ctx.on('agent/session-prefix', async (_agent, _prefix, _signal, next) => {
      agent.cancel('from prefix composition')
      return next()
    })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(streamed).toBe(false)
    expect(reasons).toEqual([{ kind: 'aborted', reason: 'from prefix composition' }])
  })

  it('disposal from inside the agent/session-prefix waterfall ends the turn disposed (prefix-composition window)', async () => {
    const adapter = new MockAdapter([textResponse('should not stream')])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)

    const handle = ctx.agents.create({
      agentId: AgentId('a-dispose-prefix'),
      sessionId: SessionId('dispose-prefix-session'),
      agentOptions: { model: 'mock' },
    })
    const agent = handle.agent as ReactLoopAgent

    let disposalDone: Promise<void> | undefined
    let streamed = false
    ctx.on('session/event', (_s, event) => { if (event.type === 'assistant/chunk') streamed = true })
    ctx.on('agent/session-prefix', async (_agent, _prefix, _signal, next) => {
      disposalDone = handle.dispose()
      return next()
    })

    send(agent, 'go')
    await new Promise(resolve => setTimeout(resolve, 0))
    await disposalDone
    await agent.done

    // No step opened, no model call ran, and the turn closed disposed.
    expect(streamed).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    const turnEnd = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'disposed' })
  })

  it('a cancel-interrupted prefix composition is discarded: the next send recomposes and ships the fresh prefix (stale-cache guard)', async () => {
    const adapter = new MockAdapter([textResponse('reply')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // The first composition is interrupted mid-waterfall and — like an
    // abort-aware listener bailing on a firing signal — contributes nothing.
    // Caching that degraded result would silently strip the prefix from every
    // later request of this instance; the loop must discard it and recompose
    // on the next send, and the SECOND composition's value must be what the
    // wire and the header log carry.
    const opener: Message = { role: 'user', content: [{ type: 'text', text: 'fresh opener' }] }
    let compositions = 0
    ctx.on('agent/session-prefix', async (_agent, _prefix, _signal, next): Promise<Message[]> => {
      compositions += 1
      if (compositions === 1) {
        agent.cancel('mid-composition')
        return next()
      }
      return [opener, ...await next()]
    })

    send(agent, 'dropped')
    await waitForIdle(ctx, agent)
    send(agent, 'real prompt')
    await waitForIdle(ctx, agent)

    expect(compositions).toBe(2)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.messages[0]).toEqual(opener)
    const headerEvent = agent.session.events.find(e => e.type === 'request/header')
    expect(headerEvent?.type === 'request/header' && headerEvent.data.header.messagePrefix).toEqual([opener])
  })

  it('cancel from a synchronous turn/start session-event listener drops the step (step-start window)', async () => {
    const adapter = new MockAdapter([textResponse('should not stream')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // A turn/start listener fires right after turn/start is appended, BEFORE any
    // AbortController is installed for the step. Cancelling there must still drop
    // the step (the turn-scoped marker, not the step AbortController, is what
    // catches this) — no model step runs.
    let streamed = false
    ctx.on('session/event', (_s, event) => { if (event.type === 'assistant/chunk') streamed = true })
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/start') agent.cancel('from turn-start')
    })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    dispose()

    // No step streamed (the model never ran), and the turn ended aborted with
    // the CALLER's reason — the marker carries `cancel(reason)` through even
    // though no AbortController observed it in this window.
    expect(streamed).toBe(false)
    expect(reasons).toEqual([{ kind: 'aborted', reason: 'from turn-start' }])
  })

  it('cancel from a synchronous step/start session-event listener drops the step (post-step-start window)', async () => {
    const adapter = new MockAdapter([textResponse('should not stream')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // A step/start session-event listener fires AFTER step/start is appended
    // (and after the pre-step seam), so cancelling there lands in the SECOND
    // cancel check (the one that must closeStep() to balance the already-open
    // step) — distinct from a turn-start cancel, caught before the step opens.
    let streamed = false
    ctx.on('session/event', (_s, event) => { if (event.type === 'assistant/chunk') streamed = true })
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'step/start') agent.cancel('from step-start')
    })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    dispose()

    // No step streamed, the turn ended aborted with the caller's reason, and the
    // log is balanced (the open step was closed by the cancel branch).
    expect(streamed).toBe(false)
    expect(reasons).toEqual([{ kind: 'aborted', reason: 'from step-start' }])
    const types = agent.session.events.map(e => e.type)
    expect(types.filter(t => t === 'step/start').length).toBe(types.filter(t => t === 'step/end').length)
  })

  it('disposal from a synchronous step/start session-event listener closes the open step as disposed', async () => {
    const adapter = new MockAdapter([textResponse('should not stream')])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)

    const handle = ctx.agents.create({
      agentId: AgentId('a-dispose-step-start'),
      sessionId: SessionId('dispose-step-start-session'),
      agentOptions: { model: 'mock' },
    })
    const agent = handle.agent as ReactLoopAgent

    let disposalDone: Promise<void> | undefined
    let streamed = false
    ctx.on('session/event', (_s, event) => { if (event.type === 'assistant/chunk') streamed = true })
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'step/start') disposalDone = handle.dispose()
    })

    send(agent, 'go')
    await disposalDone
    await agent.done

    expect(streamed).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    const turnEnd = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'disposed' })
    const types = agent.session.events.map(e => e.type)
    expect(types.filter(t => t === 'step/start').length).toBe(types.filter(t => t === 'step/end').length)
  })

  it('cancel during the continuation window ends the turn aborted and runs no further step', async () => {
    // A continuation-waterfall listener cancels DURING the continuation decision
    // (the finished step's AbortController is already cleared), and votes to
    // continue — but the turn-scoped marker checked right after must end the turn
    // `aborted` and run NO second step.
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    let steps = 0
    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'step/start') steps += 1
      if (event.type === 'turn/end') reasons.push(event.data.reason)
    })

    let continued = false
    ctx.on('agent/turn-continuation', async (subject, _turn, _default, next) => {
      if (subject === agent && !continued) {
        continued = true
        agent.cancel('from continuation')
        return { action: 'continue' as const } // vote to continue — the post-waterfall marker check must override
      }
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // Only ONE step ran (the second was cancelled in the continuation window),
    // and the turn ended aborted with the CALLER's reason (carried by the
    // marker, since the finished step's AbortController was already cleared).
    expect(steps).toBe(1)
    expect(reasons).toEqual([{ kind: 'aborted', reason: 'from continuation' }])
  })

  it('cancel from a synchronous agent/status(running) listener drops the turn (window 2)', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    // setStatus('running') emits agent/status SYNCHRONOUSLY, so a running
    // listener can cancel in the gap between the loop's pre-step check and
    // runTurn. The second check (after the running flip) must drop the turn —
    // runTurn would otherwise throw on the now-empty queue.
    let streamed = false
    ctx.on('session/event', (_s, event) => { if (event.type === 'assistant/chunk') streamed = true })
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'running') agent.cancel('from running listener')
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    dispose()

    // No turn opened, no step streamed, and a later prompt still runs (the marker
    // was reset).
    expect(streamed).toBe(false)
    expect(agent.session.events.some(e => e.type === 'turn/start')).toBe(false)
  })

  it('window 2: whenIdle() does NOT resolve early when a running listener cancels then queues replacement work', async () => {
    // The window-1 early-resolve race has a window-2 twin: a synchronous
    // agent/status('running') listener cancels the about-to-run turn AND queues a
    // replacement. window 2 must NOT settle waiters (via setStatus('idle')) while
    // the replacement is still queued-and-unrun — it must fall through and run it,
    // so whenIdle() resolves on the replacement turn's running→idle, not before.
    const adapter = new MockAdapter([textResponse('A reply'), textResponse('B reply')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    let replaced = false
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject !== agent || status !== 'running' || replaced) return
      replaced = true
      agent.cancel('drop A')
      send(agent, 'B')
    })

    send(agent, 'A')
    const idle = agent.whenIdle()
    await idle
    dispose()

    // whenIdle() resolved only AFTER B's turn ran: B's user message + a turn/end
    // are in the log, and A was dropped.
    expect(userTexts(agent)).toContain('B')
    expect(userTexts(agent)).not.toContain('A')
    expect(agent.session.events.some(e => e.type === 'turn/end')).toBe(true)
  })

  it('whenIdle() does NOT resolve early when a new prompt is queued during a pre-step cancel', async () => {
    // The subtle race: a whenIdle() waiter is registered for prompt A; cancel()
    // clears A; prompt B is queued BEFORE the loop resumes from the idle wait.
    // The window-1 cancel branch must NOT settle the waiter while B is still
    // queued-and-unrun — whenIdle() must wait for B's turn to actually run and
    // settle (the quiescence contract), not resolve before B's first event.
    const adapter = new MockAdapter([textResponse('A reply'), textResponse('B reply')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'A')           // queues A (status still idle, loop microtask pending)
    const idle = agent.whenIdle() // registers a waiter (idle + hasQueued → no fast path)
    agent.cancel('drop A')     // arms marker, clears A
    send(agent, 'B')           // B races in before the loop resumes

    // whenIdle() must resolve only AFTER B's turn fully ran — by which point B's
    // user message and a turn/end are in the log. (Before the fix it resolved
    // immediately, with zero events, then B ran afterward.)
    await idle
    expect(userTexts(agent)).toContain('B')
    expect(agent.session.events.some(e => e.type === 'turn/end')).toBe(true)
    // A was dropped (never ran); only B's turn is recorded.
    expect(userTexts(agent)).not.toContain('A')
  })

  it("cancel clears the turn's steering — it is not re-enqueued as a fresh turn", async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    // Steer (joins the running turn's steering FIFO), then cancel: the steering
    // must be dropped, NOT re-enqueued as a new queued turn.
    agent.steer([{ type: 'text', text: 'steer text' }])
    agent.cancel('cancel with steering')
    await waitForIdle(ctx, agent)

    // After the cancelled turn settles, the agent is idle with NO follow-up turn
    // started from the dropped steering.
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('idle')
    const turnStarts = agent.session.events.filter(e => e.type === 'turn/start')
    expect(turnStarts.length).toBe(1) // only the original (cancelled) turn
    // The steering text was dropped — it never reached the log.
    const flat = agent.session.events
      .filter(e => e.type === 'steering/message')
      .flatMap(e => e.type === 'steering/message' ? e.data.content : [])
      .flatMap(b => b.type === 'text' ? [b.text] : [])
    expect(flat).not.toContain('steer text')
  })
})
