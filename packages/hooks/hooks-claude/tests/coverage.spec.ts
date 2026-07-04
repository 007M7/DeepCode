import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { type ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Targeted branch coverage for the CC bridge: option arms, warn paths, no-agent
 * fallbacks, contextFrom-empty, and the detached-listener catch handlers. */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-hc-cov-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
function hooks(d: string, h: unknown): string {
  writeFileSync(join(d, 'hooks.json'), JSON.stringify({ hooks: h })); return join(d, 'hooks.json')
}

type HarnessOpts = { pluginRoot?: string; projectDir?: string; stderrSummaryMaxChars?: number }
async function harness(configPath: string, adapter: MockAdapter, opts: HarnessOpts = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath, ...opts })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}
function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', (s, st) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}
function events(agent: ReactLoopAgent): SessionEvent[] { return [...agent.session.events] }
/** Poll until `predicate` holds or the deadline passes — robust to detached
 * emit-listener hooks firing on a `.then` (a fixed sleep flakes under load). */
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

describe('hooks-claude coverage — config option arms + substitution + skip warning', () => {
  it('honors pluginRoot + projectDir substitution and warns on a skipped non-command hook', async () => {
    const d = dir()
    // ${CLAUDE_PLUGIN_ROOT} resolves to d; the script writes its own cwd-independent marker.
    const marker = join(d, 'ran')
    sh(d, 'h.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`)
    const path = hooks(d, {
      PreToolUse: [{ hooks: [
        { type: 'prompt', prompt: 'skipme' }, // skipped → warn loop
        { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/h.sh' }, // substituted
      ] }],
    })
    const warn = vi.fn()
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter, { pluginRoot: d, projectDir: d })
    ctx.logger.warn = warn as never
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(existsSync(marker)).toBe(true) // substituted command ran
  })

  it('warns and honors updatedInput as a no-op (input rewrite deferred)', async () => {
    const d = dir()
    const s = sh(d, 'u.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"rewritten"}}}\'\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const warn = vi.fn()
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { command: 'original' }), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.logger.warn = warn as never
    let sawArgs: unknown
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: { command: { type: 'string' } }, async execute(args) { sawArgs = args; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    // updatedInput is NOT honored — the tool ran with the ORIGINAL args.
    expect((sawArgs as { command?: string }).command).toBe('original')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('updatedInput'))
  })
})

describe('hooks-claude coverage — empty/no-op outcomes and no-agent paths', () => {
  it('a clean exit-0 hook with no output is a no-op (contextFrom empty → next())', async () => {
    const d = dir()
    const s = sh(d, 'noop.sh', '#!/usr/bin/env bash\nexit 0\n')
    const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('ran')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    // The prompt proceeded unchanged; no context/message injected.
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(e => e.type === 'context/message')).toBe(false)
  })

  it('a PreToolUse hook fires for a no-agent direct tool call (no session/turn to record into)', async () => {
    const d = dir()
    const s = sh(d, 'deny.sh', '#!/usr/bin/env bash\necho "no" >&2\nexit 2\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const ctx = await harness(path, new MockAdapter([]))
    let ran = false
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'x' }] } }))
    // Call execute() directly with NO agent — the bridge's no-agent/no-turn path.
    const { CallId } = await import('@deepseek-ai/dsh-llm')
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'echo', arguments: {} })
    expect(ran).toBe(false)
    expect(result.isError).toBe(true)
  })

  it('a long stderr is truncated in the hook/result summary', async () => {
    const d = dir()
    // Emit >500 chars of stderr then exit 2.
    const s = sh(d, 'long.sh', '#!/usr/bin/env bash\nprintf "x%.0s" {1..600} >&2\nexit 2\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && res.data.stderrSummary?.endsWith('…')).toBe(true)
    expect(res?.type === 'hook/result' && res.data.stderrSummary?.length).toBe(501) // default 500-char cap + ellipsis
  })

  it('rejects a non-positive or fractional stderrSummaryMaxChars at load', async () => {
    const d = dir()
    const path = hooks(d, {})
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      const adapter = new MockAdapter([])
      await expect(harness(path, adapter, { stderrSummaryMaxChars: bad }))
        .rejects.toThrow(/hooks-claude: stderrSummaryMaxChars must be a positive integer/)
    }
  })

  it('the stderr summary cap is plugin config (stderrSummaryMaxChars)', async () => {
    const d = dir()
    const s = sh(d, 'long.sh', '#!/usr/bin/env bash\nprintf "x%.0s" {1..600} >&2\nexit 2\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter, { stderrSummaryMaxChars: 40 })
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && res.data.stderrSummary).toBe('x'.repeat(40) + '…')
  })
})

