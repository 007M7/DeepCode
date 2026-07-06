/**
 * Verify JSDoc completeness for EVERY module-level exported name of every
 * non-vendored package (each `packages/<group>/<pkg>/src/` tree). This is the
 * mechanical form of the AGENTS.md rule "every export has a JSDoc explaining
 * semantics", generalizing the cordis-surface gate (`gen-cordis-catalog.ts`,
 * which owns `interface Events` members and `ctx.<key>` service classes) to
 * the whole export surface; the parsing + check helpers are shared via
 * `scripts/jsdoc.ts` so "documented" means the same thing on both.
 *
 *   `tsx scripts/verify-export-jsdoc.ts`  → exit 1 listing every offender
 *
 * The contract, per exported declaration kind:
 *
 * - Every exported name needs JSDoc with non-empty description prose (prose
 *   ends at the first block tag, standard JSDoc semantics).
 * - A function-like export (function declaration, or a const with a function
 *   initializer) additionally needs a non-empty `@param` per parameter
 *   (`this` receiver annotations exempt; a stale `@param` errors) and a
 *   non-empty `@returns` unless the return type is `void`/`Promise<void>`.
 *   The walk classifies returns syntactically, so the return type must be
 *   ANNOTATED — except a const whose DECLARATOR is type-annotated (e.g.
 *   `export const f: Handler = …`), where the named type owns the return
 *   contract and `@returns` stays optional.
 * - An exported class needs class-level JSDoc; its public methods (static
 *   included — they are reachable on the exported name) follow the function
 *   contract, and public properties and accessors need description prose (on
 *   a get/set pair the getter's doc covers both). A member whose name exists
 *   on an `extends`/`implements` heritage type is EXEMPT — the seam
 *   declaration is the doc's one home, the IDE inherits it, and re-documenting
 *   every implementation invites drift. This is the one question the walk
 *   asks the TYPE CHECKER (heritage members live across package boundaries);
 *   everything else is pure AST. Constructors are exempt like the cordis
 *   gate's: plugin classes are framework-constructed, and the class doc owns
 *   the story.
 * - Exported interfaces, type aliases, enums: description prose on the
 *   declaration (member-level docs stay review's job; the highest-value
 *   member surface — seam service classes — is already under the cordis
 *   gate).
 * - An exported namespace recurses (its exported members are package
 *   surface); the namespace itself needs prose only when it does not merge
 *   with an already-documented same-name declaration (the Config-namespace
 *   idiom documents the class/function once, not twice).
 * - The cordis plugin-protocol slots are exempt: top-level `name` / `inject`
 *   / `reusable` / `Config` consts and the `apply` entry, plus the same
 *   slots as statics on a plugin class. Their shape is fixed by the
 *   framework, so a doc would restate the protocol — the module doc comment
 *   and the `interface Config` carry the plugin's real semantics. (These
 *   names are reserved by cordis convention; documenting one anyway is
 *   allowed, only absence goes unchecked.)
 * - Overload groups: each overload signature carries its own docs; the
 *   implementation signature is exempt (callers never see it).
 * - Skipped: `declare module` / `declare global` augmentation bodies (the
 *   cordis gate's turf; an augmentation is not an export of the package) and
 *   re-export statements with a module specifier (`export … from`) — the
 *   defining module is walked on its own, and external definitions are not
 *   ours to document.
 */

import { existsSync, globSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { checkParams, checkReturns, parseJsDoc, parseTags, pointer, rawJsDoc } from './jsdoc.ts'

const root = resolve(import.meta.dirname, '..')

/** Plugin-protocol slot names exempt as statics on an exported class. */
const PROTOCOL_STATICS = new Set(['Config', 'inject', 'name', 'reusable'])

/** Plugin-protocol slot names exempt as top-level exports (const or function). */
const PROTOCOL_EXPORTS = new Set(['Config', 'inject', 'name', 'reusable', 'apply'])

/** Per-file walk state threaded through the scope recursion. */
interface Walk {
  /** Repo-relative path of the file being walked. */
  rel: string
  /** The parsed source file. */
  sf: ts.SourceFile
  /** Raw file text (rawJsDoc reads comment ranges out of it). */
  text: string
  /** The program's checker, consulted only for heritage-member lookups. */
  checker: ts.TypeChecker
  /** The aggregate violation list, appended in place. */
  violations: string[]
}

/** True when a statement carries the `export` modifier. */
function isExported(stmt: ts.Statement): boolean {
  return ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
}

/** True for a class member a consumer cannot reach: `private`/`protected`/`#name`. */
function isNonPublic(member: ts.ClassElement): boolean {
  const mods = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined
  return (mods?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword) ?? false)
    || ('name' in member && ts.isPrivateIdentifier(member.name))
}

