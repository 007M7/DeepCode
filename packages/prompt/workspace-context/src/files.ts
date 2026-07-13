/**
 * Instruction-file discovery and bounded, abort-aware provider reads.
 *
 * @module @deepseek-ai/dsh-workspace-context/files
 */

import { createReadStream } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FileSystem, FsInfo, FsPathInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { DEFAULT_DSH_HOME_DISPLAY, defaultDshHome } from '@deepseek-ai/dsh-paths'
import { resolveConfig, resolveDiscoveryConfig, type ResolvedConfig } from './config.ts'
import { renderWorkspaceContext, type RenderedWorkspaceContext } from './render.ts'

/** An instruction candidate identified by absolute and model-facing paths. */
export interface InstructionFile {
  absolutePath: string
  displayPath: string
}

/** An instruction file whose UTF-8 content was read successfully. */
export interface LoadedInstructionFile extends InstructionFile {
  content: string
  /** Provider freshness token when the file was loaded through `ctx.fs`. */
  version?: FsVersion
}

interface DiscoveredInstructionFile extends InstructionFile {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

/** Provider metadata for a winning scope candidate before its content is read. */
export interface ProbedInstructionFile extends InstructionFile {
  target: FsTarget
  version: FsVersion
  size?: number
}

interface DiscoverOptions {
  cwd: string
  dshHome?: string
  projectRootMarkers?: string[]
  instructionFileCandidates?: string[]
  signal?: AbortSignal
}

interface LoadOptions extends DiscoverOptions {
  maxBytes: number
  maxSourceBytes?: number
}

/** Rendered baseline plus the files that survived byte budgeting. */
export interface RenderedInstructionSet {
  rendered: RenderedWorkspaceContext
  included: LoadedInstructionFile[]
}

/** Tri-state scope probe that distinguishes confirmed absence from provider failure. */
export type ScopeInstructionProbe =
  | { kind: 'present'; file: ProbedInstructionFile }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

function signalOptions(signal?: AbortSignal): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal }
}

async function nodeStatFile(path: string, signal?: AbortSignal): Promise<{ size: number } | undefined> {
  try {
    signal?.throwIfAborted()
    const info = await lstat(path)
    signal?.throwIfAborted()
    if (!info.isFile()) return undefined
    return { size: info.size }
  } catch {
    signal?.throwIfAborted()
    // Candidates can disappear while discovery is in progress.
    return undefined
  }
}

async function fsStatFile(
  path: string,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<{ target: FsTarget; size?: number; version: FsVersion } | undefined> {
  try {
    const pathInfo = await fileSystem.lstat(path, undefined, signal)
    if (pathInfo?.type !== 'file') return undefined
    const target = await fileSystem.resolve(path, signalOptions(signal))
    const info = await fileSystem.stat(target, signal)
    if (info?.type !== 'file') return undefined
    return { target, version: info.version, ...info.size === undefined ? {} : { size: info.size } }
  } catch {
    signal?.throwIfAborted()
    // Provider absence and discovery races are both non-fatal.
    return undefined
  }
}

async function statFile(
  path: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<{ target?: FsTarget; size?: number; version?: FsVersion } | undefined> {
  return fileSystem === undefined ? nodeStatFile(path, signal) : fsStatFile(path, fileSystem, signal)
}

async function existsAsMarker(path: string, fileSystem?: FileSystem, signal?: AbortSignal): Promise<boolean> {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path, signalOptions(signal))
      return await fileSystem.stat(target, signal) !== undefined
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }
  try {
    signal?.throwIfAborted()
    await stat(path)
    signal?.throwIfAborted()
    return true
  } catch {
    signal?.throwIfAborted()
    return false
  }
}

