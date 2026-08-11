import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { TaskId } from '@deepseek-ai/dsh-tasks'
import type { TaskHooks, TaskKind, TaskOutcome, TaskSnapshot, TaskStart } from '@deepseek-ai/dsh-tasks'
import LocalTaskService from '@deepseek-ai/dsh-tasks-local'

declare module '@deepseek-ai/dsh-tasks' {
  interface TaskKindMap {
    workflow: 'workflow'
  }
}

const agentScopeDisposers = new WeakMap<Agent, () => Promise<void>>()

function stubAgent(ctx: Context, rawId: string, presetScope?: ScopeKey): Agent {
  const id = SessionId(rawId)
  const scopeFiber = ctx.plugin(() => {})
  // `presetScope` reproduces what `agentPresets.compose` does: the agent gets
  // its own key parented to the standing mount's, so the registry's chain walk
  // reaches that preset's layer.
  let agentCtx = scopeFiber.ctx
  if (presetScope !== undefined) {
    const key = {}
    bindScopeParent(key, presetScope)
    agentCtx = createScope(scopeFiber.ctx, key).ctx
  }
  const session = Session.create(id)
  const agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle' as const,
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  agentScopeDisposers.set(agent, async () => { await scopeFiber.dispose() })
  return agent
}

async function disposeAgentScope(agent: Agent): Promise<void> {
  const dispose = agentScopeDisposers.get(agent)
  if (dispose === undefined) throw new Error(`missing test scope for agent "${agent.id}"`)
  await dispose()
}

/** A controllable producer start-spec: settle its `done` on demand, record cancels. */
function producer(overrides: Partial<Omit<TaskStart, 'run'> & TaskHooks> = {}) {
  let settle!: (outcome: TaskOutcome) => void
  let reject!: (error: unknown) => void
  const cancels: (string | undefined)[] = []
  const { kind = 'bash', label = 'sleep 60', owner, outputLimitBytes, ...hookOverrides } = overrides
  const hooks: TaskHooks = {
    cancel(reason) { cancels.push(reason) },
    done: new Promise<TaskOutcome>((res, rej) => { settle = res; reject = rej }),
    ...hookOverrides,
  }
  const spec: TaskStart = {
    kind,
    label,
    ...owner !== undefined ? { owner } : {},
    ...outputLimitBytes !== undefined ? { outputLimitBytes } : {},
    run: () => hooks,
  }
  return { spec, settle, reject, cancels }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalTaskService)
  ctx.tasks.attachController('test-controller')
  return ctx
}

/**
 * Attach a task controller the way `tool-tasks` does: from a plugin whose own
 * `inject` resolves `ctx.tasks`, so the service method binds to the REGISTERING
 * context and the controller files into that context's scope layer. Reading the
 * service off a bare scoped context instead throws `cannot get property "tasks"
 * without inject`, which is the same rule the shipped plugin obeys.
 * @param ctx - the context whose scope should own the controller.
 */
async function attachControllerIn(ctx: Context): Promise<void> {
  await ctx.plugin({
    inject: ['tasks'],
    apply(pluginCtx: Context) { pluginCtx.tasks.attachController('tool-tasks') },
  })
}

/** Let the settlement continuation (a `done.then`) run. */
const tick = () => new Promise<void>(r => setTimeout(r, 0))

/** Inspect the internal resolver registry to pin bounded retention while a task stays live. */
function waitResolverCount(ctx: Context, id: TaskId): number {
  const service = ctx.tasks as unknown as { store: Map<TaskId, { waitResolvers: Set<() => void> }> }
  const task = service.store.get(id)
  if (task === undefined) throw new Error(`missing test task ${id}`)
  return task.waitResolvers.size
}

