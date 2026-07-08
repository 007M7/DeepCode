/**
 * Parse a Codex `hooks.json` into the shared {@link MatcherGroup} shape. Codex's
 * config format is a SUBSET of Claude Code's: the same event-name → matcher-group
 * structure and the same `{ type: 'command', command, timeout?/timeoutSec? }`
 * hook shape, but only five events and NO command-string substitution (Codex sets
 * no hook env vars and does not expand `${…}`). Non-command hooks (and Codex's
 * `async: true` commands) are parsed-and-skipped with a warning.
 *
 * @module @deepseek-ai/dsh-hooks-codex/config
 */

import type { MatcherGroup } from '@deepseek-ai/dsh-hook-protocol'

/** The five hook points Codex's engine supports. */
export const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'] as const

/** A parsed Codex config: event name → its matcher groups (command hooks only). */
export type CodexHookConfig = Record<string, MatcherGroup[]>

/** A skipped non-command (or async) hook, surfaced so the bridge can warn. */
export interface SkippedHook {
  event: string
  reason: string
}

/** The outcome of parsing one Codex config file. */
export interface ParsedCodexConfig {
  config: CodexHookConfig
  skipped: SkippedHook[]
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Parse a raw Codex `hooks.json` object into runnable {@link MatcherGroup}s.
 * Only the five {@link CODEX_EVENTS} are honored; an unknown event is dropped.
 * `type !== 'command'` and `async: true` command hooks are skipped (recorded in
 * `skipped`). Malformed entries are ignored rather than thrown — a bad config
 * must not crash boot. No command substitution (Codex does none).
 * @param raw - the parsed JSON config: a `{ hooks: … }` wrapper or the bare event map.
 * @returns the runnable per-event groups plus the skipped hooks with their reasons.
 */
export function parseCodexConfig(raw: unknown): ParsedCodexConfig {
  const config: CodexHookConfig = {}
  const skipped: SkippedHook[] = []
  const root = asObject(raw)
  const hooksMap = root ? asObject(root.hooks) ?? root : undefined
  if (!hooksMap) return { config, skipped }

  for (const event of CODEX_EVENTS) {
    const rawGroups = hooksMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups: MatcherGroup[] = []
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      const commands: MatcherGroup['hooks'] = []
      for (const rawHook of group.hooks) {
        const hook = asObject(rawHook)
        if (!hook) continue
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        if (type !== 'command') { skipped.push({ event, reason: `unsupported "${type}" hook` }); continue }
        if (hook.async === true) { skipped.push({ event, reason: 'async hook' }); continue }
        if (typeof hook.command !== 'string') continue
        // Codex accepts `timeout` or the `timeoutSec` alias.
        const timeout = typeof hook.timeout === 'number' ? hook.timeout
          : typeof hook.timeoutSec === 'number' ? hook.timeoutSec : undefined
        commands.push({ command: hook.command, ...timeout !== undefined ? { timeoutSec: timeout } : {} })
      }
      if (commands.length === 0) continue
      groups.push({ ...typeof group.matcher === 'string' ? { matcher: group.matcher } : {}, hooks: commands })
    }
    if (groups.length > 0) config[event] = groups
  }

  return { config, skipped }
}
