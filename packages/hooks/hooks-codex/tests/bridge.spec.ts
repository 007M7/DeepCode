import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { type ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as HooksCodex from '@deepseek-ai/dsh-hooks-codex'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop Codex-bridge tests: scripted mock MODEL + REAL loop + REAL bash +
 * REAL `dsh-hooks-codex` running REAL shell scripts from a temp `hooks.json`.
 * Codex dialect specifics exercised here: regex matcher (substring), block-only
 * decisions, the five-event subset.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-codex-'))
  dirs.push(dir)
  return dir
}
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}
function writeHooks(dir: string, hooks: unknown): void {
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }))
}

async function harness(dir: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'test-model' })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}
function events(agent: ReactLoopAgent): SessionEvent[] { return [...agent.session.events] }

/** Poll `predicate` until true or the deadline passes (detached hook effects can't be awaited directly). */
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

describe('hooks-codex bridge', () => {
  it('a PreToolUse hook (exit 2) denies a tool the regex matcher matches as a substring', async () => {
    const dir = configDir()
    const deny = script(dir, 'deny.sh', '#!/usr/bin/env bash\necho "codex blocked it" >&2\nexit 2\n')
    // Codex regex matcher: "Bash" is /Bash/ — matches the tool name "Bash".
    writeHooks(dir, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: deny }] }] })

    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'ls' }), textResponse('done')])
    const ctx = await harness(dir, adapter)
    let ran = false
    ctx.tools.register(defineTool({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'no' }] } }))
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'run ls' }])
    await waitForIdle(ctx, agent)

    expect(ran).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.content.some(b => b.type === 'text' && b.text.includes('codex blocked it'))).toBe(true)
    // recorded under the codex dialect
    expect(events(agent).some(e => e.type === 'hook/invoked' && e.data.dialect === 'codex' && e.data.point === 'PreToolUse')).toBe(true)
  })

  it('a Stop hook (exit 2) forces the turn to continue with the reason as steering', async () => {
    const dir = configDir()
    // Block exactly ONCE (a marker file), then allow — without a one-shot guard a
    // hook that always exits 2 would force-continue forever (the deferred
    // stop_hook_active loop-guard is the real fix; here we self-limit so the test
    // exercises the continue path without looping).
    const marker = join(dir, 'fired')
    const cont = script(dir, 'cont.sh', `#!/usr/bin/env bash\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\necho "keep going: address the goal" >&2\nexit 2\n`)
    writeHooks(dir, { Stop: [{ hooks: [{ type: 'command', command: cont }] }] })

    // Step 1 has no tool calls → would stop; the Stop hook forces step 2.
    const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer after goal')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)

    // The Stop hook's reason became next-step steering → a second model request ran.
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('keep going: address the goal')
  })

  it('only the five bridge-supported Codex events are honored — a SubagentStop entry is ignored', async () => {
    const dir = configDir()
    const s = script(dir, 'x.sh', '#!/usr/bin/env bash\nexit 2\n')
    // SubagentStop is a current Codex event that this bridge drops (no crash, no effect).
    writeHooks(dir, { SubagentStop: [{ hooks: [{ type: 'command', command: s }] }] })

    const adapter = new MockAdapter([textResponse('fine')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    // Ran normally; the unknown event was dropped at parse.
    expect(adapter.requests).toHaveLength(1)
  })

  it('a missing config registers no hooks and does not crash', async () => {
    const dir = configDir() // no hooks.json written
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('disposing the bridge fiber removes its listeners (HMR safety)', async () => {
    const dir = configDir()
    // A BLOCKING UserPromptSubmit hook: if the listener leaked past dispose, it
    // would veto the prompt (0 model requests) and log a hook/invoked. After a
    // clean dispose the turn must proceed untouched — this fails loudly on a leak
    // (a no-op `true` hook would pass even with a leaked listener).
    const deny = script(dir, 'deny.sh', '#!/usr/bin/env bash\nexit 2\n')
    writeHooks(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: deny }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'm' })
    await fiber.dispose()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    agent.send([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1) // not blocked → the listener is gone
    expect(events(agent).some(e => e.type === 'hook/invoked')).toBe(false) // no hook ran
  })

  it('disposing the bridge aborts a still-running SessionStart hook and drains to quiescence', async () => {
    const dir = configDir()
    const pidFile = join(dir, 'pid')
    const marker = join(dir, 'started')
    // Record the hook shell's PID and touch the marker FIRST so the test can
    // tell "the hook is genuinely mid-run", then sleep far past the suite
    // timeout. Dispose must KILL the process (the tracker's abort signal wired
    // through this bridge's runPoint), not await its exit.
    const slow = script(dir, 'slow.sh', `#!/usr/bin/env bash\necho $$ > "${pidFile}"\ntouch "${marker}"\nsleep 30\n`)
    writeHooks(dir, { SessionStart: [{ hooks: [{ type: 'command', command: slow }] }] })
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'm' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    ctx.agentLoop.create(AgentId('a1'), { model: 'mock' }) // fires agent/session-start
    await waitFor(() => existsSync(marker))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await fiber.dispose()
    // Quiescence, not just promptness: the drain resolves only after the run
    // settled, and the run settles only after the killed process was reaped —
    // so by the time dispose returns, the PID must be GONE (kill(pid, 0)
    // throws ESRCH). An untracked fire-and-forget regression would leave the
    // process alive (or unreaped) and fail this deterministically.
    expect(() => process.kill(pid, 0)).toThrow()
    // The aborted run resolves as a non-blocking error (runHook never rejects),
    // so the drained continuation must NOT have logged a failure.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('SessionStart hook failed'))
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in HooksCodex).toBe(false)
    expect(HooksCodex.name).toBe('hooks-codex')
    expect(HooksCodex.inject).toEqual(['bash'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(HooksCodex) as Record<string, unknown>
    expect(unwrapped).toBe(HooksCodex)
    expect(unwrapped.name).toBe('hooks-codex')
    expect(unwrapped.inject).toEqual(['bash'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