describe('LocalTaskService.start', () => {
  it('preserves the SessionId brand on public owner snapshots', () => {
    expectTypeOf<TaskSnapshot['ownerSession']>().toEqualTypeOf<SessionId | undefined>()
  })

  it('refuses to register while no task controller serves the owner', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalTaskService)
    expect(() => ctx.tasks.start(producer().spec))
      .toThrow('background tasks unavailable: no task controller serves this agent (load @deepseek-ai/dsh-tool-tasks in its composition)')
  })

  it('refuses an owner whose own composition attaches no controller', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalTaskService)
    // Two standing preset mounts over one registry; only the first loads the
    // task controls. The second must not inherit the first's open gate.
    const withControls = createScope(ctx, {})
    const withoutControls = createScope(ctx, {})
    await attachControllerIn(withControls.ctx)

    const served = stubAgent(ctx, 'served', scopeOf(withControls.ctx))
    const unserved = stubAgent(ctx, 'unserved', scopeOf(withoutControls.ctx))
    ctx.agents.register(served)
    ctx.agents.register(unserved)

    expect(() => ctx.tasks.start(producer({ owner: served }).spec)).not.toThrow()
    expect(() => ctx.tasks.start(producer({ owner: unserved }).spec))
      .toThrow('no task controller serves this agent')
    // An unowned producer has no chain to walk, so only a global controller serves it.
    expect(() => ctx.tasks.start(producer().spec))
      .toThrow('no task controller serves this agent')
  })

  it('lets a controller attached without a scope serve every owner', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalTaskService)
    // The host-plane composition's own controls: no scope, so the global layer
    // holds them and every owner's read includes it.
    await attachControllerIn(ctx)
    const scoped = stubAgent(ctx, 'scoped', scopeOf(createScope(ctx, {}).ctx))
    ctx.agents.register(scoped)

    expect(() => ctx.tasks.start(producer({ owner: scoped }).spec)).not.toThrow()
    expect(() => ctx.tasks.start(producer().spec)).not.toThrow()
  })

  it('rejects an empty kind, empty label, and invalid output limit', async () => {
    const ctx = await harness()
    expect(() => ctx.tasks.start(producer({ kind: '' as TaskKind }).spec)).toThrow('invalid task kind')
    expect(() => ctx.tasks.start(producer({ label: '' }).spec)).toThrow('invalid task label')
    expect(() => ctx.tasks.start(producer({ outputLimitBytes: 0 }).spec)).toThrow('outputLimitBytes')
  })

  it('issues kind-prefixed ids from per-kind counters', async () => {
    const ctx = await harness()
    expect(ctx.tasks.start(producer().spec)).toBe('bash-1')
    expect(ctx.tasks.start(producer().spec)).toBe('bash-2')
    expect(ctx.tasks.start(producer({ kind: 'subagent' }).spec)).toBe('subagent-1')
    expect(ctx.tasks.start(producer({ kind: 'workflow' }).spec)).toBe('workflow-1')
  })
})

describe('LocalTaskService reads and settlement', () => {
  it('stream kinds read a consuming delta; terminal reads mark reported', async () => {
    const ctx = await harness()
    const chunks = ['first', '', 'rest']
    const p = producer({ readOutput: () => chunks.shift() ?? '' })
    const id = ctx.tasks.start(p.spec)

    expect(ctx.tasks.read(id)).toMatchObject({ text: 'first', snapshot: { status: 'running', reported: false } })
    expect(ctx.tasks.read(id).text).toBe('')

    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    const read = ctx.tasks.read(id)
    expect(read.text).toBe('rest')
    expect(read.snapshot).toMatchObject({ status: 'completed', detail: 'exit code: 0', reported: true })
    expect(read.snapshot.finishedAt).toBeTypeOf('number')
  })

  it('projects a producer-owned model output limit into reads and snapshots', async () => {
    const ctx = await harness()
    const p = producer({ outputLimitBytes: 64, readOutput: () => 'delta' })
    const id = ctx.tasks.start(p.spec)
    expect(ctx.tasks.read(id)).toMatchObject({
      text: 'delta', snapshot: { outputLimitBytes: 64 },
    })
    expect(ctx.tasks.get(id)).toMatchObject({ outputLimitBytes: 64 })
  })

  it('final-output kinds read empty while live, the outcome output idempotently once settled', async () => {
    const ctx = await harness()
    const p = producer({ kind: 'subagent', label: 'research task' })
    const id = ctx.tasks.start(p.spec)

    expect(ctx.tasks.read(id)).toMatchObject({ text: '', snapshot: { status: 'running' } })

    p.settle({ status: 'completed', output: 'final answer' })
    await tick()
    expect(ctx.tasks.read(id).text).toBe('final answer')
    expect(ctx.tasks.read(id).text).toBe('final answer') // idempotent, not consumed
  })

  it('a settled task without output reads as empty text', async () => {
    const ctx = await harness()
    const p = producer({ kind: 'subagent' })
    const id = ctx.tasks.start(p.spec)
    p.settle({ status: 'failed', detail: 'max-tokens' })
    await tick()
    expect(ctx.tasks.read(id)).toMatchObject({ text: '', snapshot: { status: 'failed', detail: 'max-tokens' } })
  })

  it('throws for unknown task ids', async () => {
    const ctx = await harness()
    expect(() => ctx.tasks.read(TaskId('bash-99'))).toThrow('unknown task bash-99')
  })

  it('notifies onTaskDone once per task with containment across listeners', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(() => { throw new Error('listener boom') })
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))

    const p = producer()
    const id = ctx.tasks.start(p.spec)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id, status: 'completed', reported: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener boom'))
  })

  it('contains a rejecting onTaskDone listener without starving later listeners', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: TaskId[] = []
    ctx.tasks.onTaskDone(async () => { throw new Error('async listener boom') })
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot.id))

    const p = producer()
    const id = ctx.tasks.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()

    expect(seen).toEqual([id])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onTaskDone listener rejected'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('async listener boom'))
  })

  it("contains rejection from the producer's done promise as a failed outcome (producer contract violation)", async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const p = producer()
    const id = ctx.tasks.start(p.spec)
    p.reject(new Error('transport exploded'))
    await tick()

    expect(ctx.tasks.read(id).snapshot).toMatchObject({ status: 'failed', detail: 'Error: transport exploded' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('producer contract violation'))
  })

  it('unregisters onTaskDone listeners with the contributing fiber (HMR safety)', async () => {
    const ctx = await harness()
    const seen: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.tasks.onTaskDone(snapshot => void seen.push(snapshot.id))
    }, { inject: ['tasks'] }))
    await fiber.dispose()
    // The returned disposer detaches too (the non-fiber path).
    const detach = ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot.id))
    detach()

    const p = producer()
    ctx.tasks.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(seen).toEqual([])
  })
})