/**
 * Walk upward to the first directory containing a configured root marker.
 * @param cwd - absolute session working directory where the walk begins.
 * @param markers - child names that identify a project root.
 * @param fileSystem - optional provider used instead of host filesystem probes.
 * @param signal - cancellation for provider and host probes.
 * @returns the discovered project root, or `cwd` when no marker exists.
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current
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
  signal?: AbortSignal,
): Promise<DiscoveredInstructionFile | undefined> {
  for (const candidate of instructionFileCandidates) {
    const path = join(dir, candidate)
    const fileInfo = await statFile(path, fileSystem, signal)
    if (fileInfo !== undefined) {
      return {
        absolutePath: path,
        displayPath: relativeDisplay(root, path),
        ...fileInfo,
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
  const userGlobalInfo = await statFile(userGlobal, fileSystem, options.signal)
  if (userGlobalInfo !== undefined) {
    addFile({
      absolutePath: userGlobal,
      displayPath: userGlobalDisplayPath(config.dshHome),
      ...userGlobalInfo,
    })
  }

  const cwd = resolve(options.cwd)
  const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers, fileSystem, options.signal)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    const file = await firstExistingInstructionFile(dir, projectRoot, config.instructionFileCandidates, fileSystem, options.signal)
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

async function* nodeTextChunks(path: string, signal?: AbortSignal): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8', signal })
  for await (const chunk of stream) yield String(chunk)
}

async function readBounded(
  file: DiscoveredInstructionFile,
  maxSourceBytes: number,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  if (file.size !== undefined && file.size > maxSourceBytes) return undefined
  try {
    const chunks = fileSystem === undefined || file.target === undefined
      ? nodeTextChunks(file.absolutePath, signal)
      : await fileSystem.streamText(file.target, signal)
    const parts: string[] = []
    let bytes = 0
    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxSourceBytes) return undefined
      parts.push(chunk)
    }
    signal?.throwIfAborted()
    return parts.join('')
  } catch {
    signal?.throwIfAborted()
    // A file may disappear or become unreadable after its metadata probe.
    return undefined
  }
}

/**
 * Discover, read, and render the baseline instruction chain.
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
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
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered context and retained files, or undefined when empty or disabled.
 */
export async function loadBaselineInstructionSet(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedInstructionSet | undefined> {
  const config = resolveConfig(options)
  if (config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
  if (config.maxSourceBytes <= 0 || !Number.isFinite(config.maxSourceBytes)) return undefined
  const discovered = await discoverInstructionFiles(options, fileSystem)
  const loaded: LoadedInstructionFile[] = []
  for (const file of discovered) {
    const content = await readBounded(file, config.maxSourceBytes, fileSystem, options.signal)
    if (content !== undefined) {
      loaded.push({
        absolutePath: file.absolutePath,
        displayPath: file.displayPath,
        content,
        ...file.version === undefined ? {} : { version: file.version },
      })
    }
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
 * @param fileSystem - provider used for no-follow probing.
 * @param signal - cancellation for provider probes.
 * @returns present metadata, confirmed absence, or temporary unavailability.
 */
export async function probeScopeInstruction(
  scope: string,
  projectRoot: string,
  resolved: ResolvedConfig,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<ScopeInstructionProbe> {
  const dir = scope === 'user-global'
    ? resolved.dshHome
    : scope === '.' ? projectRoot : join(projectRoot, scope)
  const candidates = scope === 'user-global' ? ['AGENTS.md'] : resolved.instructionFileCandidates
  for (const candidate of candidates) {
    const absolutePath = join(dir, candidate)
    let pathInfo: FsPathInfo | undefined
    try {
      pathInfo = await fileSystem.lstat(absolutePath, undefined, signal)
    } catch {
      signal?.throwIfAborted()
      return { kind: 'unavailable' }
    }
    if (pathInfo === undefined || pathInfo.type !== 'file') continue
    let target: FsTarget
    let info: FsInfo | undefined
    try {
      target = await fileSystem.resolve(absolutePath, signalOptions(signal))
      info = await fileSystem.stat(target, signal)
    } catch {
      signal?.throwIfAborted()
      return { kind: 'unavailable' }
    }
    if (info?.type !== 'file') return { kind: 'unavailable' }
    const file: ProbedInstructionFile = {
      absolutePath,
      displayPath: scope === 'user-global' ? userGlobalDisplayPath(resolved.dshHome) : relativeDisplay(projectRoot, absolutePath),
      target,
      version: info.version,
      ...info.size === undefined ? {} : { size: info.size },
    }
    return { kind: 'present', file }
  }
  return { kind: 'absent' }
}

/**
 * Read one already-probed scope candidate under the configured source cap.
 * @param file - winning provider candidate and its metadata snapshot.
 * @param maxSourceBytes - maximum UTF-8 bytes accepted from the source.
 * @param fileSystem - provider used for the streaming read.
 * @param signal - cancellation for provider streaming.
 * @returns loaded content with the probed version, or undefined when unavailable.
 */
export async function readScopeInstruction(
  file: ProbedInstructionFile,
  maxSourceBytes: number,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<LoadedInstructionFile | undefined> {
  const content = await readBounded(file, maxSourceBytes, fileSystem, signal)
  if (content === undefined) return undefined
  return {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    content,
    version: file.version,
  }
}

function userGlobalDisplayPath(dshHome: string): string {
  return dshHome === resolve(defaultDshHome()) ? `${DEFAULT_DSH_HOME_DISPLAY}/AGENTS.md` : '$DSH_HOME/AGENTS.md'
}