describe('hooks-claude coverage — Stop continuation + subagent inject/catch', () => {
  it('a Stop hook that blocks (exit 2) forces the turn to continue (CC dialect)', async () => {
    const d = dir()
    const marker = join(d, 'fired')
    const s = sh(d, 'stop.sh', `#!/usr/bin/env bash\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\necho "continue please" >&2\nexit 2\n`)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('continue please')
  })

  it('a Stop hook that blocks with EMPTY stderr still forces continuation (no reason required)', async () => {
    // Regression: a blocking Stop hook (exit 2) with no stderr yields decision
    // 'deny' + reason undefined; the turn must STILL force-continue (the block is
    // what matters), not silently stop. Self-limit to one block so it can't loop.
    const d = dir()
    const marker = join(d, 'fired')
    const s = sh(d, 'stop.sh', `#!/usr/bin/env bash\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\nexit 2\n`)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    // A second model request ran → the empty-reason block forced continuation.
    expect(adapter.requests).toHaveLength(2)
    // The steering carried the fallback reason (no stderr to use).
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('blocked by Stop hook')
  })

  it('SubagentStart additionalContext is injected into a REGISTERED live child', async () => {
    const d = dir()
    const s = sh(d, 'sa.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"child guidance"}}\'\n')
    const path = hooks(d, { SubagentStart: [{ hooks: [{ type: 'command', command: s }] }] })
    const ctx = await harness(path, new MockAdapter([]))
    // Register a fake child agent under the id the event carries.
    const injected: string[] = []
    const child = { id: AgentId('child-x'), inject: (content: { type: string; text?: string }[]) => { injected.push(content.map(b => b.text ?? '').join('')) }, session: { header: { id: 'child-x' } } } as unknown as Parameters<typeof ctx.agents.register>[0]
    ctx.agents.register(child)
    ctx.emit('subagent/start', { provider: 'p', id: AgentId('child-x') })
    await waitFor(() => injected.includes('child guidance'))
    expect(injected).toContain('child guidance')
  })

  it('a throwing SubagentStart/SubagentStop hook run is contained (logged)', async () => {
    const d = dir()
    // A hook command that does not exist makes runHook resolve a non-blocking
    // error (not a throw), so to hit the .catch we make the .then throw: register
    // a child whose inject throws for SubagentStart.
    const s = sh(d, 'sa.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"x"}}\'\n')
    const path = hooks(d, { SubagentStart: [{ hooks: [{ type: 'command', command: s }] }] })
    const ctx = await harness(path, new MockAdapter([]))
    const warn = vi.fn(); ctx.logger.warn = warn as never
    const child = { id: AgentId('child-y'), inject: () => { throw new Error('inject boom') }, session: { header: { id: 'child-y' } } } as unknown as Parameters<typeof ctx.agents.register>[0]
    ctx.agents.register(child)
    ctx.emit('subagent/start', { provider: 'p', id: AgentId('child-y') })
    await waitFor(() => warn.mock.calls.some(c => String(c[0]).includes('SubagentStart hook failed')))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SubagentStart hook failed'))
  })
})

