/**
 * Request-header reconstruction utilities: the pure fold/diff/apply trio over
 * the `request/header` / `request/header-delta` session events. Anyone
 * holding a session log reconstructs the {@link EpochHeader} any request was
 * built under by folding these events in log order; the loop uses the same
 * functions to decide whether a step's header changed and to encode the
 * change. Deltas are an encoding optimization with a safety valve — the
 * writer round-trip-verifies every delta before appending and falls back to
 * a full snapshot when the encoding cannot express the change — so folding
 * never needs error recovery on a well-formed log.
 *
 * @module dsh-session/request-header
 */

import { callConfigEquals } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, SessionEvent, SystemDelta, ToolsDelta } from './types.ts'

/**
 * Normalize a header to canonical form: an empty system prompt and an empty
 * tool list become ABSENT fields, matching how requests are built (both
 * request-build spreads skip empty values). Diff, fold, and comparison all
 * operate on canonical headers, so "no system prompt" has exactly one
 * representation.
 * @param header - the header to normalize (not mutated).
 * @returns the canonical header.
 */
export function canonicalHeader(header: EpochHeader): EpochHeader {
  return {
    config: header.config,
    ...header.system !== undefined && header.system.length > 0 ? { system: header.system } : {},
    ...header.tools !== undefined && header.tools.length > 0 ? { tools: header.tools } : {},
  }
}

/** Split a canonical (possibly absent) system prompt into lines; absence is zero lines. */
function systemLines(system: string | undefined): string[] {
  return system === undefined ? [] : system.split('\n')
}

/** Join lines back into a canonical system value; zero lines is absence. */
function joinSystem(lines: string[]): string | undefined {
  return lines.length === 0 ? undefined : lines.join('\n')
}

/**
 * Compute the line-level {@link SystemDelta} between two canonical system
 * prompts: trim the common prefix and (non-overlapping) common suffix, and
 * carry the replacement lines between them. Deterministic and library-free;
 * with nothing shared it degenerates to a full replacement.
 */
function diffSystem(prev: string | undefined, next: string | undefined): SystemDelta {
  const a = systemLines(prev)
  const b = systemLines(next)
  let keepStart = 0
  while (keepStart < a.length && keepStart < b.length && a[keepStart] === b[keepStart]) keepStart += 1
  let keepEnd = 0
  while (
    keepEnd < a.length - keepStart &&
    keepEnd < b.length - keepStart &&
    a[a.length - 1 - keepEnd] === b[b.length - 1 - keepEnd]
  ) keepEnd += 1
  return { keepStart, keepEnd, insert: b.slice(keepStart, b.length - keepEnd) }
}

/** Apply a {@link SystemDelta} to a canonical system prompt. */
function applySystem(prev: string | undefined, delta: SystemDelta): string | undefined {
  const a = systemLines(prev)
  return joinSystem([...a.slice(0, delta.keepStart), ...delta.insert, ...a.slice(a.length - delta.keepEnd)])
}

/** Canonical JSON equality for tool schemas — sound because schemas are
 * JSON-serializable by construction and both sides come from the same
 * assembly path, so key insertion order matches when the values do. */
