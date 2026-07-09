/**
 * Meta-block extraction: turn a Claude Code-format workflow script —
 * `export const meta = {...}` followed by a plain-JS body — into a validated
 * {@link WorkflowMeta} plus the body with the meta statement blanked
 * line-preservingly (error stacks keep the script's own line numbers).
 *
 * The scanner is a small string/comment-aware brace matcher, not a JS parser:
 * it only has to find the END of the meta object literal, and the literal is
 * contractually PURE (no interpolation, no computed values). Template strings
 * are tolerated as plain quotes but `${` inside one is rejected up front —
 * interpolation is where "literal" stops being checkable by evaluation. The
 * extracted text is then evaluated ALONE in an empty, timed vm context (a
 * non-literal reference throws there; an expression can still RUN, so the
 * result — not the source — is the contract: it must materialize to plain
 * JSON data and pass the shape validation).
 *
 * @module @deepseek-ai/dsh-workflow-workerthread/meta
 */

import * as vm from 'node:vm'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import type { WorkflowMeta, WorkflowPhase } from '@deepseek-ai/dsh-workflow'
import { materializeFromRealm, MaterializeError, renderThrown } from './realm.ts'

/** The result of {@link extractMeta}: the validated meta and the runnable body. */
export interface ExtractedScript {
  meta: WorkflowMeta
  /** The script with the meta statement blanked (newlines preserved). */
  body: string
}

/**
 * Scan `source` from `start` (an opening `{`) to its matching `}`, aware of
 * string literals (`'`/`"`/backtick, with escapes) and comments. Returns the
 * index AFTER the closing brace. Throws `SCRIPT_PARSE` on template
 * interpolation (`${` inside a backtick string) or an unterminated literal.
 */
function scanObjectLiteral(source: string, start: number): number {
  let depth = 0
  let index = start
  while (index < source.length) {
    const ch = source.charAt(index)
    if (ch === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end + 1
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) throw new WorkflowError('meta block has an unterminated comment', 'SCRIPT_PARSE')
      index = end + 2
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      index = scanString(source, index, ch)
      continue
    }
    if (ch === '{' || ch === '[') depth += 1
    if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  throw new WorkflowError('meta block is not a balanced object literal', 'SCRIPT_PARSE')
}

/** Scan past one string literal starting at `start` (the quote char); returns the index after the closing quote. */
function scanString(source: string, start: number, quote: string): number {
  let index = start + 1
  while (index < source.length) {
    const ch = source.charAt(index)
    if (ch === '\\') {
      index += 2
      continue
    }
    if (quote === '`' && ch === '$' && source[index + 1] === '{') {
      throw new WorkflowError('template interpolation (`${...}`) is not allowed in the meta block — meta must be a pure literal', 'SCRIPT_PARSE')
    }
    if (ch === quote) return index + 1
    index += 1
  }
  throw new WorkflowError('meta block has an unterminated string literal', 'SCRIPT_PARSE')
}

/** Replace `[from, to)` of `source` with whitespace, preserving every newline (line numbers survive). */
function blankSpan(source: string, from: number, to: number): string {
  const blanked = source.slice(from, to).replace(/[^\n]/g, ' ')
  return source.slice(0, from) + blanked + source.slice(to)
}

/** Collect shape violations for an evaluated meta value (already materialized to host JSON data). */
function validateMetaShape(meta: unknown): { meta?: WorkflowMeta; violations: string[] } {
  const violations: string[] = []
  /* v8 ignore next 3 -- defensive: the scanner only extracts a brace-delimited literal, which always evaluates to a plain object */
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { violations: ['meta must be an object literal'] }
  }
  const record = meta as Record<string, unknown>
  const known = new Set(['name', 'description', 'whenToUse', 'phases'])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) violations.push(`meta.${key} is not a recognized field (name/description/whenToUse/phases)`)
  }
  if (typeof record.name !== 'string' || record.name.length === 0) violations.push('meta.name must be a non-empty string')
  if (typeof record.description !== 'string' || record.description.length === 0) violations.push('meta.description must be a non-empty string')
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') violations.push('meta.whenToUse must be a string')
  const phases: WorkflowPhase[] = []
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      violations.push('meta.phases must be an array')
    } else {
      record.phases.forEach((phase, index) => {
        if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
          violations.push(`meta.phases[${index}] must be an object`)
          return
        }
        const entry = phase as Record<string, unknown>
        for (const key of Object.keys(entry)) {
          if (!['title', 'detail', 'model'].includes(key)) violations.push(`meta.phases[${index}].${key} is not a recognized field`)
        }
        if (typeof entry.title !== 'string' || entry.title.length === 0) violations.push(`meta.phases[${index}].title must be a non-empty string`)
        if (entry.detail !== undefined && typeof entry.detail !== 'string') violations.push(`meta.phases[${index}].detail must be a string`)
        if (entry.model !== undefined && typeof entry.model !== 'string') violations.push(`meta.phases[${index}].model must be a string`)
        if (violations.length === 0) {
          phases.push({
            title: entry.title as string,
            ...entry.detail !== undefined ? { detail: entry.detail as string } : {},
            ...entry.model !== undefined ? { model: entry.model as string } : {},
          })
        }
      })
    }
  }
  if (violations.length > 0) return { violations }
  return {
    violations,
    meta: {
      name: record.name as string,
      description: record.description as string,
      ...record.whenToUse !== undefined ? { whenToUse: record.whenToUse as string } : {},
      ...record.phases !== undefined ? { phases } : {},
    },
  }
}