describe('LocalTaskService.kill', () => {
  it('cancels a live task with the forwarded reason and suppresses the notice', async () => {
    const ctx = await harness()
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.tasks.start(p.spec)

    expect(ctx.tasks.kill(id, undefined, 'no longer needed')).toBe('requested')
    expect(p.cancels).toEqual(['no longer needed'])
    expect(ctx.tasks.list()[0]).toMatchObject({ status: 'stopping', reported: true })

    p.settle({ status: 'killed' })
    await tick()
    // The listener still fires (telemetry may care), but carries reported: true
    // so the notice path suppresses its redundant "finished".
    expect(seen[0]).toMatchObject({ id, status: 'killed', reported: true })
  })

  it('reports an already-finished task instead of failing', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.tasks.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(ctx.tasks.kill(id)).toBe('already-finished')
  })

  it('propagates a throwing producer cancel and leaves the task untouched', async () => {
    const ctx = await harness()
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))
    let broken = true
    let settle!: (outcome: TaskOutcome) => void
    const id = ctx.tasks.start({
      kind: 'bash',
      label: 'flaky cancel',
      run: () => ({
        cancel() { if (broken) throw new Error('cancel boom') },
        done: new Promise<TaskOutcome>((res) => { settle = res }),
      }),
    })
    expect(() => ctx.tasks.kill(id)).toThrow('cancel boom')
    // The failed kill mutated NOTHING: still running, notice not suppressed,
    // and a later (successful) kill still works.
    expect(ctx.tasks.get(id)).toMatchObject({ status: 'running', reported: false })
    settle({ status: 'completed' })
    await tick()
    expect(seen[0]).toMatchObject({ id, reported: false }) // notice would still fire

    broken = false
    expect(ctx.tasks.kill(id)).toBe('already-finished')
  })
})

