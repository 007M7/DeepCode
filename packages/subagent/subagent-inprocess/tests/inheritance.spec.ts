/**
 * Policy inheritance from parent to in-process child agents, proven against
 * the REAL enforcement wall: a real loop drives a scripted mock MODEL whose
 * children hit the real `dsh-fs-sandbox` fence through the real `write` tool,
 * and every claim is asserted on physical facts — does the file exist on
 * disk, what denial text landed in the child's tool result. Nothing here asks
 * the policy service what it WOULD do; the child either writes or is denied.
 *
 * Red/green anchor for the delegation-bypass gap: a parent switched to
 * `read-only` must not mint children that run under the (wider) deployment
 * default. The stamping design is itself pinned by the mounted session
 * invariants: an implementation that appends the inherited override OUTSIDE
 * the child's first turn fails these suites through the turn-enclosure check.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const READ_ONLY_DENIAL = '[sandbox: file access denied under read-only mode]'

let workspace: string

beforeEach(async () => {
  // realpath: macOS tmpdir is symlinked (/var → /private/var); resolve once so
  // path assertions and the fence's canonicalization agree on one spelling.
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-inherit-')))
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantService)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

/**
 * The walled composition: real loop + real sandbox-policy home + the real
 * confining filesystem backend + the real `write` tool + the approval seam
 * (mounted with NO answerer — the in-process child reality). The deployment
 * default is deliberately WIDER (`workspace-write`) than the parent's staged
 * `read-only` override, so a child that fails to inherit visibly escapes.
 *
 * The script array is taken by reference and filled by each test AFTER the
 * parent exists, so scripted side-effect entries can close over it.
 */
async function setupWalled(script: Script) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  return { ctx, parent }
}

/** Bare composition: no sandbox, no fs, no approval — delegation must not care. */
async function setupBare(script: Script) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

/**
 * Register the delegation scratch tool: delegating from INSIDE an open parent
 * turn is exactly the real tool-subagent shape, and it is what makes the
 * "user switched while idle, model delegates in the very next turn" fork
 * timing constructible (the post-seed switch lives in the still-open turn).
 * `fork: true` seeds the child with the caller's completed-turn prefix,
 * mirroring the fork provider's slice. `raceSwitch` flips the CALLER's mode
 * synchronously after `startInProcessRun`'s synchronous prologue but before
 * its creation transaction resolves — the delegation-vs-late-switch race.
 */
function registerDelegate(ctx: Context, captured: Agent[], raceSwitch?: 'danger-full-access'): void {
  ctx.tools.register(defineTool({
    name: 'delegate',
    description: 'delegate a task to an in-process child (test scaffold)',
    parameters: { fork: { type: 'boolean', description: 'seed the child with the completed-turn prefix' } },
    async execute(args, exec): Promise<ContentBlock[]> {
      const caller = exec.agent
      if (caller === undefined) throw new Error('delegate scaffold requires a calling agent')
      const events = caller.session.events
      const lastEnd = events.findLast(e => e.type === 'turn/end')
      const seed = lastEnd === undefined ? [] : events.slice(0, lastEnd.seq + 1)
      const starting = startInProcessRun(
        { prompt: [{ type: 'text', text: 'delegated task' }], parent: caller, signal: exec.signal },
        args.fork === true && seed.length > 0 ? { seed } : {},
      )
      // The caller's turn is still open, so this switch is legal — and it lands
      // while the child's creation transaction is pending, strictly before the
      // child's first prompt-submit could ever run.
      if (raceSwitch !== undefined) setSandboxMode(caller.session, raceSwitch)
      const run = await starting
      captured.push(run.localAgent as Agent)
      const result = await run.result
      await run.dispose()
      return [{ type: 'text', text: `child:${result.stopReason}` }]
    },
  }))
}

/** All tool/result texts in a session log, in order. */
function toolResultTexts(agent: Agent): string[] {
  return agent.session.events
    .filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    .map(e => e.data.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join(''))
}

/** Count the policy-override events in a session log. */
function overrideEvents(agent: Agent): { sandbox: number; approval: number } {
  const events = agent.session.events
  return {
    sandbox: events.filter(e => e.type === 'sandbox/mode').length,
    approval: events.filter(e => e.type === 'approval/policy').length,
  }
}

