/**
 * Pure row-model derivation for tool summary rows: variant classification,
 * one-line summary and expanded-body text from the frozen call slice. No
 * inline output ever — full results live in the details panel.
 */
import type { ToolCallBlock } from './toolview.ts'

export type { ToolCallBlock } from './toolview.ts'

/** The frozen slice the chat view hands to toolview components as `block`
 *  (both members are cache-stable references off ConversationSnapshot). */

/** The seven row variants (think is fed by reasoning blocks, not tool calls). */
export type ToolRowVariant = 'think' | 'search' | 'read' | 'bash' | 'write' | 'edit' | 'others'

/** Row state semantic; colors self-supplied via StateDot (design gives none). */
export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

/** Figma row titles per variant (design literals, not translatable copy). */
export const VARIANT_TITLES: Record<ToolRowVariant, string> = {
  think: 'Think', search: 'Search', read: 'Read', bash: 'Bash',
  write: 'Write', edit: 'Edit', others: 'Tool call',
}

/** Known tool name -> variant. */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  bash: 'bash',
  read: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
}

/**
 * Classify a tool name into its row variant.
 * @param toolName - wire tool name.
 * @returns matching variant, others when unknown.
 */
export function classifyTool(toolName: string): ToolRowVariant {
  return TOOL_VARIANTS[toolName] ?? 'others'
}

/** Everything ToolRow needs, derived once from the frozen slice. */
export interface ToolRowModel {
  variant: ToolRowVariant
  title: string
  summary: string
  /** Expanded-body text (pretty args); null = row not expandable. */
  body: string | null
  state: ToolRowState
}

function parseArgs(argsRaw: string): unknown {
  try {
    return JSON.parse(argsRaw)
  } catch {
    // Non-JSON args (mid-stream truncation): summary/body fall back to the raw string.
    return undefined
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/** Summary key preference per variant (args-derived; result-derived summaries are a ledger item). */
const SUMMARY_KEYS: Record<ToolRowVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  think: [],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  others: [],
}

function deriveSummary(variant: ToolRowVariant, argsRaw: string): string {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
  const args = parsed as Record<string, unknown>
  const picked = pickString(args, SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v !== '') return firstLine(v)
  }
  return firstLine(argsRaw)
}

function deriveBody(argsRaw: string): string | null {
  if (argsRaw === '') return null
  const parsed = parseArgs(argsRaw)
  return parsed === undefined ? argsRaw : JSON.stringify(parsed, null, 2)
}

/**
 * Derive the full row model from a frozen call slice.
 * @param toolName - wire tool name (dispatch-supplied; survives windowless results).
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @returns the row model.
 */
export function toolRowModel(toolName: string, block: ToolCallBlock): ToolRowModel {
  const variant = classifyTool(toolName)
  const done = 'kind' in block
  const argsRaw = (done ? block.call?.argsRaw : block.argsRaw) ?? ''
  const state: ToolRowState = !done ? 'running'
    : block.error?.code === 'interrupted' ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const base = argsRaw === '' ? block.callId : deriveSummary(variant, argsRaw)
  // Others keeps the static "Tool call" title (figma literal); the real tool
  // name rides the mutable summary slot so no information is lost.
  const summary = variant === 'others' && toolName !== '' ? `${toolName} · ${base}` : base
  return {
    variant,
    title: VARIANT_TITLES[variant],
    summary,
    body: deriveBody(argsRaw),
    state,
  }
}