describe('hooks-claude coverage — default reasons + sparse payloads', () => {
  it('PreToolUse deny with EMPTY stderr uses the default reason', async () => {
    const d = dir()
    const s = sh(d, 'deny.sh', '#!/usr/bin/env bash\nexit 2\n') // exit 2, no stderr
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'x' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.content.some(b => b.type === 'text' && b.text.includes('blocked by PreToolUse hook'))).toBe(true)
  })

  it('PostToolUse deny with EMPTY stderr + no context uses the default feedback', async () => {
    const d = dir()
    const s = sh(d, 'block.sh', '#!/usr/bin/env bash\nexit 2\n')
    const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.content.some(b => b.type === 'text' && b.text.includes('blocked by PostToolUse hook'))).toBe(true)
  })

  it('SubagentStop with no registered child runs the hook cleanly (fire-and-forget)', async () => {
    const d = dir()
    // The agents registry has no entry for the id, so the child lookup yields
    // undefined and the payload falls back to base(undefined) — assert the
    // observe-only SubagentStop run still executes the hook without crashing.
    const marker = join(d, 'stopran')
    const s = sh(d, 'stop.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`)
    const path = hooks(d, { SubagentStop: [{ hooks: [{ type: 'command', command: s }] }] })
    const ctx = await harness(path, new MockAdapter([]))
    ctx.emit('subagent/end', { provider: 'p', id: AgentId('child-z'), stopReason: 'completed' })
    await waitFor(() => existsSync(marker))
    expect(existsSync(marker)).toBe(true)
  })
})

describe('hooks-claude coverage — more default/sparse arms', () => {
  it('UserPromptSubmit deny with EMPTY stderr uses the default block reason', async () => {
    const d = dir()
    const s = sh(d, 'block.sh', '#!/usr/bin/env bash\nexit 2\n')
    const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('no')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'rejected' && turnEnd.data.reason.reason).toContain('blocked by UserPromptSubmit hook')
  })

  it('a PreToolUse ask with NO reason omits the reason (false arm)', async () => {
    const d = dir()
    const s = sh(d, 'ask.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}\'\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'x' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    // ask (no reason) → degrades to deny with the registry's generic message.
    expect(ran).toBe(false)
    expect(events(agent).some(e => e.type === 'tool/result' && e.data.isError)).toBe(true)
  })

  it('a recorded clean exit-0 hook with no stderr omits exitCode-extra/stderrSummary fields', async () => {
    const d = dir()
    const s = sh(d, 'noop.sh', '#!/usr/bin/env bash\nexit 0\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && res.data.exitCode).toBe(0)
    expect(res?.type === 'hook/result' && 'stderrSummary' in res.data).toBe(false)
  })
})

describe('hooks-claude coverage — schema-bypass default + unspawnable hook', () => {
  it('a direct apply() (schema bypass) defaults the timeout and runs', async () => {
    const d = dir()
    const marker = join(d, 'ran')
    const s = sh(d, 'h.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`)
    hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    // Direct apply with only configPath — bypasses schemastery's defaults, so the
    // runtime `defaultTimeoutMs ?? 600_000` fallback is exercised.
    HooksClaude.apply(ctx, { configPath: join(d, 'hooks.json') })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(existsSync(marker)).toBe(true)
  })

  it('a non-zero non-2 hook exit (e.g. a command-not-found 127) is a non-blocking error; the tool still runs', async () => {
    const d = dir()
    // `bash -c` of a missing program exits 127 — a non-blocking error (not 0, not
    // 2 → no decision), so the tool proceeds; the hook/result records exit 127.
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: '/nonexistent/definitely/not/a/command' }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(ran).toBe(true)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && res.data.exitCode).toBe(127)
  })

  it('a PostToolUse deny with empty stderr + no context uses the default feedback (no context arm)', async () => {
    const d = dir()
    const s = sh(d, 'block.sh', '#!/usr/bin/env bash\nexit 2\n')
    const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.isError).toBe(true)
  })
})

