import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { type ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { WorkerCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker'

/**
 * The Code Mode with-key proof (the RFC's e2e tier): a REAL model under
 * `mode: 'code'`, a task that requires composing two tool calls, verified
 * against the WORLD — the persisted request header carried exactly
 * `[run_code]` as the wire tool list, each sub-call landed as a
 * `tool/code-dispatch` event, the file the program wrote exists on disk, and
 * the final answer is the program's curated output. Key-gated (see
 * vitest.e2e.config.ts); the keyless Loader-path smoke of the overlay lives
 * in `code-mode-keyless-smoke.e2e.ts`.
 */

const PERSONA = 'You are coding-agent. You work by writing TypeScript programs for run_code: '
  + 'batch related tool work into one program and print or return ONLY the findings that matter.'

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  // Always dispose, even on failure/retry/timeout: agent-loop teardown stops
  // the loop, the executor kills stray processes, and the code runtime's
  // dispose awaits worker exits.
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function codeModeHarness(cwd: string): Promise<Context> {
  const harness = new Context()
  await harness.plugin(LlmService)
  await harness.plugin(SessionStore)
  await harness.plugin(SystemPrompt, { persona: PERSONA })
  await harness.plugin(ToolRegistry, { mode: 'code' })
  await harness.plugin(AgentRegistry)
  await harness.plugin(AgentLoop, { agents: [] })
  await harness.plugin(LlmDeepSeek, { models: ['deepseek-v4-flash'] })
  await harness.plugin(LocalBashExecutor, { cwd, timeoutMs: 30_000 })
  await harness.plugin(ToolBash)
  await harness.plugin(WorkerCodeRuntime, {})
  return harness
}

function waitForIdle(harness: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = harness.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('Code Mode: real model writes a program over real tools', () => {
  it('collapses the wire tool list to [run_code], bridges sub-calls, and returns curated output', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-code-mode-e2e-'))
    ctx = await codeModeHarness(workdir)
    const agent = ctx.agentLoop.create(AgentId('e2e-code-mode'), { model: 'deepseek-v4-flash' })

    agent.send([{
      type: 'text',
      text: 'Using one run_code program: run `echo alpha-7` with the bash tool, run `echo beta-9` with the bash tool, '
        + 'then write both outputs joined by a plus sign into combined.txt (bash heredoc or redirect), '
        + 'and return only the joined string.',
    }])
    await waitForIdle(ctx, agent)
    const events: SessionEvent[] = [...agent.session.events]

    // The wire contract: every request this session made offered EXACTLY ONE
    // tool — run_code (the logged header snapshots the assembled list).
    const headers = events.filter(event => event.type === 'request/header')
    expect(headers.length).toBeGreaterThan(0)
    for (const header of headers) {
      expect(header.data.header.tools?.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    }
    // The model actually went through run_code…
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(event => event.data.name === RUN_CODE_NAME)).toBe(true)
    // …and the program's tool calls landed as dispatch events under it.
    const dispatches = events.filter(event => event.type === 'tool/code-dispatch')
    expect(dispatches.length).toBeGreaterThanOrEqual(2)
    expect(dispatches.every(event => event.data.name === 'bash')).toBe(true)
    const parents = new Set(calls.map(event => event.data.callId))
    expect(dispatches.every(event => parents.has(event.data.parentCallId))).toBe(true)

    // World verification: the file the program wrote, and the curated answer.
    const combined = await readFile(join(workdir, 'combined.txt'), 'utf8')
    expect(combined).toContain('alpha-7')
    expect(combined).toContain('beta-9')
    const finalMessage = events.findLast(event => event.type === 'assistant/message')
    const finalText = finalMessage !== undefined
      ? finalMessage.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : ''
    expect(finalText).toContain('alpha-7')
    expect(finalText).toContain('beta-9')
  }, 180_000)
})
