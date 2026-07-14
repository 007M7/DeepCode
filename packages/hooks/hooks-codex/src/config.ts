/**
 * Parse Codex's five-event hook subset into shared {@link MatcherGroup}s. Only synchronous command
 * hooks run; other types and `async: true` commands are recorded as skipped. Codex performs no
 * command substitution.
 * @module @deepseek-ai/dsh-hooks-codex/config
 */

import type { MatcherGroup } from '@deepseek-ai/dsh-hook-protocol'

/** The five Codex hook points this bridge supports. */
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
 * Parse a wrapped or bare Codex event map. Unknown events and malformed entries are ignored rather
 * than failing boot; unsupported or asynchronous hooks are returned in `skipped`.
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
    // Matcher-group parsing remains dialect-local because the supported hook
    // shapes and skip reasons differ from Claude Code's.
    /* jscpd:ignore-start */
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
        /* jscpd:ignore-end */
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