describe('LocalTaskService.wait', () => {
  it('resolves with the terminal snapshot when the task settles, marked reported', async () => {
    const ctx = await harness()
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.tasks.start(p.spec)

    const wait = ctx.tasks.wait(id, 5_000)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    expect(await wait).toMatchObject({ status: 'completed', reported: true })
    // A waiting reader claims delivery before completion listeners inspect the snapshot.
    expect(seen[0]).toMatchObject({ id, reported: true })
  })

  it('returns the live snapshot on timeout without marking reported', async () => {
    const ctx = await harness()
    const id = ctx.tasks.start(producer().spec)
    expect(await ctx.tasks.wait(id, 5)).toMatchObject({ status: 'running', reported: false })
  })

  it('unregisters timed-out and aborted wait resolvers while the task remains live', async () => {
    const ctx = await harness()
    const id = ctx.tasks.start(producer().spec)

    for (let index = 0; index < 3; index += 1) {
      const wait = ctx.tasks.wait(id, 5)
      expect(waitResolverCount(ctx, id)).toBe(1)
      await expect(wait).resolves.toMatchObject({ status: 'running' })
      expect(waitResolverCount(ctx, id)).toBe(0)
    }

    const controller = new AbortController()
    const wait = ctx.tasks.wait(id, 5_000, undefined, controller.signal)
    expect(waitResolverCount(ctx, id)).toBe(1)
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(waitResolverCount(ctx, id)).toBe(0)
    expect(ctx.tasks.get(id).status).toBe('running')
  })

  it('returns immediately for an already-finished task', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.tasks.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(await ctx.tasks.wait(id, 5_000)).toMatchObject({ status: 'completed', reported: true })
  })

  it('rejects a non-positive or non-finite timeout', async () => {
    const ctx = await harness()
    const id = ctx.tasks.start(producer().spec)
    await expect(ctx.tasks.wait(id, 0)).rejects.toThrow('invalid wait timeout')
    await expect(ctx.tasks.wait(id, Number.NaN)).rejects.toThrow('invalid wait timeout')
  })

  it('an aborted signal rejects the wait only — the task stays alive', async () => {
    const ctx = await harness()
    const id = ctx.tasks.start(producer().spec)

    const controller = new AbortController()
    const wait = ctx.tasks.wait(id, 5_000, undefined, controller.signal)
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(ctx.tasks.list()[0]).toMatchObject({ status: 'running' })

    const preAborted = new AbortController()
    preAborted.abort()
    await expect(ctx.tasks.wait(id, 5_000, undefined, preAborted.signal)).rejects.toThrow('wait aborted')
  })

  it('an abort racing settlement in the same tick does not swallow the notice', async () => {
    const ctx = await harness()
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.tasks.start(p.spec)

    const controller = new AbortController()
    const wait = ctx.tasks.wait(id, 5_000, undefined, controller.signal)
    // Settlement is queued first, so abort must remove the waiter synchronously;
    // otherwise settlement suppresses the notice for a reader that receives nothing.
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id, status: 'completed', reported: false })
  })

  it('an abort landing after settlement still delivers the terminal snapshot it owes', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    const seen: TaskSnapshot[] = []
    // The listener aborts after settlement released this waiter but before its
    // resolve microtask runs. Releasing waiters ahead of the announcement is
    // what makes that abort harmless; this is the guard on that ordering.
    ctx.tasks.onTaskDone((snapshot) => {
      seen.push(snapshot)
      controller.abort()
    })
    const p = producer()
    const id = ctx.tasks.start(p.spec)

    const wait = ctx.tasks.wait(id, 5_000, undefined, controller.signal)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await expect(wait).resolves.toMatchObject({ status: 'completed', reported: true })
    expect(seen[0]).toMatchObject({ id, reported: true }) // suppression stays honest: the wait delivered
  })
})

