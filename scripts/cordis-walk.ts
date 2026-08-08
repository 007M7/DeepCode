/**
 * AST helpers shared by the Cordis generators: locate the Cordis module merge
 * in a source file and enumerate the `interface Context` keys it declares.
 * The vendored core API projector consumes the merge body; the per-subsystem
 * region generator's exhaustiveness backstop consumes the key scan.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'

/**
 * Parse every file matching `pattern` (repo-relative, sorted, `/`-normalized)
 * that textually contains a cordis module merge, yielding each file's
 * module-merge body. Files without a merge are skipped.
 * @param scanRoot - Repository root the pattern is resolved against.
 * @param pattern - Glob selecting the TypeScript files to scan.
 * @returns One entry per file with a cordis module merge, in path order.
 */
export function contextMergeFiles(
  scanRoot: string,
  pattern: string,
): { rel: string; sf: ts.SourceFile; text: string; body: ts.ModuleBlock }[] {
  const out: { rel: string; sf: ts.SourceFile; text: string; body: ts.ModuleBlock }[] = []
  for (const rel of globSync(pattern, { cwd: scanRoot }).map(s => s.split(sep).join('/')).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes("declare module 'cordis'") && !text.includes("declare module './context.ts'")) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    const body = cordisModuleBody(sf)
    if (!body) continue
    out.push({ rel, sf, text, body })
  }
  return out
}

/** The body of the cordis module merge in `sf`: `declare module 'cordis'`
 * (harness packages) or `declare module './context.ts'` (vendor core), or
 * null when the file has neither. */
export function cordisModuleBody(sf: ts.SourceFile): ts.ModuleBlock | null {
  for (const stmt of sf.statements) {
    if (!ts.isModuleDeclaration(stmt) || !ts.isStringLiteral(stmt.name)) continue
    if (stmt.name.text !== 'cordis' && stmt.name.text !== './context.ts') continue
    if (stmt.body && ts.isModuleBlock(stmt.body)) return stmt.body
  }
  return null
}

/**
 * Every `key: Type` property a `declare module 'cordis'` Context merge
 * declares in one module body.
 * @param body - The cordis module augmentation block.
 * @param sf - Owning source file (for text extraction).
 * @returns key → declared type-name text, in declaration order.
 */
export function contextKeyMap(body: ts.ModuleBlock, sf: ts.SourceFile): Map<string, string> {
  const keyToType = new Map<string, string>()
  for (const stmt of body.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== 'Context') continue
    for (const member of stmt.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue
      keyToType.set(member.name.getText(sf), member.type.getText(sf))
    }
  }
  return keyToType
}

/**
 * Every event name a `declare module 'cordis'` Events merge declares in one
 * module body. Names are the literal member keys (`'agent/created'`), read
 * from method and property members alike so a declaration shape the projector
 * would reject still enters the exhaustiveness scan.
 * @param body - The cordis module augmentation block.
 * @param sf - Owning source file (for computed-name text extraction).
 * @returns Declared event names, in declaration order.
 */
export function eventNameList(body: ts.ModuleBlock, sf: ts.SourceFile): string[] {
  const names: string[] = []
  for (const stmt of body.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== 'Events') continue
    for (const member of stmt.members) {
      if (!member.name) continue
      names.push(ts.isStringLiteral(member.name) || ts.isIdentifier(member.name)
        ? member.name.text
        : member.name.getText(sf))
    }
  }
  return names
}