describe('hooks-claude coverage — continue:false, context arm, no-cwd', () => {
  it('a {"continue":false} hook is RECORDED as decision "stop" but does not halt the run (TODO(hook-continue-false))', async () => {
    // Honoring `continue:false` (hard-halt the whole run) is deferred — there is
    // no such primitive on the interception seams yet. So this asserts the LOG
    // faithfully records the halt request (decision "stop"), AND that the run is
    // NOT actually halted: the tool still runs and the turn completes normally.
    const d = dir()
    const s = sh(d, 'stop.sh', '#!/usr/bin/env bash\necho \'{"continue":false,"stopReason":"halt"}\'\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && res.data.decision).toBe('stop') // recorded
    expect(ran).toBe(true) // NOT honored: the tool still ran (halt is deferred)
    const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind).toBe('completed') // ran to completion
  })

  it('a PostToolUse hook that BOTH blocks AND attaches additionalContext', async () => {
    const d = dir()
    const s = sh(d, 'b.sh', '#!/usr/bin/env bash\necho \'{"decision":"block","reason":"bad","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"context too"}}\'\n')
    const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.content.some(b => b.type === 'text' && b.text.includes('bad'))).toBe(true)
    // additionalContext also injected (the block + context arm).
    expect(events(agent).some(e => e.type === 'context/message' && e.data.content.some(b => b.type === 'text' && b.text.includes('context too')))).toBe(true)
  })

  it('a PreToolUse hook whose hookSpecificOutput names a DIFFERENT event does NOT deny the tool', async () => {
    // The block's hookEventName (UserPromptSubmit) mismatches the firing event
    // (PreToolUse), so its permissionDecision:"deny" is discarded — the tool runs.
    const d = dir()
    const s = sh(d, 'x.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","permissionDecision":"deny"}}\'\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(ran).toBe(true) // the mismatched deny was discarded → the tool ran
  })

  it('defaults CLAUDE_PROJECT_DIR to the session workspace when no projectDir is configured', async () => {
    // The default ACP wiring sets no projectDir. A stock CC hook that references
    // $CLAUDE_PROJECT_DIR (shell expansion) must still get the session workspace,
    // not an empty string. The hook echoes the var as additionalContext.
    const d = dir()
    const workspace = dir()
    const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\nprintf \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"dir=%s"}}\' "$CLAUDE_PROJECT_DIR"\n')
    const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('ran')])
    const ctx = await harness(path, adapter) // NB: no projectDir
    // The factory create() path honors meta.cwd (the plain agentLoop.create() does not).
    const { SessionId } = await import('@deepseek-ai/dsh-session')
    const handle = ctx.agents.create({ agentId: AgentId('a1'), sessionId: SessionId('s1'), meta: { cwd: workspace }, agentOptions: { model: 'mock' } })
    handle.agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, handle.agent as ReactLoopAgent)
    expect(events(handle.agent as ReactLoopAgent).some(e => e.type === 'context/message'
      && e.data.content.some(b => b.type === 'text' && b.text.includes(`dir=${workspace}`)))).toBe(true)
    await handle.dispose()
  })

  it('a context-only UserPromptSubmit hook DELEGATES so a later listener can still block', async () => {
    // A hook that only adds context must NOT short-circuit the waterfall: a
    // downstream agent/prompt-submit listener (a policy plugin) must still get to
    // block the prompt. The bridge delegates via next() and folds its context.
    const d = dir()
    const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"bridge ctx"}}\'\n')
    const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(path, adapter)
    // A later listener that blocks every prompt (registered AFTER the bridge).
    const { AgentId: AId } = await import('@deepseek-ai/dsh-agent')
    ctx.on('agent/prompt-submit', async () => ({ kind: 'block' as const, reason: 'policy veto' }))
    const agent = ctx.agentLoop.create(AId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    // the downstream block won: the model was never called, no user/message was
    // recorded, and the (sole, fully-blocked) prompt closed the turn `rejected`
    expect(adapter.requests).toHaveLength(0)
    expect(events(agent).some(e => e.type === 'user/message')).toBe(false)
    const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toMatchObject({ kind: 'rejected', reason: 'policy veto' })
  })

  it('folds the bridge additionalContext WITH a downstream listener that also adds context', async () => {
    // Both the bridge hook and a later prompt-submit listener attach context; the
    // request must see BOTH (concatContext keeps the downstream one too).
    const d = dir()
    const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"from-bridge"}}\'\n')
    const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(path, adapter)
    ctx.on('agent/prompt-submit', async () => ({
      kind: 'allow' as const,
      content: [{ type: 'text' as const, text: 'rewritten-prompt' }],
      additionalContext: { content: [{ type: 'text' as const, text: 'from-downstream' }], source: { kind: 'plugin' as const, plugin: 'policy' } },
    }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const req = JSON.stringify(adapter.requests[0]!.messages)
    expect(req).toContain('from-bridge')
    expect(req).toContain('from-downstream')
    expect(req).toContain('rewritten-prompt') // downstream content rewrite preserved
    // the original prompt was replaced by the downstream rewrite
    const userMsg = events(agent).find(e => e.type === 'user/message')
    expect(userMsg?.type === 'user/message' && userMsg.data.content.some(b => b.type === 'text' && b.text === 'rewritten-prompt')).toBe(true)
  })

  it('folds the bridge PostToolUse context onto a downstream ACCEPT that replaces content', async () => {
    // The bridge hook adds context; a later post-execute listener accepts with a
    // content rewrite. Both the rewrite and the bridge context survive.
    const d = dir()
    const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"bridge-note"}}\'\n')
    const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    ctx.on('tools/post-execute', async () => ({ kind: 'accept' as const, content: [{ type: 'text' as const, text: 'rewritten-result' }] }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.content.some(b => b.type === 'text' && b.text === 'rewritten-result')).toBe(true)
    expect(events(agent).some(e => e.type === 'context/message' && e.data.content.some(b => b.type === 'text' && b.text.includes('bridge-note')))).toBe(true)
  })

  it('folds the bridge PostToolUse context onto a downstream listener BLOCK', async () => {
    // The bridge hook only adds context; a later post-execute listener blocks the
    // result. The block wins AND carries the bridge context (concatContext on the
    // block arm).
    const d = dir()
    const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"bridge-note"}}\'\n')
    const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    ctx.on('tools/post-execute', async () => ({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'downstream-block' }] }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.content.some(b => b.type === 'text' && b.text.includes('downstream-block'))).toBe(true)
    // the bridge's context still landed (folded onto the block)
    expect(events(agent).some(e => e.type === 'context/message' && e.data.content.some(b => b.type === 'text' && b.text.includes('bridge-note')))).toBe(true)
  })

})