describe('LocalTaskService owner isolation', () => {
  it('fences read/kill/wait to the owning session and keeps unowned tasks open', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const other = stubAgent(ctx, 'other')

    const owned = ctx.tasks.start(producer({ owner }).spec)
    const open = ctx.tasks.start(producer().spec)

    // The owner and the unowned task are reachable.
    expect(ctx.tasks.read(owned, owner).snapshot.id).toBe(owned)
    expect(ctx.tasks.read(open, other).snapshot.id).toBe(open)

    // A different session and a no-agent caller are rejected.
    expect(() => ctx.tasks.read(owned, other)).toThrow(`task ${owned} belongs to another session`)
    expect(() => ctx.tasks.kill(owned, other)).toThrow('belongs to another session')
    await expect(ctx.tasks.wait(owned, 10, other)).rejects.toThrow('belongs to another session')
    expect(() => ctx.tasks.read(owned)).toThrow('belongs to another session')
  })

  it('list() shows only caller-owned plus unowned tasks', async () => {
    const ctx = await harness()
    const alice = stubAgent(ctx, 'alice')
    const bob = stubAgent(ctx, 'bob')
    ctx.agents.register(alice)
    ctx.agents.register(bob)

    const aliceTask = ctx.tasks.start(producer({ owner: alice }).spec)
    const bobTask = ctx.tasks.start(producer({ owner: bob }).spec)
    const openTask = ctx.tasks.start(producer({ kind: 'subagent' }).spec)

    expect(ctx.tasks.list(alice).map(t => t.id)).toEqual([aliceTask, openTask])
    expect(ctx.tasks.list(bob).map(t => t.id)).toEqual([bobTask, openTask])
    expect(ctx.tasks.list().map(t => t.id)).toEqual([openTask])
  })

  it('rejects an owned registration when no agent registry is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalTaskService)
    ctx.tasks.attachController('test-controller')
    expect(() => ctx.tasks.start(producer({ owner: stubAgent(ctx, 'a') }).spec))
      .toThrow('background task ownership requires the agent registry')
    // The failed registration mutated nothing: no stored task, counter untouched.
    expect(ctx.tasks.list()).toEqual([])
    expect(ctx.tasks.start(producer().spec)).toBe('bash-1')
  })

  it('a failed owner-cleanup attach leaves the registry unchanged and does not poison the owner', async () => {
    const ctx = await harness()
    const ghost = stubAgent(ctx, 'ghost') // never registered in ctx.agents

    // Exact-instance validation precedes registry mutation and cleanup attachment.
    expect(() => ctx.tasks.start(producer({ owner: ghost }).spec))
      .toThrow('is not the registered agent instance')
    expect(ctx.tasks.list(ghost)).toEqual([])

    // A later valid registration must still attach cleanup for the same object.
    ctx.agents.register(ghost)
    const cancels: (string | undefined)[] = []
    let settle!: (outcome: TaskOutcome) => void
    const id = ctx.tasks.start({
      kind: 'bash',
      label: 'after retry',
      owner: ghost,
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<TaskOutcome>((res) => { settle = res }),
      }),
    })
    expect(id).toBe('bash-1') // the failed attempt burned no counter
    await disposeAgentScope(ghost)
    expect(cancels).toEqual(['owner disposed'])
    expect(ctx.tasks.list(ghost)).toEqual([])
  })

  it('rejects a stale owner instance after another agent reuses its id', async () => {
    const ctx = await harness()
    const staleOwner = stubAgent(ctx, 'owner')
    const unregisterStale = ctx.agents.register(staleOwner)
    unregisterStale()

    const currentOwner = stubAgent(ctx, 'owner')
    ctx.agents.register(currentOwner)
    const current = producer({ owner: currentOwner })
    ctx.tasks.start(current.spec) // Attach the current owner's cleanup first.

    const stale = producer({ owner: staleOwner })
    const staleRun = vi.fn(() => stale.spec.run())
    expect(() => ctx.tasks.start({ ...stale.spec, run: staleRun }))
      .toThrow('is not the registered agent instance')
    expect(staleRun).not.toHaveBeenCalled()
    // Access is keyed by the unified session id, so a reconnect carrying the
    // same identity can observe the current task even though stale ownership
    // registration is rejected by exact-instance validation.
    expect(ctx.tasks.list(staleOwner)).toHaveLength(1)
    expect(ctx.tasks.list(currentOwner)).toHaveLength(1)

    current.settle({ status: 'completed' })
    await tick()
    await disposeAgentScope(currentOwner)
  })
})

