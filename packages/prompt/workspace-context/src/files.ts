/**
 * Instruction-file discovery, provider reads, and content-aware caching.
 *
 * @module @deepseek-ai/dsh-workspace-context/files
 */

import { lstat, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FileSystem, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { DEFAULT_DSH_HOME_DISPLAY, defaultDshHome } from '@deepseek-ai/dsh-paths'
import { resolveConfig, resolveDiscoveryConfig, type ResolvedConfig } from './config.ts'
import { instructionContentSha1 } from './digest.ts'
import { renderWorkspaceContext, type RenderedWorkspaceContext } from './render.ts'

/** An instruction candidate identified by absolute and model-facing paths. */
export interface InstructionFile {
  absolutePath: string
  displayPath: string
}

/** An instruction file whose UTF-8 content was read successfully. */
export interface LoadedInstructionFile extends InstructionFile {
  content: string
}

interface FileSignature {
  version: string
}

interface CachedContent extends FileSignature {
  sha1: string
  content: string
}

interface DiscoveredInstructionFile extends InstructionFile {
  signature: FileSignature
  target?: FsTarget
}

/** Provider-version and SHA-1 keyed content cache shared across plugin hooks. */
export type InstructionContentCache = Map<string, CachedContent>

interface DiscoverOptions {
  cwd: string
  dshHome?: string
  projectRootMarkers?: string[]
  instructionFileCandidates?: string[]
}

interface LoadOptions extends DiscoverOptions {
  maxBytes: number
  cache?: InstructionContentCache
}

/** Rendered baseline plus the files that survived byte budgeting. */
export interface RenderedInstructionSet {
  rendered: RenderedWorkspaceContext
  included: LoadedInstructionFile[]
}

/** Tri-state scope probe that distinguishes confirmed absence from provider failure. */
export type ScopeInstructionProbe =
  | { kind: 'present'; file: LoadedInstructionFile }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

async function nodeStatFile(path: string): Promise<FileSignature | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile()) return undefined
    return { version: String(info.mtimeMs) }
  } catch {
    // Candidates can disappear while discovery is in progress.
    return undefined
  }
}

async function fsStatFile(
  path: string,
  fileSystem: FileSystem,
): Promise<DiscoveredInstructionFile['signature'] & { target: FsTarget } | undefined> {
  try {
    const pathInfo = await fileSystem.lstat(path)
    if (pathInfo?.type !== 'file') return undefined
    const target = await fileSystem.resolve(path)
    const info = await fileSystem.stat(target)
    if (info?.type !== 'file') return undefined
    return { version: info.version, target }
  } catch {
    // Provider absence and discovery races are both non-fatal.
    return undefined
  }
}

async function statFile(
  path: string,
  fileSystem?: FileSystem,
): Promise<(DiscoveredInstructionFile['signature'] & { target?: FsTarget }) | undefined> {
  return fileSystem === undefined ? nodeStatFile(path) : fsStatFile(path, fileSystem)
}

async function existsAsMarker(path: string, fileSystem?: FileSystem): Promise<boolean> {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path)
      return await fileSystem.stat(target) !== undefined
    } catch {
      return false
    }
  }
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Walk upward to the first directory containing a configured root marker.
 * @param cwd - absolute session working directory where the walk begins.
 * @param markers - child names that identify a project root.
 * @param fileSystem - optional provider used instead of host filesystem probes.
 * @returns the discovered project root, or `cwd` when no marker exists.
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fileSystem?: FileSystem,
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await existsAsMarker(join(current, marker), fileSystem)) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Build the inclusive root-to-cwd directory chain.
 * @param root - root directory expected to contain or equal `cwd`.
 * @param cwd - most-specific directory in the chain.
 * @returns directories ordered from broadest to most specific.
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    /* v8 ignore next -- discovery always supplies cwd or an ancestor root. */
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * Find descendant directories crossed between a cwd and a touched file.
 * @param root - session cwd that bounds nested discovery.
 * @param touchedPath - absolute path or path relative to `root`.
 * @returns descendant directories from shallowest through the touched file's parent.
 */
export function descendantDirsBetween(root: string, touchedPath: string): string[] {
  const resolvedRoot = resolve(root)
  const targetPath = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(resolvedRoot, touchedPath)
  const targetDir = dirname(targetPath)
  const rel = relative(resolvedRoot, targetDir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  return ancestorChain(resolvedRoot, targetDir).slice(1)
}

/**
 * Convert an absolute instruction path to its project-root-relative display form.
 * @param root - project root used as the display base.
 * @param path - absolute path to display.
 * @returns the root-relative path.
 */
export function relativeDisplay(root: string, path: string): string {
  return relative(root, path)
}

async function firstExistingInstructionFile(
  dir: string,
  root: string,
  instructionFileCandidates: readonly string[],
  fileSystem?: FileSystem,
): Promise<DiscoveredInstructionFile | undefined> {
  for (const candidate of instructionFileCandidates) {
    const path = join(dir, candidate)
    const fileSignature = await statFile(path, fileSystem)
    if (fileSignature !== undefined) {
      const { target, ...signature } = fileSignature
      return {
        absolutePath: path,
        displayPath: relativeDisplay(root, path),
        signature,
        ...target === undefined ? {} : { target },
      }
    }
  }
  return undefined
}

async function discoverInstructionFiles(
  options: DiscoverOptions,
  fileSystem?: FileSystem,
): Promise<DiscoveredInstructionFile[]> {
  const config = resolveDiscoveryConfig(options)
  const files: DiscoveredInstructionFile[] = []
  const seen = new Set<string>()
  const addFile = (file: DiscoveredInstructionFile): void => {
    if (seen.has(file.absolutePath)) return
    seen.add(file.absolutePath)
    files.push(file)
  }

  const userGlobal = join(config.dshHome, 'AGENTS.md')
  const userGlobalSignature = await statFile(userGlobal, fileSystem)
  if (userGlobalSignature !== undefined) {
    const { target, ...signature } = userGlobalSignature
    addFile({
      absolutePath: userGlobal,
      displayPath: userGlobalDisplayPath(config.dshHome),
      signature,
      ...target === undefined ? {} : { target },
    })
  }

  const cwd = resolve(options.cwd)
  const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers, fileSystem)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    const file = await firstExistingInstructionFile(dir, projectRoot, config.instructionFileCandidates, fileSystem)
    if (file !== undefined) addFile(file)
  }
  return files
}