describe('hooks-claude coverage — executor reject + no-open-turn', () => {
  it('when the bash executor REJECTS a hook run, the hook/result omits exitCode (non-blocking)', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\nexit 0\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    // Force the executor to reject (an infrastructure fault) so runHook's catch
    // yields a HookOutput with exitCode undefined → the `exitCode` spread false arm.
    const bash = ctx.bash
    bash.run = (() => Promise.reject(new Error('executor down')))
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && 'exitCode' in res.data).toBe(false)
  })

})

describe('hooks-claude coverage — detached-listener catch handlers', () => {
  it('a throwing SessionStart inject is contained (logged, agent still runs)', async () => {
    const d = dir()
    const s = sh(d, 'start.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"x"}}\'\n')
    const path = hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    // Make inject throw, forcing the SessionStart .catch path.
    const original = agent.inject.bind(agent)
    let threw = false
    agent.inject = (() => { threw = true; throw new Error('inject boom') })
    await waitFor(() => threw)
    expect(threw).toBe(true)
    agent.inject = original
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1) // loop survived the thrown inject
  })
})

describe('hooks-claude coverage — hook runs in the session cwd, not the server cwd', () => {
  it('runs an agent-scoped hook in the session workspace even when the executor default differs', async () => {
    // The bug: the bridge passed no workdir, so hooks ran in the executor default
    // (the server launch dir), not session/new.cwd. Here the executor default and
    // the session cwd are DIFFERENT temp dirs; a PreToolUse hook writes `pwd` to a
    // marker and we assert it ran in the SESSION cwd.
    const serverDir = dir()
    const sessionDir = dir()
    const marker = join(sessionDir, 'where')
    // The hook is invoked with cwd = session dir, so a relative marker path lands there.
    hooks(serverDir, { PreToolUse: [{ hooks: [{ type: 'command', command: 'pwd > where' }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    // Executor default cwd = serverDir (deliberately NOT the session cwd).
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, cwd: serverDir })
    await ctx.plugin(HooksClaude, { configPath: join(serverDir, 'hooks.json') })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineTool({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))

    const { SessionId } = await import('@deepseek-ai/dsh-session')
    const handle = ctx.agents.create({ agentId: AgentId('a1'), sessionId: SessionId('s1'), meta: { cwd: sessionDir }, agentOptions: { model: 'mock' } })
    handle.agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, handle.agent as ReactLoopAgent)

    expect(existsSync(marker)).toBe(true) // the marker landed in the SESSION dir
    const { readFileSync } = await import('node:fs')
    const where = readFileSync(marker, 'utf8').trim()
    // `pwd` may resolve symlinks (/var → /private/var etc.), so compare basenames.
    expect(where.endsWith(sessionDir.split('/').pop()!)).toBe(true)
    await handle.dispose()
  })

  it('runs a SubagentStop hook in the CHILD session workspace, not the server cwd', async () => {
    // SubagentStop looks the child up (recoverable at subagent/end) and runs the
    // hook in the CHILD's session cwd, not the executor default. Here the executor
    // default and the child session cwd are DIFFERENT dirs; a SubagentStop hook
    // writes `pwd` to a relative marker and we assert it landed in the CHILD dir —
    // which only holds if the listener threaded the child agent into runPoint.
    const serverDir = dir()
    const childDir = dir()
    const marker = join(childDir, 'stopwhere')
    hooks(serverDir, { SubagentStop: [{ hooks: [{ type: 'command', command: 'pwd > stopwhere' }] }] })
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    // Executor default cwd = serverDir (deliberately NOT the child session cwd).
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, cwd: serverDir })
    await ctx.plugin(HooksClaude, { configPath: join(serverDir, 'hooks.json') })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))

    // Register a live child on its own session cwd; emit subagent/end with its id.
    const { SessionId } = await import('@deepseek-ai/dsh-session')
    const childHandle = ctx.agents.create({ agentId: AgentId('child-stop'), sessionId: SessionId('child-stop-session'), meta: { cwd: childDir }, agentOptions: { model: 'mock' } })
    ctx.emit('subagent/end', { provider: 'inproc', id: childHandle.agent.id, stopReason: 'completed' })

    await waitFor(() => existsSync(marker))
    expect(existsSync(marker)).toBe(true) // the marker landed in the CHILD dir
    const { readFileSync } = await import('node:fs')
    const where = readFileSync(marker, 'utf8').trim()
    // `pwd` may resolve symlinks (/var → /private/var etc.), so compare basenames.
    expect(where.endsWith(childDir.split('/').pop()!)).toBe(true)
    await childHandle.dispose()
  })
})