describe('LocalTaskService owner cleanup', () => {
  it('drains the owner: cancels live tasks, awaits settlement, drops snapshots', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)

    // The producer settles only when cancelled — models a child that stops on request.
    let settle!: (outcome: TaskOutcome) => void
    const cancels: (string | undefined)[] = []
    ctx.tasks.start({
      kind: 'subagent',
      label: 'long research',
      owner,
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<TaskOutcome>((res) => { settle = res }),
      }),
    })
    const terminal = producer({ owner })
    ctx.tasks.start(terminal.spec)
    terminal.settle({ status: 'completed' })
    await tick()

    await disposeAgentScope(owner)
    expect(cancels).toEqual(['owner disposed'])
    // Snapshots dropped: nothing of the owner's remains, listing is empty.
    expect(ctx.tasks.list(owner)).toEqual([])
  })

  it('publishes the settled visible set before announcing completion', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const p = producer({ owner })
    ctx.tasks.start(p.spec)
    // Registered after start so only the settlement's notifications are ordered.
    const order: string[] = []
    ctx.tasks.onTasksChanged(() => void order.push('changed'))
    ctx.tasks.onTaskDone(() => void order.push('done'))

    p.settle({ status: 'completed' })
    await tick()

    // A completion reporter may open a turn synchronously. Announcing before
    // the visible set is published would let a client render that turn while
    // its task row still reads `running`.
    expect(order).toEqual(['changed', 'done'])
  })

  it('reports a teardown-cancelled record so completion reporters stay quiet', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))

    let settle!: (outcome: TaskOutcome) => void
    ctx.tasks.start({
      kind: 'subagent',
      label: 'long research',
      owner,
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<TaskOutcome>((res) => { settle = res }),
      }),
    })

    // Observers still receive the terminal record; the report bit is what
    // keeps a notice reporter from addressing an owner being destroyed.
    await disposeAgentScope(owner)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.reported).toBe(true)
  })

  it('attaches one cleanup per owner and drains all owned tasks with the scope', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)

    const first = producer({ owner })
    const second = producer({ owner })
    ctx.tasks.start(first.spec)
    ctx.tasks.start(second.spec)
    first.settle({ status: 'completed' })
    second.settle({ status: 'completed' })
    await tick()
    expect(owner.ctx.fiber.getEffects().filter(effect => effect.label === 'tasks.ownerCleanup()')).toHaveLength(1)
    await disposeAgentScope(owner)
    expect(ctx.tasks.list(owner)).toEqual([])
  })

  it('does not let an old scope cleanup cancel a same-id/session replacement task', async () => {
    const ctx = await harness()
    const oldOwner = stubAgent(ctx, 'owner')
    const detachOld = ctx.agents.register(oldOwner)
    const cancels: string[] = []

    function start(owner: Agent, label: string): TaskId {
      let settle!: (outcome: TaskOutcome) => void
      return ctx.tasks.start({
        kind: 'bash',
        label,
        owner,
        run: () => ({
          cancel() { cancels.push(label); settle({ status: 'killed' }) },
          done: new Promise<TaskOutcome>((resolve) => { settle = resolve }),
        }),
      })
    }

    start(oldOwner, 'old task')
    detachOld()
    const replacement = stubAgent(ctx, 'owner')
    ctx.agents.register(replacement)
    const replacementId = start(replacement, 'replacement task')

    await disposeAgentScope(oldOwner)
    expect(cancels).toEqual(['old task'])
    expect(ctx.tasks.list(replacement).map(task => task.id)).toEqual([replacementId])

    await disposeAgentScope(replacement)
    expect(cancels).toEqual(['old task', 'replacement task'])
  })

  it('registers owner cleanup on the agent scope rather than the tasks fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const tasksFiber = await ctx.plugin(LocalTaskService)
    ctx.tasks.attachController('test-controller')
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const ownerCleanupEffects = () => owner.ctx.fiber.getEffects()
      .filter(effect => effect.label === 'tasks.ownerCleanup()')

    const first = producer({ owner })
    ctx.tasks.start(first.spec)
    expect(ownerCleanupEffects()).toHaveLength(1)
    first.settle({ status: 'completed' })
    await tick()
    expect(tasksFiber.getEffects().some(effect => effect.label === 'tasks.ownerCleanup()')).toBe(false)
    await disposeAgentScope(owner)

    // Only the owner registration is released; the long-lived tasks service
    // and its own teardown effect remain active.
    expect(ownerCleanupEffects()).toHaveLength(0)
    expect(ctx.get('tasks')).toBeDefined()
    expect(tasksFiber.getEffects().some(effect => effect.label === 'tasks teardown')).toBe(true)

  })

  it('force-fails a throwing teardown cancel without awaiting producer done, first outcome wins', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))

    let settle!: (outcome: TaskOutcome) => void
    ctx.tasks.start({
      kind: 'bash',
      label: 'broken producer',
      owner,
      run: () => ({
        cancel() { throw new Error('cancel boom') },
        done: new Promise<TaskOutcome>((res) => { settle = res }),
      }),
    })

    const drain = disposeAgentScope(owner)
    let drained = false
    void drain.then(() => { drained = true })
    await tick()
    const drainedWithoutProducerDone = drained
    if (!drainedWithoutProducerDone) {
      // Release the producer if the assertion fails so the test can finish.
      settle({ status: 'completed' })
      await drain
    } else {
      // A late producer completion must not replace the failure or notify twice.
      settle({ status: 'completed' })
      await tick()
    }

    expect(drainedWithoutProducerDone).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('work may be orphaned'))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.status).toBe('failed')
    expect(seen[0]?.detail).toContain('cancel threw during teardown')
    expect(ctx.tasks.list(owner)).toEqual([])
  })
})

