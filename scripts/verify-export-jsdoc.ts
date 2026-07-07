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
 * - A function-like export (function declaration, a const with a function
 *   initializer or an INLINE callable annotation, or a non-identifier
 *   function default export) additionally needs a non-empty `@param` per
 *   parameter (`this` receiver annotations exempt; a stale `@param` errors)
 *   and a non-empty `@returns` unless the return type is `void` /
 *   `Promise<void>`. Wrapper expressions (parentheses, `as` / `satisfies`
 *   casts, non-null assertions) are peeled before classifying. The walk
 *   classifies returns syntactically, so the return type must be ANNOTATED —
 *   except a const whose declarator is annotated with a NAMED type (e.g.
 *   `export const f: Handler = …`), where that type's own declaration owns
 *   the signature contract and `@returns` stays optional; an inline
 *   `(x: T) => U` annotation or single-call-signature literal is the surface
 *   signature itself and gets the full contract, and a literal mixing
 *   call/construct signatures with anything else is refused (extract a named
 *   type).
 * - An exported class needs class-level JSDoc; its public methods (static
 *   included — they are reachable on the exported name) follow the function
 *   contract, and public properties and accessors need description prose (on
 *   a get/set pair the getter's doc covers both). A member declared by an
 *   `extends`/`implements` heritage type is EXEMPT — the seam declaration is
 *   the doc's one home, the IDE inherits it, and re-documenting every
 *   implementation invites drift — UNLESS the override grows surface the
 *   base never documented: a protected-only base member does not exempt a
 *   public override, parameters the base never names keep their `@param`
 *   duty, and a concrete result above a void base return keeps its
 *   `@returns` duty. Heritage members (and classifying an unannotated
 *   override's inferred return above a void base) are the questions the walk
 *   asks the TYPE CHECKER; everything else is pure AST.
 *   Constructors are exempt like the cordis gate's: plugin classes are
 *   framework-constructed, and the class doc owns the story.
 * - Exported interfaces, type aliases, enums: description prose on the
 *   declaration (member-level docs stay review's job; the highest-value
 *   member surface — seam service classes — is already under the cordis
 *   gate).
 * - An exported namespace recurses (its exported members are package
 *   surface; in an ambient `declare` namespace every member exports
 *   implicitly); the namespace itself needs prose only when it does not
 *   merge with an already-documented same-name declaration (the
 *   Config-namespace idiom documents the class/function once, not twice).
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
 *   ours to document. An `export import X = N.member` alias documents
 *   ITSELF, and only prose-only target kinds are gate-supported: a callable,
 *   class, or namespace target carries signature/member contracts the alias
 *   cannot hold and is refused (export the declaration directly).
 * - Everything else fails CLOSED: `export =` is refused outright, and an
 *   exported statement kind the dispatch does not recognize is itself a
 *   violation, so no export form can pass unchecked by omission.
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
 * Peel wrapper expressions that carry no surface of their own — parentheses,
 * `as` / `satisfies` / angle-bracket casts, non-null assertions — so a
 * wrapped function expression is still classified as function-like.
 * @param e - the expression to unwrap.
 * @returns the innermost non-wrapper expression.
 */
function unwrapExpression(e: ts.Expression): ts.Expression {
  let inner = e
  while (
    ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)
    || ts.isNonNullExpression(inner) || ts.isTypeAssertionExpression(inner)
  ) inner = inner.expression
  return inner
}

/**
 * Classify a declarator's type annotation for the function contract: an
 * inline function type or a type literal that is EXACTLY one call signature
 * is the surface signature itself; a literal mixing call/construct
 * signatures with anything else cannot be classified syntactically and is
 * refused (fail closed — extract a named type); everything else is a plain
 * value shape.
 * @param type - the declarator's type annotation.
 * @returns the signature to check, 'refuse' for an unclassifiable callable literal, or null for a non-callable shape.
 */
function callableAnnotation(type: ts.TypeNode): ts.SignatureDeclarationBase | 'refuse' | null {
  if (ts.isFunctionTypeNode(type)) return type
  if (!ts.isTypeLiteralNode(type)) return null
  const signatures = type.members.filter(m => ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m))
  if (signatures.length === 0) return null
  if (signatures.length === 1 && type.members.length === 1 && signatures[0] !== undefined && ts.isCallSignatureDeclaration(signatures[0])) {
    return signatures[0]
  }
  return 'refuse'
}