/**
 * Discover host-visible user-global and root-to-cwd instruction candidates.
 * @param options - cwd, home, root marker, and candidate configuration.
 * @returns de-duplicated instruction paths in model precedence order.
 */
export async function discoverBaselineInstructionFiles(options: DiscoverOptions): Promise<InstructionFile[]> {
  return (await discoverInstructionFiles(options)).map(({ absolutePath, displayPath }) => ({ absolutePath, displayPath }))
}

async function readCached(
  file: DiscoveredInstructionFile,
  cache: InstructionContentCache,
  fileSystem?: FileSystem,
): Promise<string | undefined> {
  const path = file.absolutePath
  const { signature } = file
  try {
    const content = fileSystem === undefined || file.target === undefined
      ? await readFile(path, 'utf8')
      : await fileSystem.readText(file.target)
    const sha1 = instructionContentSha1(content)
    const cached = cache.get(path)
    if (cached !== undefined && cached.version === signature.version && cached.sha1 === sha1) return cached.content
    cache.set(path, { ...signature, sha1, content })
    return content
  } catch {
    // A file may disappear or become unreadable after its metadata probe.
    return undefined
  }
}

/**
 * Discover, read, and render the baseline instruction chain.
 * @param options - discovery, byte-budget, and optional cache configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered baseline context, or undefined when nothing can be loaded.
 */
export async function loadBaselineInstructions(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedWorkspaceContext | undefined> {
  return (await loadBaselineInstructionSet(options, fileSystem))?.rendered
}

/**
 * Load a baseline together with the files retained after rendering.
 * @param options - discovery, byte-budget, and optional cache configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered context and retained files, or undefined when empty or disabled.
 */
export async function loadBaselineInstructionSet(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedInstructionSet | undefined> {
  const config = resolveConfig(options)
  if (config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
  const cache = options.cache ?? new Map<string, CachedContent>()
  const discovered = await discoverInstructionFiles(options, fileSystem)
  const loaded: LoadedInstructionFile[] = []
  for (const file of discovered) {
    const content = await readCached(file, cache, fileSystem)
    if (content !== undefined) loaded.push({ absolutePath: file.absolutePath, displayPath: file.displayPath, content })
  }
  if (loaded.length === 0) return undefined
  const rendered = renderWorkspaceContext(loaded, { maxBytes: config.maxBytes })
  const omitted = new Set(rendered.omitted.map(file => file.absolutePath))
  return { rendered, included: loaded.filter(file => !omitted.has(file.absolutePath)) }
}

/**
 * Probe the current first-winning instruction candidate for one logical scope.
 * @param scope - `user-global`, `.`, or a project-relative directory.
 * @param projectRoot - project root used to resolve and display project scopes.
 * @param resolved - normalized plugin configuration.
 * @param cache - shared content cache.
 * @param fileSystem - provider used for no-follow probing and reading.
 * @returns present content, confirmed absence, or temporary unavailability.
 */
export async function loadScopeInstruction(
  scope: string,
  projectRoot: string,
  resolved: ResolvedConfig,
  cache: InstructionContentCache,
  fileSystem: FileSystem,
): Promise<ScopeInstructionProbe> {
  const dir = scope === 'user-global'
    ? resolved.dshHome
    : scope === '.' ? projectRoot : join(projectRoot, scope)
  const candidates = scope === 'user-global' ? ['AGENTS.md'] : resolved.instructionFileCandidates
  for (const candidate of candidates) {
    const absolutePath = join(dir, candidate)
    let pathInfo: FsPathInfo | undefined
    try {
      pathInfo = await fileSystem.lstat(absolutePath)
    } catch {
      return { kind: 'unavailable' }
    }
    if (pathInfo === undefined || pathInfo.type !== 'file') continue
    let target: FsTarget
    let info: FsInfo | undefined
    try {
      target = await fileSystem.resolve(absolutePath)
      info = await fileSystem.stat(target)
    } catch {
      return { kind: 'unavailable' }
    }
    if (info?.type !== 'file') return { kind: 'unavailable' }
    const discovered: DiscoveredInstructionFile = {
      absolutePath,
      displayPath: scope === 'user-global' ? userGlobalDisplayPath(resolved.dshHome) : relativeDisplay(projectRoot, absolutePath),
      signature: { version: info.version },
      target,
    }
    const content = await readCached(discovered, cache, fileSystem)
    if (content === undefined) return { kind: 'unavailable' }
    return { kind: 'present', file: { absolutePath, displayPath: discovered.displayPath, content } }
  }
  return { kind: 'absent' }
}

function userGlobalDisplayPath(dshHome: string): string {
  return dshHome === resolve(defaultDshHome()) ? `${DEFAULT_DSH_HOME_DISPLAY}/AGENTS.md` : '$DSH_HOME/AGENTS.md'
}