describe('LocalTaskService disposal', () => {
  it('cancels live tasks, awaits settlement, and silences listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalTaskService)
    const controller = await ctx.plugin(Object.assign((inner: Context) => {
      inner.tasks.attachController('test-controller')
    }, { inject: ['tasks'] }))
    void controller

    const seen: string[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot.id))
    let settle!: (outcome: TaskOutcome) => void
    const cancels: (string | undefined)[] = []
    ctx.tasks.start({
      kind: 'bash',
      label: 'sleep 600',
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<TaskOutcome>((res) => { settle = res }),
      }),
    })

    await fiber.dispose()
    expect(cancels).toEqual(['tasks service disposed'])
    // The teardown kill settles AFTER the listener registry closed: silent.
    expect(seen).toEqual([])
  })

  it('force-fails a throwing cancel so service disposal does not await producer done', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalTaskService)
    ctx.tasks.attachController('test-controller')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))

    let settle!: (outcome: TaskOutcome) => void
    ctx.tasks.start({
      kind: 'bash',
      label: 'broken service task',
      run: () => ({
        cancel() { throw new Error('service cancel boom') },
        done: new Promise<TaskOutcome>((resolve) => { settle = resolve }),
      }),
    })

    const disposal = fiber.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await tick()
    const disposedWithoutProducerDone = disposed
    if (!disposedWithoutProducerDone) {
      // Release the producer if the assertion fails so the test can finish.
      settle({ status: 'completed' })
      await disposal
    } else {
      settle({ status: 'completed' })
      await tick()
    }

    expect(disposedWithoutProducerDone).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('work may be orphaned'))
    expect(seen).toEqual([])
  })

  it('detaches owner effects from still-live agent scopes when the service unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const tasksFiber = await ctx.plugin(LocalTaskService)
    ctx.tasks.attachController('test-controller')
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    let settle!: (outcome: TaskOutcome) => void
    ctx.tasks.start({
      kind: 'bash',
      label: 'owned work',
      owner,
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<TaskOutcome>((resolve) => { settle = resolve }),
      }),
    })
    const ownerEffects = () => owner.ctx.fiber.getEffects()
      .filter(effect => effect.label === 'tasks.ownerCleanup()')
    expect(ownerEffects()).toHaveLength(1)

    await tasksFiber.dispose()

    expect(ownerEffects()).toHaveLength(0)
  })

  it('drops a scoped layer when its registrations dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalTaskService)
    const standing = createScope(ctx, {})
    // One mount contributes both kinds into the same layer, as `tool-tasks`
    // does; unloading it must leave nothing serving the agents that joined it.
    const mount = await standing.ctx.plugin({
      inject: ['tasks'],
      apply(pluginCtx: Context) {
        pluginCtx.tasks.attachController('tool-tasks')
        pluginCtx.tasks.onTaskDone(() => {})
      },
    })
    const owner = stubAgent(ctx, 'joined', scopeOf(standing.ctx))
    ctx.agents.register(owner)
    expect(() => ctx.tasks.start(producer({ owner }).spec)).not.toThrow()

    await mount.dispose()

    expect(() => ctx.tasks.start(producer({ owner }).spec))
      .toThrow('no task controller serves this agent')
  })

  it('detaching the last controller re-arms the register fence', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalTaskService)
    const detachA1 = ctx.tasks.attachController('a')
    const detachA2 = ctx.tasks.attachController('a') // duplicate name counts independently
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.tasks.attachController('b')
    }, { inject: ['tasks'] }))

    detachA1()
    detachA1() // second call of the same disposer is a no-op
    expect(() => ctx.tasks.start(producer().spec)).not.toThrow() // a ×1 + b remain
    detachA2()
    expect(() => ctx.tasks.start(producer().spec)).not.toThrow() // b remains
    await fiber.dispose() // detaches b with its fiber (HMR safety)
    expect(() => ctx.tasks.start(producer().spec)).toThrow('no task controller serves this agent')
  })
})

