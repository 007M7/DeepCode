/**
 * Shared JSDoc parsing and completeness-check helpers for the documentation
 * gates: the cordis catalog generator (`scripts/gen-cordis-catalog.ts` — the
 * events + `ctx.<key>` service surface), the plugin config catalog generator
 * (`scripts/gen-config-catalog.ts`, which renders the parsed prose), and the
 * export-surface gate (`scripts/verify-export-jsdoc.ts` — every module-level
 * export). One home for the mechanics so "documented" means the same thing on
 * every gated surface: description prose ends at the first block tag; every
 * checkable parameter needs a non-empty `@param`; a non-void ANNOTATED return
 * needs a non-empty `@returns`; a stale `@param` naming no real parameter
 * errors.
 */

import ts from 'typescript'

/** Repo-relative source pointer `file:line` for a node's first character. */
export function pointer(rel: string, sf: ts.SourceFile, node: ts.Node): string {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return `${rel}:${line + 1}`
}

/** The raw `/** … *​/` JSDoc block immediately preceding a node, or '' if none. */
export function rawJsDoc(text: string, node: ts.Node): string {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  const jsdoc = ranges.filter(r => text.slice(r.pos, r.pos + 3) === '/**').at(-1)
  return jsdoc ? text.slice(jsdoc.pos, jsdoc.end) : ''
}

/** A dispatch mode, rendered as the badge after an event name in the catalog. */
export type Mode = 'emit' | 'waterfall' | 'parallel' | 'serial'

/**
 * Parse a raw JSDoc block into description prose + the `@mode` tag (when
 * present). Output obeys the repo's markdown conventions so the generated
 * catalog passes verify-md-wrap: each prose paragraph collapses to ONE physical
 * line, and a `-` bullet list is preserved with each item on its own single
 * line (continuation lines folded in). `{@link Foo}` unwraps to `Foo`.
 * Description prose ends at the FIRST block tag (standard JSDoc semantics):
 * tag lines and their continuation lines are never prose, so `@param` /
 * `@returns` blocks are invisible to the rendered catalog.
 * @param raw - the raw comment text including the JSDoc delimiters.
 * @returns the collapsed description prose plus the parsed `@mode` (or null).
 */
export function parseJsDoc(raw: string): { doc: string; mode: Mode | null } {
  const inner = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(l => l.replace(/^\s*\*?\s?/, '').replace(/\s+$/, ''))
  let mode: Mode | null = null
  let inTags = false
  const blocks: string[] = []
  let para: string[] = []
  let list: string[] = []
  let item: string[] = []
  const join = (parts: string[]): string => parts.join(' ').replace(/\s+/g, ' ').trim()
  const flushItem = (): void => {
    if (item.length) list.push(join(item))
    item = []
  }
  const flushList = (): void => {
    flushItem()
    if (list.length) blocks.push(list.join('\n')) // one block, items on own lines
    list = []
  }
  const flushPara = (): void => {
    flushList()
    if (para.length) blocks.push(join(para))
    para = []
  }
  for (const line of inner) {
    const m = /^@mode\s+(emit|waterfall|parallel|serial)\s*$/.exec(line)
    if (m) { mode = m[1] as Mode; flushPara(); inTags = true; continue }
    if (line.startsWith('@')) { flushPara(); inTags = true; continue }
    if (inTags) continue // block-tag territory: continuations are never prose
    if (line.trim() === '') { flushPara(); continue }
    if (/^-\s+/.test(line)) {
      // A list item starts: a pending paragraph (e.g. an intro line directly
      // above the list, no blank between) flushes FIRST so it renders above.
      flushItem()
      if (para.length) { blocks.push(join(para)); para = [] }
      item.push(line)
      continue
    }
    if (item.length) { item.push(line); continue } // continuation of current item
    para.push(line)
  }
  flushPara()
  const doc = blocks.join('\n\n').replace(/\{@link\s+([^}]+)\}/g, '$1').trim()
  return { doc, mode }
}

/**
 * Parse the block tags of a raw JSDoc comment for the completeness checks:
 * every `@param name — description` entry plus the `@returns` description.
 * Standard JSDoc block-tag semantics — a tag's description runs across
 * continuation lines until the next tag or a blank line, and the `-`/`—`
 * separator after a param name is optional. `[name]` optional-brackets unwrap
 * to `name`. Rendering never sees these: parseJsDoc stops prose at the first
 * block tag.
 * @param raw - the raw comment text including the JSDoc delimiters.
 * @returns the `@param` name→description map plus the `@returns` description
 * (null when the tag is absent, '' when present but empty).
 */