/** True when a class member carries the `static` modifier. */
function isStatic(member: ts.ClassElement): boolean {
  const mods = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined
  return mods?.some(m => m.kind === ts.SyntaxKind.StaticKeyword) ?? false
}

/** The `this`-receiver exemption every function-like check shares. */
function thisReceiver(p: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(p.name) && p.name.text === 'this'
}

/**
 * True when a member name exists on any `extends`/`implements` heritage type
 * of the class — the member implements or overrides a documented seam
 * declaration, which is the doc's one home (the IDE inherits it on hover).
 * Static members are looked up on the base CONSTRUCTOR type (only an
 * `extends` expression has one; an unresolvable or interface expression
 * yields no property and therefore no exemption).
 * @param cls - the class whose heritage to search.
 * @param name - the member name to look up.
 * @param staticSide - whether to search the constructor side instead of the instance side.
 * @param checker - the program's type checker.
 * @returns true when a heritage type declares the member.
 */
function inheritedMember(cls: ts.ClassDeclaration, name: string, staticSide: boolean, checker: ts.TypeChecker): boolean {
  for (const clause of cls.heritageClauses ?? []) {
    for (const t of clause.types) {
      const type = staticSide ? checker.getTypeAtLocation(t.expression) : checker.getTypeAtLocation(t)
      if (type.getProperty(name) !== undefined) return true
    }
  }
  return false
}

/**
 * Check description-prose presence for one labeled declaration: JSDoc must
 * exist and carry prose above its block tags.
 * @param where - the offender label violations open with.
 * @param raw - the declaration's raw JSDoc block ('' if none).
 * @param w - the walk state violations append to.
 */
function checkDescribed(where: string, raw: string, w: Walk): void {
  if (!raw) w.violations.push(`${where} has no JSDoc.`)
  else if (!parseJsDoc(raw).doc) w.violations.push(`${where} has no description prose above its block tags.`)
}

/**
 * Check the full function contract for one labeled function-like declaration:
 * description prose, `@param` per parameter, `@returns` on a non-void result.
 * @param where - the offender label violations open with.
 * @param raw - the declaration's raw JSDoc block ('' if none).
 * @param parameters - the declaration's parameter list.
 * @param returnType - the return type annotation, or undefined when inferred.
 * @param returnsWaived - suppress the `@returns`/annotation requirement (a
 * declarator-annotated const defers its return contract to the named type).
 * @param w - the walk state violations append to.
 */
function checkFunctionLike(
  where: string,
  raw: string,
  parameters: readonly ts.ParameterDeclaration[],
  returnType: ts.TypeNode | undefined,
  returnsWaived: boolean,
  w: Walk,
): void {
  if (!raw) { w.violations.push(`${where} has no JSDoc.`); return }
  if (!parseJsDoc(raw).doc) w.violations.push(`${where} has no description prose above its block tags.`)
  const { params, returns } = parseTags(raw)
  checkParams(where, 'export', parameters, params, w.sf, thisReceiver, w.violations)
  if (!returnsWaived) checkReturns(where, returnType, returns, w.sf, w.violations)
}

/**
 * Check one exported class: class-level prose, the function contract on every
 * public method (overload implementations exempt), and description prose on
 * public properties and accessors (a get/set pair is covered by the getter's
 * doc). Members declared by a heritage type and the plugin-protocol statics
 * are exempt; constructors are not checked (framework-constructed plugins,
 * and the class doc owns the story).
 * @param cls - the exported class declaration.
 * @param name - the class's surface name (namespace-qualified).
 * @param w - the walk state violations append to.
 */