function spawnRequest(parent: Agent) {
  return {
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal: new AbortController().signal,
  }
}

describe('sandbox-mode inheritance against the real fs fence', () => {
  it('a SPAWN child of a read-only parent is denied by the real fence (no file on disk)', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    const blocked = join(workspace, 'spawn-blocked.txt')
    script.push(
      // The switch is staged INSIDE a parent turn — the same turn-enclosed
      // anchoring every real switch path (ACP pending switches) uses.
      () => {
        setSandboxMode(parent.session, 'read-only')
        setApprovalPolicy(parent.session, 'never')
        return textResponse('staged')
      },
      toolCallResponse('c-write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('child done'),
    )
    parent.send([{ type: 'text', text: 'stage the session policy' }])
    await parent.whenIdle()
    const parentLogLength = parent.session.events.length

    const run = await startInProcessRun(spawnRequest(parent), {})
    const result = await run.result
    const child = run.localAgent as Agent

    // The physical fact: the write never reached the disk.
    await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // The model-visible fact: the child saw the read-only denial marker.
    expect(toolResultTexts(child).join('\n')).toContain(READ_ONLY_DENIAL)
    expect(result.stopReason).toBe('completed')

    // The stamped override is the child's OWN durable, turn-enclosed record:
    // after turn/start, before the first model request snapshot.
    const events = child.session.events
    const turnStart = events.findIndex(e => e.type === 'turn/start')
    const mode = events.findIndex(e => e.type === 'sandbox/mode')
    const policy = events.findIndex(e => e.type === 'approval/policy')
    const header = events.findIndex(e => e.type === 'request/header')
    expect(mode).toBeGreaterThan(turnStart)
    expect(policy).toBeGreaterThan(turnStart)
    expect(header).toBeGreaterThan(mode)
    // What the enforcing families resolve for the child, end to end.
    expect(ctx.sandboxPolicy.resolve({ session: child.session }).mode).toBe('read-only')
    // Inheritance reads the parent log, never writes it.
    expect(parent.session.events.length).toBe(parentLogLength)

    await run.dispose()
  })

  it('a FORK child inherits the parent switch made AFTER the seed boundary (stale-seed timing)', async () => {
    const script: Script = []
    const captured: Agent[] = []
    const { ctx, parent } = await setupWalled(script)
    registerDelegate(ctx, captured)
    const blocked = join(workspace, 'fork-blocked.txt')
    script.push(
      // Turn 1: the OLD, wider switch — this one lands in the fork seed.
      () => {
        setSandboxMode(parent.session, 'workspace-write')
        return textResponse('turn one')
      },
      // Turn 2: the user tightened to read-only, then the model delegates in
      // the SAME turn — the switch is in the log but past the seed slice.
      () => {
        setSandboxMode(parent.session, 'read-only')
        return toolCallResponse('d-fork', 'delegate', { fork: true })
      },
      toolCallResponse('c-write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('fork child done'),
      textResponse('turn two done'),
    )
    parent.send([{ type: 'text', text: 'turn one' }])
    await parent.whenIdle()
    parent.send([{ type: 'text', text: 'turn two: delegate' }])
    await parent.whenIdle()

    const child = captured[0] as Agent
    // The seed really carried the stale workspace-write switch…
    expect(child.session.events.some(e => e.type === 'sandbox/mode' && e.data.mode === 'workspace-write')).toBe(true)
    // …and the newest parent state still won, on disk and in resolution.
    await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(toolResultTexts(child).join('\n')).toContain(READ_ONLY_DENIAL)
    expect(ctx.sandboxPolicy.resolve({ session: child.session }).mode).toBe('read-only')
  })

  it('a FORK child whose seed already folds to the parent mode gets NO duplicate stamp (guard)', async () => {
    const script: Script = []
    const captured: Agent[] = []
    const { ctx, parent } = await setupWalled(script)
    registerDelegate(ctx, captured)
    const blocked = join(workspace, 'fork-dedup-blocked.txt')
    script.push(
      () => {
        setSandboxMode(parent.session, 'read-only')
        return textResponse('turn one')
      },
      toolCallResponse('d-fork', 'delegate', { fork: true }),
      toolCallResponse('c-write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('fork child done'),
      textResponse('turn two done'),
    )
    parent.send([{ type: 'text', text: 'turn one' }])
    await parent.whenIdle()
    parent.send([{ type: 'text', text: 'turn two: delegate' }])
    await parent.whenIdle()

    const child = captured[0] as Agent
    // The seed-carried override keeps enforcing…
    await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ctx.sandboxPolicy.resolve({ session: child.session }).mode).toBe('read-only')
    // …and inheritance did not append a redundant copy on top of it.
    expect(overrideEvents(child).sandbox).toBe(1)
  })

  it('inherits the mode AT delegation, not a parent switch racing child creation', async () => {
    const script: Script = []
    const captured: Agent[] = []
    const { ctx, parent } = await setupWalled(script)
    // The delegate scaffold flips the parent to danger-full-access AFTER
    // startInProcessRun's synchronous prologue, while the child's creation
    // transaction is still pending — the value at delegation is read-only.
    registerDelegate(ctx, captured, 'danger-full-access')
    const blocked = join(workspace, 'race-blocked.txt')
    script.push(
      () => {
        setSandboxMode(parent.session, 'read-only')
        return textResponse('staged')
      },
      toolCallResponse('d-race', 'delegate', { fork: false }),
      toolCallResponse('c-write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('race child done'),
      textResponse('turn two done'),
    )
    parent.send([{ type: 'text', text: 'stage' }])
    await parent.whenIdle()
    parent.send([{ type: 'text', text: 'delegate' }])
    await parent.whenIdle()

    const child = captured[0] as Agent
    // The child runs under the snapshot taken at delegation — the racing
    // wider switch belongs to the parent's own future, not to the child.
    await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(toolResultTexts(child).join('\n')).toContain(READ_ONLY_DENIAL)
    expect(ctx.sandboxPolicy.resolve({ session: child.session }).mode).toBe('read-only')
  })

  it('a GRANDCHILD inherits through the chain (child delegates again)', async () => {
    const script: Script = []
    const captured: Agent[] = []
    const { ctx, parent } = await setupWalled(script)
    registerDelegate(ctx, captured)
    const blocked = join(workspace, 'grandchild-blocked.txt')
    script.push(
      () => {
        setSandboxMode(parent.session, 'read-only')
        return textResponse('staged')
      },
      toolCallResponse('d-child', 'delegate', { fork: false }),
      // Child immediately delegates the write to a grandchild.
      toolCallResponse('d-grandchild', 'delegate', { fork: false }),
      toolCallResponse('g-write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('grandchild done'),
      textResponse('child done'),
      textResponse('parent done'),
    )
    parent.send([{ type: 'text', text: 'stage' }])
    await parent.whenIdle()
    parent.send([{ type: 'text', text: 'delegate twice' }])
    await parent.whenIdle()

    expect(captured).toHaveLength(2)
    const grandchild = captured[1] as Agent
    expect(grandchild.session.header.delegationDepth).toBe(2)
    await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(toolResultTexts(grandchild).join('\n')).toContain(READ_ONLY_DENIAL)
    expect(ctx.sandboxPolicy.resolve({ session: grandchild.session }).mode).toBe('read-only')
  })
})

describe('inheritance survives prompt vetoes', () => {
  it('stamps the child even when an earlier-registered prompt-submit listener vetoes without next()', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    // A veto-capable listener registered BEFORE the child exists — the
    // Claude/Codex UserPromptSubmit hook shape: it blocks the child's prompt
    // and never delegates. Inheritance must still run for the first turn.
    ctx.on('agent/prompt-submit', (agent, _content, _source, _signal, next) => {
      if (agent.session.header.parentSession !== undefined) {
        return Promise.resolve({ kind: 'block' as const, reason: 'vetoed by test hook' })
      }
      return next()
    })
    script.push(
      () => {
        setSandboxMode(parent.session, 'read-only')
        return textResponse('staged')
      },
      // No child model entries: the blocked prompt closes a zero-step turn.
    )
    parent.send([{ type: 'text', text: 'stage' }])
    await parent.whenIdle()

    const run = await startInProcessRun(spawnRequest(parent), {})
    await run.result
    const child = run.localAgent as Agent

    // The veto closed the first turn promptless, but the stamp is inside that
    // turn regardless — a later resume must not fall back to the deployment
    // default just because the first prompt was blocked.
    expect(overrideEvents(child)).toEqual({ sandbox: 1, approval: 0 })
    expect(ctx.sandboxPolicy.resolve({ session: child.session }).mode).toBe('read-only')

    await run.dispose()
  })
})

describe('inheritance guards (must hold before AND after the fix)', () => {
  it('a child of an unswitched parent runs under the live deployment default, with ZERO stamped events', async () => {
    const script: Script = []
    const { parent } = await setupWalled(script)
    const allowed = join(workspace, 'default-allowed.txt')
    script.push(
      toolCallResponse('c-write', 'write', { file_path: allowed, content: 'fine' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), {})
    await run.result
    const child = run.localAgent as Agent

    // workspace-write (the deployment default) really allowed the write…
    expect(await readFile(allowed, 'utf8')).toBe('fine')
    // …and nothing froze that default into the child log.
    expect(overrideEvents(child)).toEqual({ sandbox: 0, approval: 0 })

    await run.dispose()
  })

  it('delegation works unchanged when no sandbox/approval services are composed at all', async () => {
    const script: Script = []
    const { parent } = await setupBare(script)
    script.push(textResponse('bare child answer'))

    const run = await startInProcessRun(spawnRequest(parent), {})
    const result = await run.result
    const child = run.localAgent as Agent

    expect(result.stopReason).toBe('completed')
    expect(overrideEvents(child)).toEqual({ sandbox: 0, approval: 0 })

    await run.dispose()
  })
})

describe('what a blocked child experiences', () => {
  it('an inherited "never" policy is stated in the child FIRST request system prompt', async () => {
    const script: Script = []
    const { parent } = await setupWalled(script)
    script.push(
      () => {
        setApprovalPolicy(parent.session, 'never')
        return textResponse('staged')
      },
      textResponse('child done'),
    )
    parent.send([{ type: 'text', text: 'stage' }])
    await parent.whenIdle()

    const run = await startInProcessRun(spawnRequest(parent), {})
    await run.result
    const child = run.localAgent as Agent

    // Model-visible ⟺ logged: the child was TOLD up front not to request
    // escalation, in the very first request it ever saw.
    const header = child.session.events.find((e): e is SessionEvent<'request/header'> => e.type === 'request/header')
    expect(header?.data.header.system).toContain('Approval prompts are disabled')

    await run.dispose()
  })

  it('a denied child that retries with sandbox_permissions fails closed on the REAL escalation gate', async () => {
    const script: Script = []
    const { parent } = await setupWalled(script)
    const blocked = join(workspace, 'escalation-blocked.txt')
    script.push(
      () => {
        setSandboxMode(parent.session, 'read-only')
        return textResponse('staged')
      },
      // First attempt: denied by the fence.
      toolCallResponse('c-write', 'write', { file_path: blocked, content: 'escaped' }),
      // One-shot escalation retry, exactly as the denial hint teaches — the
      // approval seam is mounted but NO answerer owns an in-process child.
      toolCallResponse('c-escalate', 'write', {
        file_path: blocked,
        content: 'escaped',
        sandbox_permissions: 'workspace-write',
        justification: 'the test child wants to write inside the workspace',
      }),
      textResponse('child gave up'),
    )
    parent.send([{ type: 'text', text: 'stage' }])
    await parent.whenIdle()

    const run = await startInProcessRun(spawnRequest(parent), {})
    const result = await run.result
    const child = run.localAgent as Agent

    // Nothing ever reached the disk — not the first attempt, not the retry.
    await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const results = toolResultTexts(child)
    expect(results[0]).toContain(READ_ONLY_DENIAL)
    // The child's escalation resolves through the real approval waterfall to
    // the distinct fail-closed reason — the honest "report upward" signal.
    expect(results[1]).toContain('no approval channel is available')
    expect(result.stopReason).toBe('completed')

    await run.dispose()
  })
})