describe('LocalTaskService.onTasksChanged', () => {
  it('fires after registration, the stopping transition, and settlement', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'alice')
    ctx.agents.register(owner)
    const seen: (string | undefined)[] = []
    ctx.tasks.onTasksChanged(changed => void seen.push(changed?.id))

    const p = producer({ owner })
    const id = ctx.tasks.start(p.spec)
    // Registration is announced only once the record is readable.
    expect(seen).toEqual(['alice'])
    expect(ctx.tasks.list(owner)).toHaveLength(1)

    expect(ctx.tasks.kill(id, owner)).toBe('requested')
    expect(seen).toEqual(['alice', 'alice'])
    expect(ctx.tasks.get(id, owner).status).toBe('stopping')

    p.settle({ status: 'killed' })
    await tick()
    expect(seen).toEqual(['alice', 'alice', 'alice'])
    expect(ctx.tasks.get(id, owner).status).toBe('killed')
    await disposeAgentScope(owner)
  })

  it('reports an unowned change as undefined, since every caller can see it', async () => {
    const ctx = await harness()
    const seen: (string | undefined)[] = []
    ctx.tasks.onTasksChanged(changed => void seen.push(changed?.id))

    ctx.tasks.start(producer().spec)
    expect(seen).toEqual([undefined])
  })

  it('announces the owner-disposal removal, and stays silent when that owner had none', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'alice')
    const bystander = stubAgent(ctx, 'bob')
    ctx.agents.register(owner)
    ctx.agents.register(bystander)
    const p = producer({ owner })
    ctx.tasks.start(p.spec)

    const seen: (string | undefined)[] = []
    ctx.tasks.onTasksChanged(changed => void seen.push(changed?.id))
    p.settle({ status: 'completed' })
    await tick()
    expect(seen).toEqual(['alice'])

    // Disposing an owner with no records changes no visible set.
    await disposeAgentScope(bystander)
    expect(seen).toEqual(['alice'])

    await disposeAgentScope(owner)
    expect(seen).toEqual(['alice', 'alice'])
    expect(ctx.tasks.list(owner)).toEqual([])
  })

  it('contains a throwing listener so the lifecycle commit still stands', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: (string | undefined)[] = []
    ctx.tasks.onTasksChanged(() => { throw new Error('observer boom') })
    ctx.tasks.onTasksChanged(changed => void seen.push(changed?.id))

    const id = ctx.tasks.start(producer().spec)
    expect(id).toBe('bash-1')
    expect(seen).toEqual([undefined])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onTasksChanged listener threw'))
  })

  it('unregisters through its disposer and with its fiber (HMR safety)', async () => {
    const ctx = await harness()
    const seen: number[] = []
    const detach = ctx.tasks.onTasksChanged(() => void seen.push(1))
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.tasks.onTasksChanged(() => void seen.push(2))
    }, { inject: ['tasks'] }))

    ctx.tasks.start(producer().spec)
    expect(seen).toEqual([1, 2])

    detach()
    detach() // second call of the same disposer is a no-op
    ctx.tasks.start(producer().spec)
    expect(seen).toEqual([1, 2, 2])

    await fiber.dispose()
    ctx.tasks.start(producer().spec)
    expect(seen).toEqual([1, 2, 2])
  })
})

describe('LocalTaskService teardown change notifications', () => {
  it('announces the stopping transition during owner teardown, before settlement', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'alice')
    ctx.agents.register(owner)
    const p = producer({ owner })
    const id = ctx.tasks.start(p.spec)

    const statuses: (string | undefined)[] = []
    ctx.tasks.onTasksChanged((changed) => {
      statuses.push(changed === undefined ? undefined : ctx.tasks.list(changed)[0]?.status)
    })

    // A slow producer keeps teardown parked between cancel and settlement;
    // an observer must not be left showing `running` for that whole window.
    const disposal = disposeAgentScope(owner)
    await tick()
    expect(statuses).toEqual(['stopping'])

    p.settle({ status: 'killed' })
    await disposal
    // Settlement, then the removal that empties the visible set.
    expect(statuses).toEqual(['stopping', 'killed', undefined])
    expect(ctx.tasks.list(owner)).toEqual([])
    void id
  })

  it('announces the emptied set to a listener registered outside this service (reload safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalTaskService)
    ctx.tasks.attachController('test-controller')

    // The api-proxy carrier registers from its own stream context, not the
    // registry's fiber, so it is still listening when the registry unloads.
    const seen: (string | undefined)[] = []
    ctx.tasks.onTasksChanged(changed => void seen.push(changed?.id))
    let settle!: (outcome: TaskOutcome) => void
    ctx.tasks.start({
      kind: 'bash',
      label: 'sleep 600',
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<TaskOutcome>((resolve) => { settle = resolve }),
      }),
    })
    seen.length = 0

    await fiber.dispose()
    // stopping (teardown cancel), settlement, then the final empty set.
    expect(seen).toEqual([undefined, undefined, undefined])
  })
})