/**
 * The heritage-member exemption for one class member. When the member's name
 * is declared by an `extends`/`implements` heritage type, the seam declaration
 * is the doc's one home (the IDE inherits it on hover) and the member needs no
 * doc of its own — EXCEPT where the override grows public surface the base
 * never documented: a base member that is protected on every declaration does
 * not exempt a public override (consumers could not call it before);
 * parameters the base never names keep their own `@param` duty (the caller
 * reads the seam doc, which cannot describe them; an underscore-prefixed
 * rename of a base parameter — the deliberately-unused marker — is the same
 * parameter, not new surface); and a void base return carried no `@returns`
 * duty, so an override returning a concrete result documents it itself.
 * Static members are looked up on the base CONSTRUCTOR type (only an
 * `extends` expression has one; an unresolvable or interface expression
 * yields no property and therefore no exemption).
 * @param cls - the class whose heritage to search.
 * @param name - the member name to look up.
 * @param staticSide - whether to search the constructor side instead of the instance side.
 * @param checker - the program's type checker.
 * @returns null when no exemption applies; otherwise the parameter names the
 * base declarations carry (`baseParams: null` when not syntactically
 * recoverable — a complex heritage type — exempting all parameters) plus
 * whether every recoverable base return annotation is `void`-like
 * (`baseVoidReturn: null` when none is recoverable, exempting the result).
 */
