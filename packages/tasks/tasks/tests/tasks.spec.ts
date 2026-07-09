import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TaskService, { TaskId } from '@deepseek-ai/dsh-tasks'
import type { TaskHooks, TaskOutcome, TaskSnapshot, TaskStart } from '@deepseek-ai/dsh-tasks'

function stubAgent(rawId: string): Agent {
  const id = AgentId(rawId)
  return {
    id,
    options: {},
    session: new Session(SessionId(`${id}-session`)),
    status: 'idle',
    send() {},
    steer() {},
    inject() {},
    cancel() {},
    whenIdle() { return Promise.resolve() },
  }
}

/** A controllable producer start-spec: settle its `done` on demand, record cancels. */
function producer(overrides: Partial<Omit<TaskStart, 'run'> & TaskHooks> = {}) {
  let settle!: (outcome: TaskOutcome) => void
  let reject!: (error: unknown) => void
  const cancels: (string | undefined)[] = []
  const { kind = 'bash', label = 'sleep 60', owner, ...hookOverrides } = overrides
  const hooks: TaskHooks = {
    cancel(reason) { cancels.push(reason) },
    done: new Promise<TaskOutcome>((res, rej) => { settle = res; reject = rej }),
    ...hookOverrides,
  }
  const spec: TaskStart = { kind, label, ...owner !== undefined ? { owner } : {}, run: () => hooks }
  return { spec, settle, reject, cancels }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TaskService)
  ctx.tasks.attachSurface('test-surface')
  return ctx
}

/** Let the settlement continuation (a `done.then`) run. */
const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('TaskService.start', () => {
  it('refuses to register while no control surface is attached', async () => {
    const ctx = new Context()
    await ctx.plugin(TaskService)
    expect(() => ctx.tasks.start(producer().spec))
      .toThrow('background tasks unavailable: no control surface is attached (load @deepseek-ai/dsh-tool-tasks)')
  })

  it('rejects an empty kind and an empty label', async () => {
    const ctx = await harness()
    expect(() => ctx.tasks.start(producer({ kind: '' }).spec)).toThrow('invalid task kind')
    expect(() => ctx.tasks.start(producer({ label: '' }).spec)).toThrow('invalid task label')
  })

  it('issues kind-prefixed ids from per-kind counters', async () => {
    const ctx = await harness()
    expect(ctx.tasks.start(producer().spec)).toBe('bash-1')
    expect(ctx.tasks.start(producer().spec)).toBe('bash-2')
    expect(ctx.tasks.start(producer({ kind: 'subagent' }).spec)).toBe('subagent-1')
  })
})

