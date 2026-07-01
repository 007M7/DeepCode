import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
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
import * as HooksCodex from '@deepseek-ai/dsh-hooks-codex'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-hx-cov-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
function hooks(d: string, h: unknown): string {
  writeFileSync(join(d, 'hooks.json'), JSON.stringify({ hooks: h })); return join(d, 'hooks.json')
}

async function harness(configPath: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksCodex, { configPath, model: 'm' })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}
function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', (s, st) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}
function events(agent: ReactLoopAgent): SessionEvent[] { return [...agent.session.events] }

describe('hooks-codex coverage — decision mapping paths', () => {
  it('UserPromptSubmit block (exit 2) → rejected turn; default reason on empty stderr', async () => {
    const d = dir()
    hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'b.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
    const adapter = new MockAdapter([textResponse('no')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(0)
    const te = events(agent).findLast(e => e.type === 'turn/end')
    expect(te?.type === 'turn/end' && te.data.reason.kind).toBe('rejected')
  })

  it('UserPromptSubmit additionalContext is injected; a no-op hook proceeds', async () => {
    const d = dir()
    hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'c.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx-x"}}\'\n') }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('ctx-x')
  })

  it('SessionStart additionalContext is injected for the first request', async () => {
    const d = dir()
    hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"start-ctx"}}\'\n') }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    await new Promise(r => setTimeout(r, 60))
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('start-ctx')
  })

  it('PostToolUse block (exit 2) → isError feedback; default reason', async () => {
    const d = dir()
    hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'p.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'ls' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    const r = events(agent).find(e => e.type === 'tool/result')
    expect(r?.type === 'tool/result' && r.data.isError).toBe(true)
    expect(r?.type === 'tool/result' && r.data.content.some(b => b.type === 'text' && b.text.includes('blocked by PostToolUse hook'))).toBe(true)
  })

  it('PostToolUse additionalContext (clean exit) is attached after the result', async () => {
    const d = dir()
    hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'pc.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"post-ctx"}}\'\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'ls' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(events(agent).some(e => e.type === 'context/message' && e.data.content.some(b => b.type === 'text' && b.text.includes('post-ctx')))).toBe(true)
  })

  it('PreToolUse for a tool call WITHOUT a command arg passes an empty command (commandOf non-object/missing arm)', async () => {
    const d = dir()
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'pre.sh', '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', {}), textResponse('done')]) // no command arg
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(ran).toBe(true) // clean-exit hook allows; commandOf returned ''
  })

  it('a clean exit-0 hook records exitCode 0 and omits stderrSummary', async () => {
    const d = dir()
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'n.sh', '#!/usr/bin/env bash\nexit 0\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && res.data.exitCode).toBe(0)
    expect(res?.type === 'hook/result' && 'stderrSummary' in res.data).toBe(false)
  })

  it('a long stderr is truncated in the hook/result summary', async () => {
    const d = dir()
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'l.sh', '#!/usr/bin/env bash\nprintf "x%.0s" {1..600} >&2\nexit 2\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && res.data.stderrSummary?.endsWith('…')).toBe(true)
  })

  it('warns on a skipped async hook and a direct apply() defaults the timeout', async () => {
    const d = dir()
    const marker = join(d, 'ran')
    hooks(d, { UserPromptSubmit: [{ hooks: [
      { type: 'command', command: 'bg.sh', async: true }, // skipped → warn
      { type: 'command', command: sh(d, 'h.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`) },
    ] }] })
    const warn = vi.fn()
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = new Context()
    await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    ctx.logger.warn = warn as never
    // Direct apply (schema bypass) → defaultTimeoutMs ?? 600_000 + model ?? '' fallbacks.
    HooksCodex.apply(ctx, { configPath: join(d, 'hooks.json') })
    await new Promise(r => setTimeout(r, 10))
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(existsSync(marker)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('async hook'))
  })

  it('a no-op clean hook proceeds (contextFrom empty → next)', async () => {
    const d = dir()
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'n.sh', '#!/usr/bin/env bash\nexit 0\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(ran).toBe(true)
  })

  it('SessionStart with no additionalContext is a no-op (contextFrom empty)', async () => {
    const d = dir()
    hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', '#!/usr/bin/env bash\nexit 0\n') }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    await new Promise(r => setTimeout(r, 60))
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(events(agent).some(e => e.type === 'context/message')).toBe(false)
  })

  it('a throwing SessionStart inject is contained (logged)', async () => {
    const d = dir()
    hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"x"}}\'\n') }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    const warn = vi.fn(); ctx.logger.warn = warn as never
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.inject = (() => { throw new Error('inject boom') })
    await new Promise(r => setTimeout(r, 60))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SessionStart hook failed'))
  })

  it('a clean PreToolUse with no decision allows the tool (no deny)', async () => {
    const d = dir()
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'ok.sh', '#!/usr/bin/env bash\nexit 0\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(ran).toBe(true)
  })

  it('a non-matching regex matcher skips the hook (matchesMatcher false → continue)', async () => {
    const d = dir()
    // /^Edit$/ does not match the tool name "Bash" → the group is skipped.
    hooks(d, { PreToolUse: [{ matcher: '^Edit$', hooks: [{ type: 'command', command: sh(d, 'deny.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(ran).toBe(true) // matcher didn't match → no hook ran → tool proceeded
    expect(events(agent).some(e => e.type === 'hook/invoked')).toBe(false)
  })

  it('a {"continue":false} hook is RECORDED as "stop" but does not halt the run (TODO(hook-continue-false))', async () => {
    // Honoring `continue:false` is deferred — the seams have no hard-halt
    // primitive. Assert the LOG records the halt request AND that the run is not
    // actually halted (the tool still runs, the turn completes).
    const d = dir()
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', '#!/usr/bin/env bash\necho \'{"continue":false,"stopReason":"halt"}\'\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && res.data.decision).toBe('stop') // recorded
    expect(ran).toBe(true) // NOT honored: the tool still ran (halt is deferred)
  })

  it('PreToolUse deny with EMPTY stderr uses the default reason (?? right arm)', async () => {
    const d = dir()
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'd.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    const r = events(agent).find(e => e.type === 'tool/result')
    expect(r?.type === 'tool/result' && r.data.content.some(b => b.type === 'text' && b.text.includes('blocked by PreToolUse hook'))).toBe(true)
  })

  it('PostToolUse block AND additionalContext are surfaced together', async () => {
    const d = dir()
    hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'bc.sh', '#!/usr/bin/env bash\necho \'{"decision":"block","reason":"bad","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"ctx too"}}\'\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    const r = events(agent).find(e => e.type === 'tool/result')
    expect(r?.type === 'tool/result' && r.data.isError).toBe(true)
    expect(r?.type === 'tool/result' && r.data.content.some(b => b.type === 'text' && b.text.includes('bad'))).toBe(true)
    expect(events(agent).some(e => e.type === 'context/message' && e.data.content.some(b => b.type === 'text' && b.text.includes('ctx too')))).toBe(true)
  })

  it('commandOf reads a non-string command arg as an empty command', async () => {
    const d = dir()
    // The tool-call arguments carry `command` as a NUMBER → commandOf's
    // `typeof command === 'string'` false arm → '' (the payload's tool_input.command).
    const cap = join(d, 'payload')
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'cap.sh', `#!/usr/bin/env bash\ncat > "${cap}"\nexit 0\n`) }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 7 }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'number' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    const payload = JSON.parse(readFileSync(cap, 'utf8')) as { tool_input: { command: string } }
    expect(payload.tool_input.command).toBe('')
  })

  it('a no-agent direct PreToolUse run uses process.cwd() and turn 0 (no session to record)', async () => {
    const d = dir()
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'd.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
    const ctx = await harness(join(d, 'hooks.json'), new MockAdapter([]))
    let ran = false
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'x' }] } }))
    const { CallId } = await import('@deepseek-ai/dsh-llm')
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'Bash', arguments: { command: 'x' } })
    expect(ran).toBe(false) // denied
    expect(result.isError).toBe(true)
  })

  it('a no-agent direct PostToolUse run attaches context with no session to record', async () => {
    const d = dir()
    hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'pc.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"x"}}\'\n') }] }] })
    const ctx = await harness(join(d, 'hooks.json'), new MockAdapter([]))
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const { CallId } = await import('@deepseek-ai/dsh-llm')
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'Bash', arguments: { command: 'x' } })
    expect(result.isError).toBeFalsy()
    expect(result.additionalContext?.content.some(b => b.type === 'text' && b.text === 'x')).toBe(true)
  })

  it('when the bash executor REJECTS, the hook/result omits exitCode (non-blocking)', async () => {
    const d = dir()
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'h.sh', '#!/usr/bin/env bash\nexit 0\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    ctx.bash.run = (() => Promise.reject(new Error('executor down')))
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    const res = events(agent).find(e => e.type === 'hook/result')
    expect(res?.type === 'hook/result' && 'exitCode' in res.data).toBe(false)
  })

  it('a blocking Stop hook with EMPTY stderr still forces continuation (no reason required)', async () => {
    // Regression: an exit-2 Stop hook with no stderr yields decision 'deny' +
    // reason undefined; the turn must STILL force-continue, not silently stop.
    const d = dir()
    const marker = join(d, 'fired')
    hooks(d, { Stop: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', `#!/usr/bin/env bash\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\nexit 2\n`) }] }] })
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2) // empty-reason block forced continuation
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('blocked by Stop hook')
  })

  it('a clean UserPromptSubmit hook that prints PLAIN stdout injects it as context', async () => {
    // Codex feeds a SessionStart/UserPromptSubmit hook's PLAIN (non-JSON) stdout
    // as additionalContext (unlike CC, which needs a JSON hookSpecificOutput).
    const d = dir()
    hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho "extra guidance from a plain hook"\nexit 0\n') }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('extra guidance from a plain hook')
  })

  it('a clean SessionStart hook that prints PLAIN stdout injects it (not JSON)', async () => {
    const d = dir()
    hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: sh(d, 'ss.sh', '#!/usr/bin/env bash\necho "session preamble"\nexit 0\n') }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    await new Promise(r => setTimeout(r, 60))
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('session preamble')
  })

  it('a clean hook that prints JSON is NOT injected as prose (plain-stdout gate)', async () => {
    // A structured (JSON) stdout must go through the hookSpecificOutput path, not
    // be dumped verbatim as context — the `!startsWith('{')` gate guards this.
    const d = dir()
    hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'j.sh', '#!/usr/bin/env bash\necho \'{"unrelated":"json"}\'\nexit 0\n') }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('unrelated')
  })

  it('the PreToolUse payload carries the REAL tool name (matches the matcher subject)', async () => {
    // Regression: the payload once hardcoded tool_name "Bash", disagreeing with
    // the exec.name matcher subject — a config matcher on the real name would
    // then never fire. Capture the payload and assert tool_name === the real name.
    const d = dir()
    const cap = join(d, 'payload')
    hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'cap.sh', `#!/usr/bin/env bash\ncat > "${cap}"\nexit 0\n`) }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'shell', { command: 'ls' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    ctx.tools.register(defineTool({ name: 'shell', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    const payload = JSON.parse(readFileSync(cap, 'utf8')) as { tool_name: string; tool_input: { command: string } }
    expect(payload.tool_name).toBe('shell')
    expect(payload.tool_input.command).toBe('ls')
  })

  it('a Codex matcher on the REAL tool name fires (matcher subject === payload tool_name)', async () => {
    // A regex matcher matching the real tool name must select the hook — proving
    // the matcher subject and the payload tool_name agree.
    const d = dir()
    hooks(d, { PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: sh(d, 'd.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'shell', { command: 'ls' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'shell', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }]); await waitForIdle(ctx, agent)
    expect(ran).toBe(false) // the matcher fired → the hook denied the tool
    expect(events(agent).some(e => e.type === 'hook/invoked' && e.data.point === 'PreToolUse')).toBe(true)
  })
})