export function parseTags(raw: string): { params: Map<string, string>; returns: string | null } {
  const inner = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(l => l.replace(/^\s*\*?\s?/, '').replace(/\s+$/, ''))
  const params = new Map<string, string>()
  let returns: string | null = null
  let sink: ((text: string) => void) | null = null
  for (const line of inner) {
    const param = /^@param\s+(\[?[\w$]+\]?)\s*(?:[-—–]\s*)?(.*)$/.exec(line)
    if (param) {
      const name = (param[1] ?? '').replace(/^\[|\]$/g, '')
      let acc = param[2] ?? ''
      params.set(name, acc)
      sink = (t) => { acc = acc ? `${acc} ${t}` : t; params.set(name, acc) }
      continue
    }
    const ret = /^@returns?(?:\s+[-—–]?\s*(.*))?$/.exec(line)
    if (ret) {
      let acc = ret[1] ?? ''
      returns = acc
      sink = (t) => { acc = acc ? `${acc} ${t}` : t; returns = acc }
      continue
    }
    if (line.startsWith('@') || line.trim() === '') { sink = null; continue }
    sink?.(line.trim())
  }
  return { params, returns }
}

/**
 * Check the `@param` half of the completeness contract for one function-like
 * declaration: every checkable parameter carries a non-empty `@param`, and no
 * `@param` is stale. A binding-pattern parameter is a violation (it has no name
 * for `@param` to match); an exempt parameter may be documented but its absence
 * is never checked. Violations append to `violations` in place.
 * @param where - the offender label violations open with, e.g. `event 'x' (file:1)`.
 * @param surface - the surface noun for the binding-pattern message ("event", "service", "export").
 * @param parameters - the declaration's parameter list.
 * @param tags - the parsed `@param` name→description map from parseTags.
 * @param sf - the source file (for rendering a binding pattern's text).
 * @param isExempt - which parameters need no `@param` (e.g. `this`, a waterfall's trailing `next`).
 * @param violations - the aggregate list violations append to.
 */
export function checkParams(
  where: string,
  surface: string,
  parameters: readonly ts.ParameterDeclaration[],
  tags: Map<string, string>,
  sf: ts.SourceFile,
  isExempt: (p: ts.ParameterDeclaration) => boolean,
  violations: string[],
): void {
  for (const p of parameters) {
    if (!ts.isIdentifier(p.name)) {
      violations.push(`${where}: parameter '${p.name.getText(sf)}' is a binding pattern; the ${surface} surface needs simple identifier parameters so @param can name them.`)
      continue
    }
    if (isExempt(p)) continue
    const desc = tags.get(p.name.text)
    if (desc === undefined) violations.push(`${where} is missing @param ${p.name.text}.`)
    else if (!desc.trim()) violations.push(`${where}: @param ${p.name.text} has an empty description.`)
  }
  for (const tag of tags.keys()) {
    if (!parameters.some(p => ts.isIdentifier(p.name) && p.name.text === tag)) {
      violations.push(`${where}: @param ${tag} does not match any parameter (stale tag?).`)
    }
  }
}

/**
 * Check the `@returns` half of the completeness contract: a non-`void` /
 * `Promise<void>` return needs a non-empty `@returns`, and the return type must
 * be ANNOTATED — a pure-AST walk cannot classify an inferred return. On a void
 * declaration `@returns` stays optional (resolution timing can be worth
 * documenting), never required. Violations append to `violations` in place.
 * @param where - the offender label violations open with.
 * @param typeNode - the declared return type annotation, or undefined when inferred.
 * @param returns - the parsed `@returns` description from parseTags (null when absent).
 * @param sf - the source file (for rendering the annotation's text).
 * @param violations - the aggregate list violations append to.
 */
export function checkReturns(
  where: string,
  typeNode: ts.TypeNode | undefined,
  returns: string | null,
  sf: ts.SourceFile,
  violations: string[],
): void {
  if (typeNode === undefined) {
    violations.push(`${where} has no return type annotation; annotate it explicitly so the gate can classify the result.`)
    return
  }
  const rt = typeNode.getText(sf).replace(/\s+/g, ' ')
  if (/^(void|Promise<void>)$/.test(rt)) return
  if (returns === null) violations.push(`${where} is missing @returns (return type: ${rt}).`)
  else if (!returns.trim()) violations.push(`${where}: @returns has an empty description.`)
}

/**
 * Throw one aggregate error for every completeness violation a walk collected.
 * Aggregation (vs failing fast) is deliberate: a remediation pass sees the
 * whole list at once instead of replaying the gate once per offender.
 * @param gate - the reporting gate's name, prefixed to the error message.
 * @param violations - the collected violation lines; no-op when empty.
 */
export function reportViolations(gate: string, violations: string[]): void {
  if (violations.length === 0) return
  throw new Error(
    `${gate}: ${violations.length} JSDoc completeness violation(s) (see AGENTS.md):\n`
    + violations.map(v => `  ${v}`).join('\n'),
  )
}