describe('TaskService reads and settlement', () => {
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

  it('contains a rejecting done as a failed outcome (producer contract violation)', async () => {
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

describe('TaskService.kill', () => {
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
    // so the notice surface suppresses its redundant "finished".
    expect(seen[0]).toMatchObject({ id, status: 'killed', reported: true })
  })

  it('reports an already-terminal task instead of failing', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.tasks.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(ctx.tasks.kill(id)).toBe('already-terminal')
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
    expect(ctx.tasks.kill(id)).toBe('already-terminal')
  })
})

describe('TaskService.wait', () => {
  it('resolves with the terminal snapshot when the task settles, marked reported', async () => {
    const ctx = await harness()
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.tasks.start(p.spec)

    const wait = ctx.tasks.wait(id, 5_000)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    expect(await wait).toMatchObject({ status: 'completed', reported: true })
    // The pending wait marked the task reported BEFORE listeners ran.
    expect(seen[0]).toMatchObject({ id, reported: true })
  })

  it('returns the live snapshot on timeout without marking reported', async () => {
    const ctx = await harness()
    const id = ctx.tasks.start(producer().spec)
    expect(await ctx.tasks.wait(id, 5)).toMatchObject({ status: 'running', reported: false })
  })

  it('returns immediately for an already-terminal task', async () => {
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

  it('an abort racing settlement in the same tick does not swallow the notice (review finding)', async () => {
    const ctx = await harness()
    const seen: TaskSnapshot[] = []
    ctx.tasks.onTaskDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.tasks.start(p.spec)

    const controller = new AbortController()
    const wait = ctx.tasks.wait(id, 5_000, undefined, controller.signal)
    // Same synchronous tick, settlement QUEUED first: the settle continuation
    // will run before the rejected wait's `finally`, so only the SYNCHRONOUS
    // un-count inside onAbort keeps it from reading a stale waiter count,
    // marking the task reported, and suppressing the completion notice for a
    // wait that then delivers nothing.
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id, status: 'completed', reported: false })
  })

  it('an abort landing AFTER settlement still delivers the terminal snapshot it owes', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    const seen: TaskSnapshot[] = []
    // The listener runs synchronously inside settle — aborting HERE lands the
    // abort after settlement marked this waiter reported (notice suppressed)
    // but before the wait's own resolve microtask. Rejecting now would leave
    // the finished task both unreported and notice-suppressed, so the wait
    // must resolve and deliver instead.
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

describe('TaskService owner isolation', () => {
  it('fences read/kill/wait to the owning session and keeps unowned tasks open', async () => {
    const ctx = await harness()
    const owner = stubAgent('owner')
    ctx.agents.register(owner)
    const other = stubAgent('other')

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
    const alice = stubAgent('alice')
    const bob = stubAgent('bob')
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
    await ctx.plugin(TaskService)
    ctx.tasks.attachSurface('test-surface')
    expect(() => ctx.tasks.start(producer({ owner: stubAgent('a') }).spec))
      .toThrow('background task ownership requires the agent registry')
    // The failed registration mutated nothing: no stored task, counter untouched.
    expect(ctx.tasks.list()).toEqual([])
    expect(ctx.tasks.start(producer().spec)).toBe('bash-1')
  })

  it('a failed owner-cleanup attach leaves the registry unchanged and does not poison the owner', async () => {
    const ctx = await harness()
    const ghost = stubAgent('ghost') // never registered in ctx.agents

    // onCleanup rejects the unregistered agent BEFORE any registry mutation.
    expect(() => ctx.tasks.start(producer({ owner: ghost }).spec))
      .toThrow('is not registered')
    expect(ctx.tasks.list(ghost)).toEqual([])

    // Once the agent actually exists, the same owner gets a WORKING cleanup —
    // the failed attempt must not have marked it as already covered.
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
    await ctx.agents.drainCleanups(ghost.id)
    expect(cancels).toEqual(['owner disposed'])
    expect(ctx.tasks.list(ghost)).toEqual([])
  })
})

describe('TaskService owner cleanup', () => {
  it('drains the owner: cancels live tasks, awaits settlement, drops snapshots', async () => {
    const ctx = await harness()
    const owner = stubAgent('owner')
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

    await ctx.agents.drainCleanups(owner.id)
    expect(cancels).toEqual(['owner disposed'])
    // Snapshots dropped: nothing of the owner's remains, listing is empty.
    expect(ctx.tasks.list(owner)).toEqual([])
  })

  it('attaches one cleanup per owner and re-attaches after a drain', async () => {
    const ctx = await harness()
    const owner = stubAgent('owner')
    ctx.agents.register(owner)

    const first = producer({ owner })
    const second = producer({ owner })
    ctx.tasks.start(first.spec)
    ctx.tasks.start(second.spec)
    first.settle({ status: 'completed' })
    second.settle({ status: 'completed' })
    await tick()
    await ctx.agents.drainCleanups(owner.id)

    // A fresh task after the drain gets a fresh cleanup (the set was consumed).
    const third = producer({ owner })
    ctx.tasks.start(third.spec)
    third.settle({ status: 'completed' })
    await tick()
    expect(ctx.tasks.list(owner)).toHaveLength(1)
    await ctx.agents.drainCleanups(owner.id)
    expect(ctx.tasks.list(owner)).toEqual([])
  })

  it('contains a throwing producer cancel on the cleanup path', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const owner = stubAgent('owner')
    ctx.agents.register(owner)

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

    const drain = ctx.agents.drainCleanups(owner.id)
    settle({ status: 'failed', detail: 'gave up' })
    await drain
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancel boom'))
    expect(ctx.tasks.list(owner)).toEqual([])
  })
})

describe('TaskService disposal', () => {
  it('cancels live tasks, awaits settlement, and silences listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(TaskService)
    const surface = await ctx.plugin(Object.assign((inner: Context) => {
      inner.tasks.attachSurface('test-surface')
    }, { inject: ['tasks'] }))
    void surface

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

  it('detaching the last surface re-arms the register fence', async () => {
    const ctx = new Context()
    await ctx.plugin(TaskService)
    const detachA1 = ctx.tasks.attachSurface('a')
    const detachA2 = ctx.tasks.attachSurface('a') // duplicate name counts independently
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.tasks.attachSurface('b')
    }, { inject: ['tasks'] }))

    detachA1()
    detachA1() // second call of the same disposer is a no-op
    expect(() => ctx.tasks.start(producer().spec)).not.toThrow() // a ×1 + b remain
    detachA2()
    expect(() => ctx.tasks.start(producer().spec)).not.toThrow() // b remains
    await fiber.dispose() // detaches b with its fiber (HMR safety)
    expect(() => ctx.tasks.start(producer().spec)).toThrow('no control surface is attached')
  })
})
