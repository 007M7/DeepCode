/**
 * Package-invariant companion discovery, generation, and structural checks.
 * The runtime registry stays product-independent; this gate makes ownership
 * exhaustive across packages without centralizing package checks.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/** Marker identifying baseline companions owned by this generator. */
export const GENERATED_INVARIANT_MARKER = '@generated scripts/gen-package-invariants.ts'

/** Required explanation marker for an intentionally empty installer. */
const NO_RUNTIME_INVARIANT_MARKER = 'No runtime invariant:'

interface PackageManifest {
  name?: string
  exports?: Record<string, { types?: string; default?: string } | string | undefined>
  files?: string[]
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** One package and the files participating in its invariant publication contract. */
export interface PackageInvariantOwner {
  readonly dir: string
  readonly manifestPath: string
  readonly sourcePath: string
  readonly packageName: string
}

/** One gate violation with a repo-relative owner path. */
export interface PackageInvariantViolation {
  readonly path: string
  readonly message: string
}

/** Discover every package under the repository package tree. */
export function packageInvariantOwners(root: string): PackageInvariantOwner[] {
  return globSync('packages/*/*/package.json', { cwd: root })
    .map(path => path.split(sep).join('/'))
    .sort()
    .map((manifestPath) => {
      const manifest = readManifest(resolve(root, manifestPath))
      if (manifest.name === undefined || manifest.name === '') {
        throw new Error(`${manifestPath}: package invariant owner must declare a package name`)
      }
      const dir = dirname(manifestPath)
      return {
        dir,
        manifestPath,
        sourcePath: `${dir}/src/invariant.ts`,
        packageName: manifest.name,
      }
    })
}

/** Render the generated ownership-only companion for a package without custom checks. */
export function renderBaselineInvariant(owner: PackageInvariantOwner): string {
  const serviceImport = owner.packageName === '@deepseek-ai/dsh-invariants'
    ? './index.ts'
    : '@deepseek-ai/dsh-invariants'
  const pluginName = `${basename(owner.dir)}-invariant`
  return `/**
 * Generated invariant ownership companion for \`${owner.packageName}\`.
 * Replace this file with package-owned checks while preserving its registration.
 *
 * ${GENERATED_INVARIANT_MARKER}
 * @module ${owner.packageName}/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '${serviceImport}'

const PACKAGE_NAME = '${owner.packageName}'

/** Cordis companion plugin name. */
export const name = '${pluginName}'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: no package-owned event or mutable-data relation has been identified yet. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
`
}

/** Return all violations of the package-invariant companion contract. */
export function collectPackageInvariantViolations(root: string): PackageInvariantViolation[] {
  const violations: PackageInvariantViolation[] = []
  for (const owner of packageInvariantOwners(root)) {
    const manifest = readManifest(resolve(root, owner.manifestPath))
    checkManifest(owner, manifest, violations)
    checkBuild(owner, root, violations)
    checkSource(owner, root, violations)
  }
  return violations
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function addViolation(
  violations: PackageInvariantViolation[],
  path: string,
  message: string,
): void {
  violations.push({ path, message })
}

function checkManifest(
  owner: PackageInvariantOwner,
  manifest: PackageManifest,
  violations: PackageInvariantViolation[],
): void {
  const invariantExport = manifest.exports?.['./invariant']
  if (typeof invariantExport !== 'object'
    || invariantExport.types !== './lib/types/invariant.d.ts'
    || invariantExport.default !== './lib/invariant.js') {
    addViolation(
      violations,
      owner.manifestPath,
      'exports["./invariant"] must target ./lib/types/invariant.d.ts and ./lib/invariant.js',
    )
  }
  if (!manifest.files?.includes('lib/invariant.js')) {
    addViolation(violations, owner.manifestPath, 'files must publish lib/invariant.js')
  }
  if (owner.packageName === '@deepseek-ai/dsh-invariants') return
  if (manifest.peerDependencies?.['@deepseek-ai/dsh-invariants'] !== '^0.0.1') {
    addViolation(
      violations,
      owner.manifestPath,
      '@deepseek-ai/dsh-invariants must be a ^0.0.1 peerDependency',
    )
  }
  if (manifest.devDependencies?.['@deepseek-ai/dsh-invariants'] !== 'workspace:^') {
    addViolation(
      violations,
      owner.manifestPath,
      '@deepseek-ai/dsh-invariants must also be a workspace:^ devDependency',
    )
  }
}

function checkBuild(
  owner: PackageInvariantOwner,
  root: string,
  violations: PackageInvariantViolation[],
): void {
  const tsconfigPath = `${owner.dir}/tsconfig.json`
  const tsconfig = JSON.parse(readFileSync(resolve(root, tsconfigPath), 'utf8')) as {
    references?: Array<{ path?: string }>
  }
  if (owner.packageName !== '@deepseek-ai/dsh-invariants'
    && !tsconfig.references?.some(reference => reference.path === '../../support/invariants')) {
    addViolation(
      violations,
      tsconfigPath,
      'TypeScript project references must include ../../support/invariants',
    )
  }

  const configPath = `${owner.dir}/tsdown.config.ts`
  if (!existsSync(resolve(root, configPath))) return
  const source = readFileSync(resolve(root, configPath), 'utf8')
  if (!source.includes('lib/types/invariant.js')) {
    addViolation(violations, configPath, 'package build override must bundle lib/types/invariant.js')
  }
}

function checkSource(
  owner: PackageInvariantOwner,
  root: string,
  violations: PackageInvariantViolation[],
): void {
  const absolutePath = resolve(root, owner.sourcePath)
  if (!existsSync(absolutePath)) {
    addViolation(violations, owner.sourcePath, 'missing package-owned invariant companion')
    return
  }
  const sourceText = readFileSync(absolutePath, 'utf8')
  if (sourceText.includes(GENERATED_INVARIANT_MARKER)
    && sourceText !== renderBaselineInvariant(owner)) {
    addViolation(
      violations,
      owner.sourcePath,
      'generated baseline is stale; run pnpm run gen-package-invariants',
    )
  }

  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const constants = topLevelStringConstants(sourceFile)
  const registrations: string[] = []
  const unresolved: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isInvariantRegistration(node.expression)) {
      const argument = node.arguments[0]
      const packageName = argument === undefined ? undefined : stringValue(argument, constants)
      if (packageName === undefined) unresolved.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)
      else registrations.push(packageName)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  for (const line of unresolved) {
    addViolation(
      violations,
      owner.sourcePath,
      `line ${line}: ctx.invariants.register package name must resolve to a local string constant`,
    )
  }
  if (registrations.length !== 1 || registrations[0] !== owner.packageName) {
    addViolation(
      violations,
      owner.sourcePath,
      `must register exactly its own package name ${JSON.stringify(owner.packageName)}; saw ${JSON.stringify(registrations)}`,
    )
  }
  for (const exportedName of ['name', 'inject', 'apply']) {
    if (!hasNamedExport(sourceFile, exportedName)) {
      addViolation(violations, owner.sourcePath, `must named-export ${exportedName}`)
    }
  }
  checkEmptyInstallerReason(owner, sourceFile, sourceText, violations)
}

function checkEmptyInstallerReason(
  owner: PackageInvariantOwner,
  sourceFile: ts.SourceFile,
  sourceText: string,
  violations: PackageInvariantViolation[],
): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)
        || declaration.name.text !== 'install'
        || declaration.initializer === undefined) continue
      const installer = installerFunction(declaration.initializer)
      if (installer === undefined
        || !ts.isBlock(installer.body)
        || installer.body.statements.length > 0) return
      const declarationText = sourceText.slice(statement.getFullStart(), statement.getEnd())
      if (!declarationText.includes(NO_RUNTIME_INVARIANT_MARKER)) {
        addViolation(
          violations,
          owner.sourcePath,
          `empty install function must explain why with a "${NO_RUNTIME_INVARIANT_MARKER}" comment`,
        )
      }
      return
    }
  }
}