function checkClass(cls: ts.ClassDeclaration, name: string, w: Walk): void {
  checkDescribed(`exported class '${name}' (${pointer(w.rel, w.sf, cls)})`, rawJsDoc(w.text, cls), w)
  const overloadSigs = new Set<string>()
  const documentedGetters = new Set<string>()
  for (const m of cls.members) {
    if ('name' in m && ts.isComputedPropertyName(m.name)) continue
    if (ts.isMethodDeclaration(m) && !m.body) overloadSigs.add(m.name.getText(w.sf))
    if (ts.isGetAccessorDeclaration(m)) documentedGetters.add(m.name.getText(w.sf))
  }
  for (const m of cls.members) {
    if (isNonPublic(m) || ts.isConstructorDeclaration(m)) continue
    if (!('name' in m) || ts.isComputedPropertyName(m.name)) continue // computed/symbol members
    const mname = m.name.getText(w.sf)
    if (isStatic(m) && PROTOCOL_STATICS.has(mname)) continue // cordis plugin-protocol slot
    if (inheritedMember(cls, mname, isStatic(m), w.checker)) continue // the heritage declaration owns the doc
    if (ts.isMethodDeclaration(m)) {
      if (m.body && overloadSigs.has(mname)) continue // overload implementation: the signatures carry the docs
      checkFunctionLike(`exported class method '${name}.${mname}' (${pointer(w.rel, w.sf, m)})`, rawJsDoc(w.text, m), m.parameters, m.type, false, w)
    } else if (ts.isGetAccessorDeclaration(m) || ts.isPropertyDeclaration(m)) {
      const kind = ts.isPropertyDeclaration(m) ? 'property' : 'accessor'
      checkDescribed(`exported class ${kind} '${name}.${mname}' (${pointer(w.rel, w.sf, m)})`, rawJsDoc(w.text, m), w)
    } else if (ts.isSetAccessorDeclaration(m) && !documentedGetters.has(mname)) {
      checkDescribed(`exported class accessor '${name}.${mname}' (${pointer(w.rel, w.sf, m)})`, rawJsDoc(w.text, m), w)
    }
    // index signatures / static blocks: not named surface
  }
}

/**
 * Check one exported declaration statement, dispatching on its kind.
 * @param stmt - the exported statement (export modifier or export-list target).
 * @param prefix - the namespace qualification for surface names ('' at top level).
 * @param overloadSigs - names in this scope declared as bodyless function overload signatures.
 * @param byName - this scope's named declarations (for namespace/sibling-merge lookups).
 * @param w - the walk state violations append to.
 */
function checkDecl(
  stmt: ts.Statement,
  prefix: string,
  overloadSigs: Set<string>,
  byName: Map<string, ts.Statement[]>,
  w: Walk,
): void {
  const at = (n: ts.Node): string => ` (${pointer(w.rel, w.sf, n)})`
  if (ts.isFunctionDeclaration(stmt)) {
    const name = stmt.name?.text ?? 'default'
    if (prefix === '' && PROTOCOL_EXPORTS.has(name)) return // cordis plugin-protocol slot
    if (stmt.body && overloadSigs.has(name)) return // overload implementation: the signatures carry the docs
    checkFunctionLike(`exported function '${prefix}${name}'${at(stmt)}`, rawJsDoc(w.text, stmt),
      stmt.parameters, stmt.type, false, w)
    return
  }
  if (ts.isClassDeclaration(stmt)) {
    checkClass(stmt, `${prefix}${stmt.name?.text ?? 'default'}`, w)
    return
  }
  if (ts.isInterfaceDeclaration(stmt)) {
    checkDescribed(`exported interface '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(w.text, stmt), w)
    return
  }
  if (ts.isTypeAliasDeclaration(stmt)) {
    checkDescribed(`exported type '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(w.text, stmt), w)
    return
  }
  if (ts.isEnumDeclaration(stmt)) {
    checkDescribed(`exported enum '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(w.text, stmt), w)
    return
  }
  if (ts.isVariableStatement(stmt)) {
    const raw = rawJsDoc(w.text, stmt) // JSDoc sits on the statement, not the declarator
    for (const d of stmt.declarationList.declarations) {
      const name = ts.isIdentifier(d.name) ? d.name.text : d.name.getText(w.sf)
      if (prefix === '' && PROTOCOL_EXPORTS.has(name)) continue // cordis plugin-protocol slot
      const where = `exported const '${prefix}${name}'${at(d)}`
      const init = d.initializer
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        // A declarator type annotation (`const f: Handler = …`) hands the
        // return contract to the named type; the arrow's own annotation is
        // still checked when it is the only signature the reader has.
        checkFunctionLike(where, raw, init.parameters, init.type, init.type === undefined && d.type !== undefined, w)
      } else {
        checkDescribed(where, raw, w)
      }
    }
    return
  }
  if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
    // A namespace merging with a documented same-name sibling (the
    // Config-namespace idiom) needs no second doc block of its own.
    const siblings = (byName.get(stmt.name.text) ?? []).filter(s => s !== stmt)
    const merged = siblings.some(s => parseJsDoc(rawJsDoc(w.text, s)).doc !== '')
    if (!merged) checkDescribed(`exported namespace '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(w.text, stmt), w)
    let body = stmt.body
    let nsPrefix = `${prefix}${stmt.name.text}.`
    while (body !== undefined && ts.isModuleDeclaration(body)) { // dotted `namespace A.B`
      nsPrefix += `${body.name.getText(w.sf)}.`
      body = body.body
    }
    if (body !== undefined && ts.isModuleBlock(body)) checkScope(body.statements, nsPrefix, w)
  }
}

/**
 * Walk one lexical scope (file top level or a namespace body): check every
 * exported declaration, resolving `export { … }` lists (no module specifier)
 * to their local declarations.
 * @param statements - the scope's statements.
 * @param prefix - the namespace qualification for surface names ('' at top level).
 * @param w - the walk state violations append to.
 */
function checkScope(statements: readonly ts.Statement[], prefix: string, w: Walk): void {
  const byName = new Map<string, ts.Statement[]>()
  const overloadSigs = new Set<string>()
  const add = (name: string, stmt: ts.Statement): void => {
    byName.set(name, [...(byName.get(name) ?? []), stmt])
  }
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.name) add(stmt.name.text, stmt)
      if (!stmt.body && stmt.name) overloadSigs.add(stmt.name.text)
    } else if (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)
      || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      if (stmt.name) add(stmt.name.text, stmt)
    } else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
      add(stmt.name.text, stmt)
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) add(d.name.text, stmt)
      }
    }
  }
  const checked = new Set<ts.Statement>()
  const check = (stmt: ts.Statement): void => {
    if (checked.has(stmt)) return
    checked.add(stmt)
    checkDecl(stmt, prefix, overloadSigs, byName, w)
  }
  for (const stmt of statements) {
    if (ts.isModuleDeclaration(stmt)
      && (ts.isStringLiteral(stmt.name) || (stmt.flags & ts.NodeFlags.GlobalAugmentation) !== 0)) {
      continue // `declare module '…'` / `declare global` augmentation: not an export of this package
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier) continue // re-export: the defining module is walked on its own
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          for (const decl of byName.get((el.propertyName ?? el.name).text) ?? []) check(decl)
          // a name with no local declaration is an imported binding re-exported
          // without a specifier — its defining module is walked on its own
        }
      }
      continue
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (ts.isIdentifier(stmt.expression)) {
        for (const decl of byName.get(stmt.expression.text) ?? []) check(decl)
      } else {
        checkDescribed(`default export (${pointer(w.rel, w.sf, stmt)})`, rawJsDoc(w.text, stmt), w)
      }
      continue
    }
    if (isExported(stmt)) check(stmt)
  }
}

