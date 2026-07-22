// Bash toolview sample, written in third-party posture: everything below uses
// only the public registration surface (ctx.toolviews.register + ToolViewProps)
// — the differential-rendering acceptance proof for the registry chain.
// Two registrations: a global bash row, and a scope-filtered variant that
// takes over for matching sessions only (later registration wins its tier).

import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolViewProps } from '../contract/toolview.ts'
import type { ToolViewRegistry } from './registry.ts'
import { toolRowModel, type ToolCallBlock } from '../contract/tool-call-model.ts'
import css from './bash-sample.module.css'

/** Global bash row: command-first monospace summary (replaces the generic row). */
export function BashRow({ toolName, block, actions }: ToolViewProps) {
  const model = toolRowModel(toolName, block as ToolCallBlock)
  return (
    <div className={css.row} data-sample="bash-global" onClick={actions.openDetails}>
      <span className={css.prompt} aria-hidden>$</span>
      <span className={css.command}>{model.summary}</span>
      {model.state === 'error' && <span className={css.err}>failed</span>}
    </div>
  )
}

/** Scoped variant: visually distinct so the differential hit is observable. */
export function ScopedBashRow({ toolName, block, actions }: ToolViewProps) {
  const model = toolRowModel(toolName, block as ToolCallBlock)
  return (
    <div className={css.row} data-sample="bash-scoped" onClick={actions.openDetails}>
      <span className={css.scopeBadge}>scoped</span>
      <span className={css.command}>{model.summary}</span>
    </div>
  )
}

/**
 * Register both sample rows.
 * @param toolviews - the conversation plugin's registry service.
 * @param scope - session filter for the scoped variant.
 * @returns disposer removing both registrations.
 */
export function registerBashSamples(
  toolviews: ToolViewRegistry,
  scope: (sessionId: SessionId) => boolean,
): () => void {
  const offGlobal = toolviews.register('bash', BashRow)
  const offScoped = toolviews.register('bash', ScopedBashRow, { scope })
  return () => {
    offGlobal()
    offScoped()
  }
}
