/**
 * Node module resolve hook for the `dsh` source launcher. It projects the root
 * tsconfig `paths` map into Node resolution while leaving all TypeScript syntax
 * handling to Node's native transform-types runtime.
 * @module @deepseek-ai/dsh/tsconfig-paths-loader
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ResolveHookContext, ResolveFnOutput } from 'node:module'
import ts from 'typescript'

interface LoaderData {
  tsconfigPath: string
}

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface PathRule {
  pattern: string
  prefix: string
  suffix: string
  targets: readonly string[]
}

interface PathsCompilerOptions {
  readonly baseUrl?: string
  readonly paths?: ts.MapLike<string[]>
  readonly pathsBasePath?: string
}

// Node's native TypeScript transform cannot parse JSX, so `.tsx` is excluded.
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts'] as const

/**
 * Resolve package imports through one parsed tsconfig paths table.
 *
 * Manifest reads are process-scoped and memoized by path. Only matched source
 * aliases enter the cache, bounding it to directories participating in source
 * resolution.
 */
export class TsconfigPathsResolver {
  private readonly rules: readonly PathRule[]
  private readonly configDirectory: string
  private readonly manifests = new Map<string, Promise<PackageManifest | undefined>>()

  private constructor(configDirectory: string, paths: ts.MapLike<string[]>) {
    this.configDirectory = configDirectory
    this.rules = Object.entries(paths)
      .map(([pattern, targets]) => {
        const wildcard = pattern.indexOf('*')
        return {
          pattern,
          prefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
          suffix: wildcard === -1 ? '' : pattern.slice(wildcard + 1),
          targets,
        }
      })
      .sort((left, right) => {
        const leftExact = left.pattern.includes('*') ? 0 : 1
        const rightExact = right.pattern.includes('*') ? 0 : 1
        return rightExact - leftExact || right.prefix.length - left.prefix.length || right.suffix.length - left.suffix.length
      })
  }

  /**
   * Parse a tsconfig including its `extends` chain.
   * @param tsconfigPath Absolute tsconfig path supplying `compilerOptions.paths`.
   * @returns A resolver backed by that path table.
   */
  static create(tsconfigPath: string): TsconfigPathsResolver {
    let unrecoverable: ts.Diagnostic | undefined
    const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) { unrecoverable = diagnostic },
    })
    if (parsed === undefined) {
      const detail = unrecoverable === undefined
        ? 'unknown configuration error'
        : ts.flattenDiagnosticMessageText(unrecoverable.messageText, '\n')
      throw new Error(`dsh source loader could not parse ${tsconfigPath}: ${detail}`)
    }
    const options = parsed.options as PathsCompilerOptions
    const paths = options.paths
    if (paths === undefined) throw new Error(`dsh source loader requires compilerOptions.paths in ${tsconfigPath}`)
    const configDirectory = options.baseUrl ?? options.pathsBasePath ?? dirname(tsconfigPath)
    return new TsconfigPathsResolver(configDirectory, paths)
  }

  /**
   * Resolve one bare package specifier to a source file when the importing
   * package (or config-directory owner) declares that package at runtime.
   * @param specifier Module specifier passed to Node.
   * @param parentURL Importing file or Loader config-directory URL.
   * @returns Source file URL, or `undefined` when normal Node resolution owns the request.
   */
  async resolve(specifier: string, parentURL: string | undefined): Promise<string | undefined> {
    const packageName = packageNameFromSpecifier(specifier)
    if (packageName === undefined || parentURL === undefined || !parentURL.startsWith('file:')) return undefined
    const matched = this.match(specifier)
    if (matched === undefined) return undefined
    const configParent = parentURL.endsWith('/')
    const parentPath = fileURLToPath(parentURL)
    const startDirectory = configParent ? parentPath : dirname(parentPath)
    if (!await this.isDeclaredRuntimeDependency(startDirectory, packageName, configParent)) return undefined

    for (const target of matched.targets) {
      const substituted = target.replace('*', matched.wildcard)
      const candidate = await existingSourcePath(resolve(this.configDirectory, substituted))
      if (candidate !== undefined) return pathToFileURL(candidate).href
    }
    return undefined
  }

  private match(specifier: string): { targets: readonly string[]; wildcard: string } | undefined {
    for (const rule of this.rules) {
      if (!rule.pattern.includes('*')) {
        if (specifier === rule.pattern) return { targets: rule.targets, wildcard: '' }
        continue
      }
      if (!specifier.startsWith(rule.prefix) || !specifier.endsWith(rule.suffix)) continue
      const wildcard = specifier.slice(rule.prefix.length, specifier.length - rule.suffix.length)
      return { targets: rule.targets, wildcard }
    }
    return undefined
  }

  private async isDeclaredRuntimeDependency(
    startDirectory: string,
    packageName: string,
    searchAncestors: boolean,
  ): Promise<boolean> {
    for (let directory = startDirectory; ; directory = dirname(directory)) {
      const manifest = await this.readManifest(join(directory, 'package.json'))
      if (manifest !== undefined) {
        if (declaresRuntimeDependency(manifest, packageName)) return true
        if (!searchAncestors) return false
      }
      const parent = dirname(directory)
      if (parent === directory) return false
    }
  }

  private readManifest(path: string): Promise<PackageManifest | undefined> {
    let pending = this.manifests.get(path)
    if (pending !== undefined) return pending
    pending = readFile(path, 'utf8').then(
      content => JSON.parse(content) as PackageManifest,
      (error: unknown) => {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      },
    )
    this.manifests.set(path, pending)
    return pending
  }
}

let resolver: TsconfigPathsResolver | undefined

/** Initialize the hook worker from the source-launch preloader. */
export function initialize(data: LoaderData): void {
  resolver = TsconfigPathsResolver.create(data.tsconfigPath)
}

/** Resolve declared workspace packages to source and delegate every other request to Node. */
export async function resolveHook(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: (specifier: string, context: ResolveHookContext) => Promise<ResolveFnOutput>,
): Promise<ResolveFnOutput> {
  const url = await resolver?.resolve(specifier, context.parentURL)
  return url === undefined ? nextResolve(specifier, context) : { url, shortCircuit: true }
}

// Node customization hooks discover this exact export name.
export { resolveHook as resolve }

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || /^[a-z][a-z+.-]*:/i.test(specifier)) {
    return undefined
  }
  const segments = specifier.split('/')
  return specifier.startsWith('@')
    ? segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined
    : segments[0] || undefined
}

function declaresRuntimeDependency(manifest: PackageManifest, packageName: string): boolean {
  return manifest.name === packageName
    || packageName in (manifest.dependencies ?? {})
    || packageName in (manifest.optionalDependencies ?? {})
    || packageName in (manifest.peerDependencies ?? {})
}

async function existingSourcePath(base: string): Promise<string | undefined> {
  const extension = extname(base)
  if (extension === '.tsx') return undefined
  const candidates = extension === ''
    ? [base, ...SOURCE_EXTENSIONS.map(extension => `${base}${extension}`), ...SOURCE_EXTENSIONS.map(extension => join(base, `index${extension}`))]
    : [base]
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}
