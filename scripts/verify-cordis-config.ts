/**
 * Validate Cordis Loader entry metadata and package resolution.
 *
 * The Loader interpolates only a plugin entry's `config`; expression objects in
 * fields such as `disabled` remain truthy data and silently change composition.
 * Example configs and the dsh Web composition resolve named plugins from their
 * owning workspace manifests. Local example packages must also be in the root
 * TypeScript project graph.
 */

import { globSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import ts from 'typescript'
import { cordisConfigFiles } from './cordis-config-files.ts'

interface JsExpr {
  __jsExpr: string
}

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
}

interface PluginReference {
  file: string
  name: string
}

const root = resolve(import.meta.dirname, '..')
// These example files are overlays consumed by the built dsh app, so their bare
// specifiers resolve from apps/cli rather than the examples workspace.
const appOverlayFiles = new Set(['examples/web-cordis/cordis.yml'])
const metadataFields = ['id', 'name', 'group', 'disabled', 'inject', 'intercept', 'isolate'] as const
const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: (data: unknown): JsExpr => {
    if (typeof data !== 'string') throw new TypeError('!!js requires a scalar string')
    return { __jsExpr: data }
  },
})
const schema = yaml.JSON_SCHEMA.extend(jsExprType)

const files = cordisConfigFiles(root)
const errors: string[] = []
const pluginReferences: PluginReference[] = []

for (const file of files) {
  const document: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'), { schema })
  if (!isUnknownArray(document)) {
    errors.push(`${file}: root must be a Loader entry array`)
    continue
  }
  for (let index = 0; index < document.length; index++) {
    validateEntry(document[index], file, `[${index}]`)
  }
}

errors.push(...validateExampleResolution())
errors.push(...validateAppResolution())

if (errors.length > 0) {
  console.error('verify-cordis-config: invalid Loader metadata or plugin package resolution:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`verify-cordis-config: ${files.length} config files passed.`)
}

function validateEntry(value: unknown, file: string, path: string): void {
  if (!isRecord(value)) {
    errors.push(`${file}${path}: entry must be an object`)
    return
  }
  recordPlugin(value, file)
  validateMetadata(value, file, path)
  if ((value.group === true || value.name === '@cordisjs/plugin-group') && isUnknownArray(value.config)) {
    for (let index = 0; index < value.config.length; index++) {
      validateEntry(value.config[index], file, `${path}.config[${index}]`)
    }
  }
  if (isUnknownArray(value.insert)) {
    for (let index = 0; index < value.insert.length; index++) {
      validateEntry(value.insert[index], file, `${path}.insert[${index}]`)
    }
  }
  if (value.name !== '@cordisjs/plugin-include') return
  const config = value.config
  if (!isRecord(config) || !isUnknownArray(config.patches)) return
  for (let index = 0; index < config.patches.length; index++) {
    const patch = config.patches[index]
    const patchPath = `${path}.config.patches[${index}]`
    if (!isRecord(patch)) continue
    recordPlugin(patch, file)
    validateMetadata(patch, file, patchPath)
    if (!isUnknownArray(patch.insert)) continue
    for (let insertIndex = 0; insertIndex < patch.insert.length; insertIndex++) {
      validateEntry(patch.insert[insertIndex], file, `${patchPath}.insert[${insertIndex}]`)
    }
  }
}

function recordPlugin(entry: Record<string, unknown>, file: string): void {
  if (typeof entry.name === 'string') pluginReferences.push({ file, name: entry.name })
}

function validateExampleResolution(): string[] {
  const violations: string[] = []
  const exampleManifest = readManifest('examples/package.json')
  const dependencies = exampleManifest.dependencies ?? {}
  const localPackages = localPackageDirectories()
  const rootReferences = rootProjectReferences()
  const exampleReferences = pluginReferences.filter(reference => reference.file.startsWith('examples/') && !appOverlayFiles.has(reference.file))
  violations.push(...missingPluginDependencies(exampleReferences, dependencies, 'examples/package.json'))
  const requiredPackages = new Set(exampleReferences.map(reference => packageNameFromSpecifier(reference.name)))

  const localExamplePackages = new Set([
    ...Object.keys(dependencies),
    ...[...requiredPackages].filter(packageName => packageName !== undefined),
  ])
  for (const packageName of localExamplePackages) {
    const packageDirectory = localPackages.get(packageName)
    if (packageDirectory === undefined || rootReferences.has(packageDirectory)) continue
    const repoPath = relative(root, packageDirectory).replaceAll('\\', '/')
    violations.push(`tsconfig.json: missing project reference for ${packageName} (${repoPath})`)
  }

  return violations
}

function validateAppResolution(): string[] {
  const dependencies = readManifest('apps/cli/package.json').dependencies ?? {}
  const shipped = new Set(globSync('*.cordis.yml', { cwd: resolve(root, 'apps/cli/config') })
    .map(file => `apps/cli/config/${file}`))
  const references = pluginReferences.filter(reference => shipped.has(reference.file) || appOverlayFiles.has(reference.file))
  return missingPluginDependencies(references, dependencies, 'apps/cli/package.json')
}

function missingPluginDependencies(
  references: readonly PluginReference[],
  dependencies: Readonly<Record<string, string>>,
  manifestPath: string,
): string[] {
  const requiredPackages = new Map<string, Set<string>>()
  for (const reference of references) {
    const packageName = packageNameFromSpecifier(reference.name)
    if (packageName === undefined) continue
    const locations = requiredPackages.get(packageName) ?? new Set<string>()
    locations.add(reference.file)
    requiredPackages.set(packageName, locations)
  }
  return [...requiredPackages].flatMap(([packageName, locations]) => packageName in dependencies
    ? []
    : `${[...locations].join(', ')}: ${packageName} must be declared in ${manifestPath} dependencies`)
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as PackageManifest
}

function localPackageDirectories(): Map<string, string> {
  const manifests = globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: root })
  const packages = new Map<string, string>()
  for (const manifestPath of manifests) {
    const manifest = readManifest(manifestPath)
    if (manifest.name !== undefined) packages.set(manifest.name, resolve(root, dirname(manifestPath)))
  }
  return packages
}