function heritageExemption(
  cls: ts.ClassDeclaration,
  name: string,
  staticSide: boolean,
  checker: ts.TypeChecker,
): { baseParams: Set<string> | null; baseVoidReturn: boolean | null } | null {
  const isProtected = (d: ts.Declaration): boolean =>
    (ts.canHaveModifiers(d) ? ts.getModifiers(d) : undefined)?.some(m => m.kind === ts.SyntaxKind.ProtectedKeyword) ?? false
  for (const clause of cls.heritageClauses ?? []) {
    for (const t of clause.types) {
      const type = staticSide ? checker.getTypeAtLocation(t.expression) : checker.getTypeAtLocation(t)
      const prop = type.getProperty(name)
      if (prop === undefined) continue
      const decls = prop.declarations ?? []
      if (decls.length > 0 && decls.every(isProtected)) continue // public override of a protected base: new surface
      let baseParams: Set<string> | null = null
      let baseVoidReturn: boolean | null = null
      for (const d of decls) {
        let params: readonly ts.ParameterDeclaration[] | undefined
        let returnType: ts.TypeNode | undefined
        if (ts.isMethodDeclaration(d) || ts.isMethodSignature(d)) {
          params = d.parameters
          returnType = d.type
        } else if ((ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && d.type !== undefined && ts.isFunctionTypeNode(d.type)) {
          params = d.type.parameters
          returnType = d.type.type
        } else continue
        baseParams ??= new Set()
        // Leading underscores are the deliberately-unused marker (eslint
        // argsIgnorePattern), not a rename: `_cwd` overriding `cwd` is the
        // same parameter, so compare underscore-stripped on both sides.
        for (const p of params) if (ts.isIdentifier(p.name)) baseParams.add(p.name.text.replace(/^_+/, ''))
        if (returnType !== undefined) {
          const voidish = /^(void|Promise<void>)$/.test(returnType.getText(d.getSourceFile()).replace(/\s+/g, ' '))
          baseVoidReturn = (baseVoidReturn ?? true) && voidish
        }
      }
      return { baseParams, baseVoidReturn }
    }
  }
  return null
}

/**
 * True when a method's INFERRED return type is void-like (void, undefined,
 * never, or a promise of one) — the one return the walk asks the checker to
 * classify: an unannotated override above a void heritage member, where
 * demanding an annotation just to prove faithfulness would be boilerplate.
 * @param m - a method declaration with no return type annotation.
 * @param checker - the program's type checker.
 * @returns true when the inferred result carries nothing to document.
 */
function inferredReturnIsVoidish(m: ts.MethodDeclaration, checker: ts.TypeChecker): boolean {
  const sig = checker.getSignatureFromDeclaration(m)
  if (sig === undefined) return true // no callable signature: nothing classifiable to document
  const returned = checker.getReturnTypeOfSignature(sig)
  const awaited = checker.getAwaitedType(returned) ?? returned
  return (awaited.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0
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
 * doc). Heritage-declared members are exempt per heritageExemption (an
 * override's extra parameters keep their @param duty); plugin-protocol
 * statics are exempt; constructors are not checked (framework-constructed
 * plugins, and the class doc owns the story).
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
    const exemption = heritageExemption(cls, mname, isStatic(m), w.checker)
    if (ts.isMethodDeclaration(m)) {
      if (m.body && overloadSigs.has(mname)) continue // overload implementation: the signatures carry the docs
      const where = `exported class method '${name}.${mname}' (${pointer(w.rel, w.sf, m)})`
      if (exemption !== null) {
        const raw = rawJsDoc(w.text, m)
        // The heritage declaration owns the prose; parameters the base never
        // names — including binding patterns, which no base declaration can
        // name — are new surface and keep their @param duty.
        const base = exemption.baseParams
        const inBase = (p: ts.ParameterDeclaration): boolean =>
          base !== null && ts.isIdentifier(p.name) && base.has(p.name.text.replace(/^_+/, ''))
        if (base !== null && m.parameters.some(p => !thisReceiver(p) && !inBase(p))) {
          checkParams(where, 'export', m.parameters, parseTags(raw).params, w.sf,
            p => thisReceiver(p) || inBase(p), w.violations)
        }
        // A void base return carried no @returns duty, so an override growing
        // a concrete result documents it itself. An annotated override runs
        // the standard check; an inferred one is classified by the checker
        // (this branch is already the checker's domain), so a faithful void
        // override stays exempt without a boilerplate annotation.
        if (exemption.baseVoidReturn === true) {
          if (m.type !== undefined) {
            checkReturns(where, m.type, parseTags(raw).returns, w.sf, w.violations)
          } else if (!inferredReturnIsVoidish(m, w.checker)) {
            w.violations.push(`${where} returns a non-void result its heritage declaration does not document; annotate the return type and add @returns.`)
          }
        }
        continue
      }
      checkFunctionLike(where, rawJsDoc(w.text, m), m.parameters, m.type, false, w)
    } else if (exemption !== null) {
      continue // the heritage declaration owns the doc (properties/accessors carry no own parameters)
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
 * Check one exported declaration statement, dispatching on its kind. Any
 * exported statement kind the dispatch does not recognize is a violation
 * (fail closed), so no export form can pass unchecked by omission.
 * @param stmt - the exported statement (export modifier or export-list target).
 * @param prefix - the namespace qualification for surface names ('' at top level).
 * @param overloadSigs - names in this scope declared as bodyless function overload signatures.
 * @param byName - this scope's named declarations (for namespace/sibling-merge lookups).
 * @param ambient - whether the enclosing scope is ambient (`declare`), where members export implicitly.
 * @param w - the walk state violations append to.
 * @param only - for a multi-declarator variable statement reached through an
 *   export list (or a default-export identifier), the declarator names that
 *   are actually exported; `null` means the whole statement is surface
 *   (direct `export` modifier or ambient scope). Non-variable statements
 *   declare exactly one name, so the filter never applies to them.
 */
function checkDecl(
  stmt: ts.Statement,
  prefix: string,
  overloadSigs: Set<string>,
  byName: Map<string, ts.Statement[]>,
  ambient: boolean,
  w: Walk,
  only: ReadonlySet<string> | null = null,
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
      if (only !== null && !only.has(name)) continue // sibling declarator the export list never named: not surface
      if (prefix === '' && PROTOCOL_EXPORTS.has(name)) continue // cordis plugin-protocol slot
      const where = `exported const '${prefix}${name}'${at(d)}`
      const annotation = d.type !== undefined ? callableAnnotation(d.type) : null
      const init = d.initializer !== undefined ? unwrapExpression(d.initializer) : undefined
      if (annotation === 'refuse') {
        // A literal mixing call/construct signatures with other members (or
        // overloading them) has no single signature the walk can hold the
        // tags against — fail closed rather than silently narrow the check.
        w.violations.push(`${where}: its callable type literal is not gate-classifiable; extract a named type and document it there.`)
      } else if (annotation !== null) {
        // An INLINE callable annotation is the surface signature itself: its
        // parameters and result need docs right here. (A NAMED reference
        // type carries its docs at the type's own declaration instead.)
        checkFunctionLike(where, raw, annotation.parameters, annotation.type, false, w)
      } else if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        // A named declarator type annotation (`const f: Handler = …`) hands
        // the return contract to the named type; the arrow's own annotation is
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
    // In an ambient (`declare`) namespace body, members are implicitly
    // exported — no `export` modifier required — so the recursion must treat
    // every statement as surface.
    const declared = ambient
      || ((ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined)?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false)
    if (body !== undefined && ts.isModuleBlock(body)) checkScope(body.statements, nsPrefix, w, declared)
    return
  }
  if (ts.isImportEqualsDeclaration(stmt)) {
    const where = `exported alias '${prefix}${stmt.name.text}'${at(stmt)}`
    // An alias is a distinct exported name whose target may be a non-exported
    // namespace member no walk ever visits, so it documents ITSELF — which
    // matches the gate's strength only for prose-only target kinds. A
    // callable, class, or namespace target carries signature or member
    // contracts the alias prose cannot hold: refuse those (fail closed) and
    // demand the declaration be exported directly. An unresolvable target is
    // refused for the same reason.
    const sym = w.checker.getSymbolAtLocation(stmt.name)
    const target = sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0 ? w.checker.getAliasedSymbol(sym) : sym
    const RICH_TARGETS = ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule
    const rich = target === undefined
      || (target.flags & RICH_TARGETS) !== 0
      || w.checker.getTypeOfSymbol(target).getCallSignatures().length > 0
    if (rich) {
      w.violations.push(`${where} aliases a callable, class, or namespace target whose signature/member contract the alias cannot carry; export the declaration directly instead.`)
      return
    }
    checkDescribed(where, rawJsDoc(w.text, stmt), w)
    return
  }
  // Fail CLOSED: an exported statement kind this dispatch does not recognize
  // must never pass silently — the gate's whole promise is that unchecked
  // surface cannot exist. New TypeScript export forms extend the gate here.
  w.violations.push(`exported statement${at(stmt)} uses an export form verify-export-jsdoc does not handle; extend the gate.`)
}

/**
 * Walk one lexical scope (file top level or a namespace body): check every
 * exported declaration, resolving `export { … }` lists (no module specifier)
 * to their local declarations.
 * @param statements - the scope's statements.
 * @param prefix - the namespace qualification for surface names ('' at top level).
 * @param w - the walk state violations append to.
 * @param ambient - whether this scope is ambient (`declare` namespace or a declaration file), where members export implicitly.
 */
function checkScope(statements: readonly ts.Statement[], prefix: string, w: Walk, ambient: boolean): void {
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
  // Two-phase dispatch. Phase one accumulates WHICH statements are surface
  // and, for a variable statement reached by name (an export list or a
  // default-export identifier), which of its declarators the exports actually
  // name — `null` marks the whole statement as surface (a direct `export`
  // modifier, or an ambient scope). Requests for the same statement merge:
  // `null` absorbs any name set, and name sets union, so
  // `export { a }; export { b }` over one `const a = …, b = …` checks both
  // declarators while a never-exported sibling stays out of the surface.
  // Phase two runs each surfaced statement exactly once. (Checking a
  // statement eagerly per request would either re-check on the second list or
  // — deduplicated — silently drop the second list's declarators.)
  const requested = new Map<ts.Statement, Set<string> | null>()
  const request = (stmt: ts.Statement, name: string | null): void => {
    const prior = requested.get(stmt)
    if (name === null || prior === null) {
      requested.set(stmt, null)
      return
    }
    requested.set(stmt, prior === undefined ? new Set([name]) : prior.add(name))
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
          const local = (el.propertyName ?? el.name).text
          for (const decl of byName.get(local) ?? []) request(decl, local)
          // a name with no local declaration is an imported binding re-exported
          // without a specifier — its defining module is walked on its own
        }
      }
      continue
    }
    if (ts.isExportAssignment(stmt)) {
      if (stmt.isExportEquals) {
        // `export =` has no ESM consumer surface in this repo and the walk
        // cannot classify its operand's shape; refuse rather than fail open.
        w.violations.push(`export-equals assignment (${pointer(w.rel, w.sf, stmt)}) is not a gate-supported export form; use ESM named exports.`)
        continue
      }
      const where = `default export (${pointer(w.rel, w.sf, stmt)})`
      const expr = unwrapExpression(stmt.expression)
      if (ts.isIdentifier(expr)) {
        for (const decl of byName.get(expr.text) ?? []) request(decl, expr.text)
      } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        checkFunctionLike(where, rawJsDoc(w.text, stmt), expr.parameters, expr.type, false, w)
      } else {
        checkDescribed(where, rawJsDoc(w.text, stmt), w)
      }
      continue
    }
    if (isExported(stmt) || (ambient && !ts.isImportDeclaration(stmt))) request(stmt, null)
  }
  for (const stmt of statements) {
    const only = requested.get(stmt)
    if (only !== undefined) checkDecl(stmt, prefix, overloadSigs, byName, ambient, w, only)
  }
}

/**
 * Compiler options for the walk's program. The real repo hands over its
 * tsconfig.base.json (whose `paths` map resolves cross-package imports to
 * source, so heritage-member lookups see seam types); a fixture root without
 * one gets `noLib` + no `@types` — fixtures are single-file and
 * self-contained, nothing in the walk resolves a lib symbol, and default-lib
 * parsing is ~99% of per-program cost (it made the fixture spec time out
 * under CI coverage instrumentation). Emit-side options are stripped: the
 * walk never emits or asks for diagnostics, it only binds types on demand.
 * @param scanRoot - the root being scanned.
 * @returns compiler options for ts.createProgram.
 */
function loadCompilerOptions(scanRoot: string): ts.CompilerOptions {
  const cfgPath = resolve(scanRoot, 'tsconfig.base.json')
  if (!existsSync(cfgPath)) return { skipLibCheck: true, noLib: true, types: [] }
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
    // A script-style declaration file (no imports/exports) is one big ambient
    // scope; a module-style .d.ts still honors explicit export modifiers.
    checkScope(sf.statements, '', { rel, sf, text: sf.text, checker, violations }, sf.isDeclarationFile && !ts.isExternalModule(sf))
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
