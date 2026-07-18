/**
 * Shared AST walkers for the cordis documentation generators
 * (`gen-cordis-catalog.ts`, `gen-website-api.ts`): locating the cordis module
 * merge in a source file, enumerating its `interface Events` members, and
 * resolving the `interface Context` service keys to their service declarations.
 * One walk, two renderers — the catalog and the website page carry different
 * prose but must agree on WHAT exists.
 */

import ts from 'typescript'
import { parseJsDoc, pointer, rawJsDoc } from './jsdoc.ts'

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

/** Every `interface Events` method member of a cordis module merge, with the
 * event name resolved from its (possibly string-literal) property name. */
export function eventMembers(body: ts.ModuleBlock, sf: ts.SourceFile): { name: string; member: ts.MethodSignature }[] {
  const out: { name: string; member: ts.MethodSignature }[] = []
  for (const stmt of body.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== 'Events') continue
    for (const member of stmt.members) {
      if (!ts.isMethodSignature(member)) continue
      const name = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(sf)
      out.push({ name, member })
    }
  }
  return out
}

/** The `ctx.<key> → type name` map declared by a merge's `interface Context`. */
function contextKeyMap(body: ts.ModuleBlock, sf: ts.SourceFile): Map<string, string> {
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

/** One `ctx.<key>` service declaration resolved from a Context merge. */
export interface ServiceDeclaration {
  key: string
  type: string
  declaration: ts.ClassDeclaration | ts.InterfaceDeclaration
  abstract: boolean
  /** Declaration-level JSDoc prose (empty string when missing — also reported). */
  doc: string
}

/**
 * Resolve each `ctx.<key>` of a merge to the service class or interface declared in the
 * same file. A key whose type is not a class here (a Pick-mixin member, e.g.
 * timer helpers) is skipped. A declaration without JSDoc prose is reported into
 * `violations` (named `where` by the caller's gate).
 *
 * @param body — the cordis module merge body.
 * @param sf — the source file containing the merge.
 * @param rel — repo-relative path of `sf`, for violation pointers.
 * @param violations — sink for JSDoc-completeness violations.
 * @returns the resolved service declarations, in Context-declaration order.
 */
export function serviceDeclarations(
  body: ts.ModuleBlock,
  sf: ts.SourceFile,
  rel: string,
  violations: string[],
): ServiceDeclaration[] {
  const text = sf.getFullText()
  const out: ServiceDeclaration[] = []
  for (const [key, type] of contextKeyMap(body, sf)) {
    const declaration = sf.statements.find(
      (s): s is ts.ClassDeclaration | ts.InterfaceDeclaration =>
        (ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name?.text === type,
    )
    if (!declaration) continue // a Pick-mixin member, not a service declaration here
    const abstract = ts.isInterfaceDeclaration(declaration)
      || (declaration.modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false)
    const doc = parseJsDoc(rawJsDoc(text, declaration)).doc
    if (!doc) {
      const kind = ts.isInterfaceDeclaration(declaration) ? 'interface' : 'class'
      violations.push(`service ctx.${key} (${pointer(rel, sf, declaration)}): ${kind} ${type} has no JSDoc.`)
    }
    out.push({ key, type, declaration, abstract, doc })
  }
  return out
}
