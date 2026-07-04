/**
 * Parse a Claude Code hook config file into the shared {@link MatcherGroup}
 * shape, faithfully to CC's `hooks.json` / settings `hooks` key format.
 *
 * A CC config maps each event name to an array of matcher groups, each holding
 * an array of typed hooks. Only `type: 'command'` hooks run here; other types
 * (`prompt`/`agent`/`http`) are PARSED but skipped with a warning (faithful-but-
 * degraded — the same stance Codex takes). The `command` string undergoes
 * `${CLAUDE_PLUGIN_ROOT}` substitution at parse time so the runner sees a literal.
 *
 * @module @deepseek-ai/dsh-hooks-claude/config
 */

import type { MatcherGroup } from '@deepseek-ai/dsh-hook-protocol'

/** A parsed CC config: event name → its matcher groups (command hooks only). */
export type ClaudeHookConfig = Record<string, MatcherGroup[]>

/** A skipped non-command hook, surfaced so the bridge can warn about it. */
export interface SkippedHook {
  event: string
  type: string
}

/** The outcome of parsing one config file: the runnable groups + what was skipped. */
export interface ParsedClaudeConfig {
  config: ClaudeHookConfig
  skipped: SkippedHook[]
}

/** Substitution variables applied to each `command` string at parse time. */
export interface SubstitutionVars {
  /** Replaces `${CLAUDE_PLUGIN_ROOT}` — the plugin's root dir. */
  pluginRoot?: string
  /** Replaces `${CLAUDE_PROJECT_DIR}` — the project root. */
  projectDir?: string
}

/** A plain (non-null, non-array) object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Apply `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substitution to a command string. */
export function substituteCommand(command: string, vars: SubstitutionVars): string {
  let out = command
  if (vars.pluginRoot !== undefined) out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot)
  if (vars.projectDir !== undefined) out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir)
  return out
}

/**
 * Parse a raw Claude Code config object (the value under the `hooks` key, or a
 * `hooks.json` whose top level IS that map) into runnable {@link MatcherGroup}s.
 * Non-command hooks and malformed entries are dropped (recorded in `skipped` /
 * silently ignored) rather than throwing — a bad hook config must not crash boot.
 * `vars` are substituted into every surviving `command`.
 */
export function parseClaudeConfig(raw: unknown, vars: SubstitutionVars = {}): ParsedClaudeConfig {
  const config: ClaudeHookConfig = {}
  const skipped: SkippedHook[] = []
  // Accept either `{ hooks: { … } }` (a settings file) or the bare event map.
  const root = asObject(raw)
  const hooksMap = root ? asObject(root.hooks) ?? root : undefined
  if (!hooksMap) return { config, skipped }

  for (const [event, rawGroups] of Object.entries(hooksMap)) {
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
        if (type !== 'command') {
          skipped.push({ event, type })
          continue
        }
        if (typeof hook.command !== 'string') continue
        commands.push({
          command: substituteCommand(hook.command, vars),
          ...typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {},
        })
      }
      if (commands.length === 0) continue
      groups.push({
        ...typeof group.matcher === 'string' ? { matcher: group.matcher } : {},
        hooks: commands,
      })
    }
    if (groups.length > 0) config[event] = groups
  }

  return { config, skipped }
}