function installerFunction(
  initializer: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer
  if (ts.isCallExpression(initializer)
    && ts.isPropertyAccessExpression(initializer.expression)
    && ts.isIdentifier(initializer.expression.expression)
    && initializer.expression.expression.text === 'Object'
    && initializer.expression.name.text === 'assign') {
    const target = initializer.arguments[0]
    if (target !== undefined && (ts.isArrowFunction(target) || ts.isFunctionExpression(target))) return target
  }
  return undefined
}

function topLevelStringConstants(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
      const value = stringValue(declaration.initializer, constants)
      if (value !== undefined) constants.set(declaration.name.text, value)
    }
  }
  return constants
}

function stringValue(node: ts.Expression, constants: ReadonlyMap<string, string>): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isIdentifier(node)) return constants.get(node.text)
  return undefined
}

function isInvariantRegistration(expression: ts.LeftHandSideExpression): boolean {
  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'register'
    && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'invariants'
}

function hasNamedExport(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isVariableStatement(statement)
      || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false
    return statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
  })
}

/** Format violations for the command-line gate. */
export function formatPackageInvariantViolation(
  root: string,
  violation: PackageInvariantViolation,
): string {
  const path = resolve(root, violation.path)
  return `${relative(root, path)}: ${violation.message}`
}