function rootProjectReferences(): Set<string> {
  // The root solution references the host and client aggregates (the two
  // sides merge cordis Context under the same keys, so one program cannot see
  // both — but this BFS only collects reference paths, it never forms a
  // program). Seed the solution and follow nested aggregate references to
  // collect the covered leaf project set.
  const collected = new Set<string>()
  const queue = [resolve(root, 'tsconfig.json')]
  const seen = new Set<string>()
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue
    seen.add(file)
    const config = ts.readConfigFile(file, path => ts.sys.readFile(path))
    if (config.error !== undefined) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
    }
    const references = (config.config as { references?: Array<{ path?: unknown }> }).references ?? []
    for (const reference of references) {
      if (typeof reference.path !== 'string') continue
      const target = resolve(dirname(file), reference.path)
      if (target.endsWith('.json')) queue.push(target)
      else collected.add(target)
    }
  }
  return collected
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || /^[a-z][a-z+.-]*:/i.test(specifier)) return undefined
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined
  }
  return segments[0] || undefined
}

function validateMetadata(entry: Record<string, unknown>, file: string, path: string): void {
  for (const field of metadataFields) {
    if (!(field in entry)) continue
    const expressionPaths: string[] = []
    collectExpressionPaths(entry[field], `${path}.${field}`, expressionPaths)
    for (const expressionPath of expressionPaths) errors.push(`${file}${expressionPath}: !!js is not interpolated here`)
  }
}

function collectExpressionPaths(value: unknown, path: string, output: string[]): void {
  if (isJsExpr(value)) {
    output.push(path)
    return
  }
  if (isUnknownArray(value)) {
    for (let index = 0; index < value.length; index++) collectExpressionPaths(value[index], `${path}[${index}]`, output)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) collectExpressionPaths(child, `${path}.${key}`, output)
}

function isJsExpr(value: unknown): value is JsExpr {
  return isRecord(value) && typeof value.__jsExpr === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}
