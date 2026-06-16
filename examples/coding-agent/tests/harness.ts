import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop, { LoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

/**
 * Shared harness for the coding-agent e2e suites: the full plugin stack
 * with the real DeepSeek adapter and the real bash tool. Lives outside the
 * *.e2e.ts pattern so importing it never re-registers another file's tests.
 */

export const SYSTEM_PROMPT = 'You are a coding agent. Your only tool is bash; '
  + 'do file operations with cat/grep/heredocs, check [exit code: N] markers, '
  + 'and report results briefly.'

export async function codingHarness(workdir: string, persistenceRoot?: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, { models: ['deepseek-v4-flash'] })
  await ctx.plugin(LocalBashExecutor, { cwd: workdir, timeoutMs: 30_000 })
  await ctx.plugin(ToolBash)
  // Durable JSONL persistence is opt-in: only the resume e2e needs it, and the
  // other suites stay file-free. Loaded last so a resume's deferred
  // `ctx.inject(['sessionPersistence'])` resolves once this is present.
  if (persistenceRoot !== undefined) await ctx.plugin(SessionPersistenceJsonl, { root: persistenceRoot })
  return ctx
}

export function waitForIdle(ctx: Context, agent: LoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

export function finalText(events: SessionEvent[]): string {
  const message = events.findLast(event => event.type === 'assistant/message')
  if (message?.type !== 'assistant/message') return ''
  return message.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}