/** `export const meta =`, anchored AFTER {@link skipLeadingTrivia} — its quantifiers cannot backtrack ambiguously. */
const META_HEAD = /^export\s+const\s+meta\s*=\s*/

/**
 * Index just past the leading trivia: whitespace and `//` / `/*`-style
 * comments. A hand-rolled character scan, NOT a prefix regex — an
 * all-alternation prefix (`\s*(?:comment|\s+)*`) partitions a whitespace run
 * ambiguously and backtracks EXPONENTIALLY when the match ultimately fails,
 * so a near-miss script (a comment header, then a forgotten `export`) would
 * spin the host synchronously inside `start()`, where no vm timeout applies.
 * The near-miss must fail fast into `SCRIPT_PARSE` instead — that error is
 * the model's retry signal.
 */
function skipLeadingTrivia(source: string): number {
  let index = 0
  while (index < source.length) {
    const ch = source.charAt(index)
    if (/\s/.test(ch)) {
      index += 1
      continue
    }
    if (ch === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      if (end === -1) return source.length
      index = end + 1
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) throw new WorkflowError('script has an unterminated comment before the meta block', 'SCRIPT_PARSE')
      index = end + 2
      continue
    }
    break
  }
  return index
}

/**
 * Extract and validate the leading `export const meta = {...}` statement.
 * Throws {@link WorkflowError} — `SCRIPT_PARSE` when the statement is missing
 * or unscannable, `META_INVALID` when the literal evaluates to something
 * outside the meta contract (non-JSON data, wrong shape, unknown fields).
 * @param script - the full script text.
 * @param evalTimeoutMs - the vm timeout for evaluating the extracted literal.
 * @returns the validated meta and the line-preservingly blanked body.
 */
export function extractMeta(script: string, evalTimeoutMs: number): ExtractedScript {
  const triviaEnd = skipLeadingTrivia(script)
  const match = META_HEAD.exec(script.slice(triviaEnd))
  if (!match) {
    throw new WorkflowError('script must begin with `export const meta = {...}` (leading comments allowed)', 'SCRIPT_PARSE')
  }
  const literalStart = triviaEnd + match[0].length
  if (script[literalStart] !== '{') {
    throw new WorkflowError('`export const meta =` must be followed by an object literal', 'SCRIPT_PARSE')
  }
  const literalEnd = scanObjectLiteral(script, literalStart)
  const literal = script.slice(literalStart, literalEnd)

  let evaluated: unknown
  try {
    // An EMPTY context: any non-literal reference (a variable, a call) throws
    // here. The result — data only — is what the contract checks; a getter or
    // IIFE can still run, which is why the timeout and the materialization
    // below are part of the same boundary.
    evaluated = vm.runInNewContext(`(${literal})`, undefined, { timeout: evalTimeoutMs })
  } catch (error: unknown) {
    throw new WorkflowError(
      `meta block failed to evaluate as a pure literal: ${renderThrown(error)}`,
      'META_INVALID',
      { cause: error },
    )
  }
  let data: unknown
  try {
    data = materializeFromRealm(evaluated, 'meta')
  } catch (error: unknown) {
    /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
    if (!(error instanceof MaterializeError)) throw error
    throw new WorkflowError(`meta block is not pure JSON data — ${error.message}`, 'META_INVALID', { cause: error })
  }
  const { meta, violations } = validateMetaShape(data)
  if (meta === undefined) {
    throw new WorkflowError(`invalid meta block: ${violations.join('; ')}`, 'META_INVALID')
  }

  // Blank the whole statement (including a trailing semicolon, if any) so the
  // body compiles standalone with its original line numbers.
  let statementEnd = literalEnd
  while (statementEnd < script.length && (script[statementEnd] === ' ' || script[statementEnd] === '\t')) statementEnd += 1
  if (script[statementEnd] === ';') statementEnd += 1
  return { meta, body: blankSpan(script, 0, statementEnd) }
}
