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
 * that textually mentions `interface Context`, yielding each file's cordis
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
    if (!text.includes('interface Context')) continue
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
