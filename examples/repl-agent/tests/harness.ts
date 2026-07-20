import { Context } from 'cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'
import type { TokenMeterConfig } from '@deepseek-ai/dsh-token-meter'
import ToolResultPruneService from '@deepseek-ai/dsh-compact-tool-result-prune'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { BasicCompactService } from '@deepseek-ai/dsh-compact-basic'
import type { BasicCompactConfig } from '@deepseek-ai/dsh-compact-basic'

/**
 * Shared harness for the repl-agent e2e suites: the full plugin stack
 * with the real DeepSeek adapter and the real bash + todo_write tools. Lives
 * outside the *.e2e.ts pattern so importing it never re-registers another
 * file's tests.
 */

export const SYSTEM_PROMPT = 'You are a coding agent. Use bash for file operations '
  + 'with cat/grep/heredocs; check [exit code: N] markers, '
  + 'and report results briefly.'

/** System prompt for the todo_write e2e: nudges the model to plan with the tool. */
export const TODO_SYSTEM_PROMPT = 'You are a coding agent. For multi-step work, '
  + 'use the todo_write tool to track a task list: send the WHOLE list each call, '
  + 'keep at most one task in_progress (exactly one while work remains), and mark '
  + 'a task completed as soon as it is done.'

/** Options for {@link codingHarness}. */
export interface CodingHarnessOptions {
  /**
   * Deployment persona for the tree (the system-prompt plugin's `persona`
   * config — per-context, not per-agent). Omitted ⇒ no persona section.
   */
  persona?: string
  /** Durable JSONL persistence root (the resume suite needs it; others stay file-free). */
  persistenceRoot?: string
  /**
   * Load {@link BasicCompactService} with this config so the compaction e2e can
   * trigger compaction at a small, controlled history size. Omitted ⇒ no
   * compaction plugin (the default suites run without it).
   */
  compact?: BasicCompactConfig
  /** Optional token-meter capacity loaded before compact-basic. */
  tokenMeter?: TokenMeterConfig
}

export async function codingHarness(workdir: string, options: CodingHarnessOptions = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: options.persona ?? '' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek)
  await ctx.plugin(LocalBashExecutor, { cwd: workdir, timeoutMs: 30_000 })
  await ctx.plugin(ToolBash)
  await ctx.plugin(ToolTodo)
  // Compaction is opt-in: only the compaction e2e loads the reusable meter and
  // backend, with a lower context window so a short real session crosses the threshold.
  if (options.compact !== undefined) {
    await ctx.plugin(TokenMeterService, options.tokenMeter)
    await ctx.plugin(ToolResultPruneService)
    await ctx.plugin(BasicCompactService, options.compact)
  }
  // Durable JSONL persistence is opt-in: only the resume e2e needs it, and the
  // other suites stay file-free. Loaded last so a resume's deferred
  // `ctx.inject(['sessionPersistence'])` resolves once this is present.
  if (options.persistenceRoot !== undefined) await ctx.plugin(SessionPersistenceJsonl, { root: options.persistenceRoot })
  return ctx
}

export function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
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