/**
 * Compiler options for the walk's program. The real repo hands over its
 * tsconfig.base.json (whose `paths` map resolves cross-package imports to
 * source, so heritage-member lookups see seam types); a fixture root without
 * one gets bare defaults — fixtures are single-file and self-contained.
 * Emit-side options are stripped: the walk never emits or asks for
 * diagnostics, it only binds types on demand.
 * @param scanRoot - the root being scanned.
 * @returns compiler options for ts.createProgram.
 */
function loadCompilerOptions(scanRoot: string): ts.CompilerOptions {
  const cfgPath = resolve(scanRoot, 'tsconfig.base.json')
  if (!existsSync(cfgPath)) return { skipLibCheck: true }
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile.bind(ts.sys)) as { config?: unknown }
  const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, scanRoot)
  return {
    ...parsed.options,
    noEmit: true,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    incremental: false,
  }
}

/**
 * Walk every non-vendored package source file and collect JSDoc-completeness
 * violations for its module-level exports. Returns findings instead of
 * throwing so tests assert on the list; the CLI entry turns a non-empty list
 * into exit 1.
 * @param scanRoot - the repo root to scan; tests pass a fixture dir.
 * @returns every violation, in file order, one human-readable line each.
 */
export function collectExportJsdocViolations(scanRoot: string = root): string[] {
  const violations: string[] = []
  const rels = globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).sort()
  const program = ts.createProgram(rels.map(rel => resolve(scanRoot, rel)), loadCompilerOptions(scanRoot))
  const checker = program.getTypeChecker()
  for (const rel of rels) {
    const sf = program.getSourceFile(resolve(scanRoot, rel))
    if (!sf) continue // program root files always resolve; guard for narrowing
    checkScope(sf.statements, '', { rel, sf, text: sf.text, checker, violations })
  }
  return violations
}

/** CLI entry: list every violation and exit 1, or confirm a clean surface. */
function main(): void {
  const violations = collectExportJsdocViolations()
  if (violations.length === 0) {
    console.log('verify-export-jsdoc: every exported name on the package surface is documented.')
    return
  }
  console.error(`verify-export-jsdoc: ${violations.length} JSDoc completeness violation(s) (see AGENTS.md):`)
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