function sameSchema(a: ToolSchema, b: ToolSchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Compute the name-keyed {@link ToolsDelta} between two canonical tool lists.
 * A pure reordering produces an empty delta — the writer's round-trip guard
 * catches that case and records a snapshot instead.
 */
function diffTools(prev: readonly ToolSchema[], next: readonly ToolSchema[]): ToolsDelta {
  const prevByName = new Map(prev.map(tool => [tool.name, tool]))
  const nextNames = new Set(next.map(tool => tool.name))
  return {
    added: next.filter(tool => !prevByName.has(tool.name)),
    removed: prev.filter(tool => !nextNames.has(tool.name)).map(tool => tool.name),
    changed: next.filter((tool) => {
      const before = prevByName.get(tool.name)
      return before !== undefined && !sameSchema(before, tool)
    }),
  }
}

/** Apply a {@link ToolsDelta} to a canonical tool list: drop removed, replace changed in place, append added. */
function applyTools(prev: readonly ToolSchema[], delta: ToolsDelta): ToolSchema[] {
  const removed = new Set(delta.removed)
  const changedByName = new Map(delta.changed.map(tool => [tool.name, tool]))
  const kept = prev
    .filter(tool => !removed.has(tool.name))
    .map(tool => changedByName.get(tool.name) ?? tool)
  return [...kept, ...delta.added]
}

/**
 * Field-wise equality over canonical headers — the cheap comparison the
 * writer's round-trip guard runs (`applyHeaderDelta(prev, delta)` must equal
 * the intended header) and the loop runs to skip logging an unchanged header.
 * Tools compare per-schema IN ORDER (canonical JSON), so a pure reordering is
 * correctly unequal.
 * @param a - one canonical header.
 * @param b - the other.
 * @returns whether config, system, and tools (in order) all match.
 */
export function headerEquals(a: EpochHeader, b: EpochHeader): boolean {
  if (!callConfigEquals(a.config, b.config) || a.system !== b.system) return false
  const at = a.tools ?? []
  const bt = b.tools ?? []
  return at.length === bt.length && at.every((tool, i) => sameSchema(tool, bt[i] as ToolSchema))
}

/**
 * Compute the `request/header-delta` payload between two canonical headers,
 * or undefined when they are equal. The caller MUST round-trip the result
 * ({@link applyHeaderDelta} on `prev` deep-equals `next`) before logging it —
 * the encoding cannot express every change (a pure tool reordering) — and
 * fall back to a full `request/header` snapshot when the check fails.
 * @param prev - the folded header the log currently implies.
 * @param next - the header the next request will actually use.
 * @returns the delta payload, or undefined when nothing changed.
 */
export function diffHeader(
  prev: EpochHeader, next: EpochHeader,
): { system?: SystemDelta; tools?: ToolsDelta; config?: LlmCallConfig } | undefined {
  const delta: { system?: SystemDelta; tools?: ToolsDelta; config?: LlmCallConfig } = {}
  if (prev.system !== next.system) delta.system = diffSystem(prev.system, next.system)
  const prevTools = prev.tools ?? []
  const nextTools = next.tools ?? []
  if (JSON.stringify(prevTools) !== JSON.stringify(nextTools)) delta.tools = diffTools(prevTools, nextTools)
  if (!callConfigEquals(prev.config, next.config)) delta.config = next.config
  return Object.keys(delta).length > 0 ? delta : undefined
}

/**
 * Apply a `request/header-delta` payload to a canonical header, producing the
 * canonical header it encodes. Total for well-formed logs (the writer only
 * appends round-trip-verified deltas).
 * @param prev - the folded header before the delta.
 * @param delta - the logged delta payload.
 * @returns the canonical header after the delta.
 */
export function applyHeaderDelta(
  prev: EpochHeader, delta: { system?: SystemDelta; tools?: ToolsDelta; config?: LlmCallConfig },
): EpochHeader {
  const system = delta.system !== undefined ? applySystem(prev.system, delta.system) : prev.system
  const tools = delta.tools !== undefined ? applyTools(prev.tools ?? [], delta.tools) : prev.tools
  return canonicalHeader({
    config: delta.config ?? prev.config,
    ...system !== undefined ? { system } : {},
    ...tools !== undefined ? { tools } : {},
  })
}

/**
 * Fold the header events of a log (or any prefix of one) into the
 * {@link EpochHeader} in force after the last of them: each
 * `request/header` snapshot replaces the state, each `request/header-delta`
 * amends it. The pure, offline form of reconstruction — external tooling and
 * the dev invariant both use it; the live session tracks the same fold
 * incrementally.
 * @param events - session events in log order (non-header events are skipped).
 * @param from - a previously folded state to continue from (the live session's
 *   incremental cursor); omit to fold from nothing.
 * @returns the folded header, or undefined when no header event exists yet.
 */
export function foldRequestHeader(events: readonly SessionEvent[], from?: EpochHeader): EpochHeader | undefined {
  let state: EpochHeader | undefined = from
  for (const event of events) {
    if (event.type === 'request/header') {
      state = canonicalHeader(event.data.header)
    } else if (event.type === 'request/header-delta') {
      if (state === undefined) {
        throw new Error(`request/header-delta at seq ${event.seq} before any request/header snapshot: corrupt log`)
      }
      state = applyHeaderDelta(state, event.data)
    }
  }
  return state
}