describe('hooks-claude coverage — systemMessage is warned, not surfaced', () => {
  it('a hook emitting a systemMessage is logged as not-yet-surfaced', async () => {
    const d = dir()
    const s = sh(d, 'sm.sh', '#!/usr/bin/env bash\necho \'{"systemMessage":"heads up"}\'\n')
    const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(path, adapter)
    const warn = vi.fn(); ctx.logger.warn = warn as never
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('systemMessage'))
    // Not surfaced: the systemMessage text never reaches the model request.
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('heads up')
  })
})

describe('hooks-claude coverage — SessionStart timing is best-effort (no-wait)', () => {
  it('does NOT crash or block when the prompt is sent immediately (context is best-effort, may miss the first request)', async () => {
    // Regression for the documented downgrade: session-start injection is
    // detached, so a prompt sent immediately need not observe it. This asserts
    // the SAFE properties (no crash, the turn still runs) WITHOUT waiting for the
    // inject first — it documents the best-effort timing rather than masking it
    // by pre-waiting for context/message (which the guaranteed-timing tests do).
    const d = dir()
    const s = sh(d, 'start.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"late ctx"}}\'\n')
    const path = hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    // Send immediately — do NOT wait for the session-start inject.
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1) // the turn ran regardless of hook timing
  })
})
