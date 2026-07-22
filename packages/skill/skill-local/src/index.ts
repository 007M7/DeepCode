/**
 * Local filesystem skill provider.
 *
 * This package is one implementation of the `ctx.skills` provider registry. It
 * discovers directory-bundle and flat Markdown skills from project, custom, and
 * user roots, parses YAML frontmatter, and loads bodies through `ctx.fs` when a
 * filesystem service is present.
 *
 * @module @deepseek-ai/dsh-skill-local
 */

import { access, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from 'cordis'
import z from 'schemastery'
import type Schema from 'schemastery'
import { parse as parseYaml } from 'yaml'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillSource,
} from '@deepseek-ai/dsh-skill'

const PROJECT_DSH_RANK = 100
const PROJECT_AGENTS_RANK = 200
const CUSTOM_RANK = 300
const USER_DSH_RANK = 400
const USER_AGENTS_RANK = 500

export const name = 'skill-local'
export const inject = ['skills']

/** Local filesystem skill provider configuration. */
export interface Config {
  /** DeepSeek Harness config root. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Shared agent config root. Defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  agentsHome?: string
  /** Additional skill roots scanned after project roots and before user roots. */
  customSkillDirs?: string[]
}

export const Config: Schema<Config> = z.object({
  dshHome: z.string(),
  agentsHome: z.string(),
  customSkillDirs: z.array(z.string()).default([]),
})

interface SkillRoot {
  path: string
  source: SkillSource
  rank: number
  skipSystem?: boolean
}

interface SkillRootEntry {
  name: string
  type: 'directory' | 'file' | 'other'
  path: string
}

interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean
  metadata?: Record<string, unknown>
  content: string
}

interface LocalLocator {
  path: string
  directory: string
}

/** Register the local filesystem skill provider on `ctx.skills`. */
export function apply(ctx: Context, config: Config = {}): void {
  const provider = new LocalSkillProvider(ctx, config)
  ctx.skills.registerProvider(provider)
}

/** Provider that maps local project/user skill roots into `ctx.skills`. */
export class LocalSkillProvider implements SkillProvider {
  readonly name = 'local'
  private readonly dshHome: string
  private readonly agentsHome: string
  private readonly customSkillDirs: string[]

  constructor(private readonly ctx: Context, config: Config = {}) {
    this.dshHome = resolveDshHome(config.dshHome)
    this.agentsHome = resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
    this.customSkillDirs = (config.customSkillDirs ?? []).map(root => resolve(root))
  }

  /**
   * Discover local skill summaries for a cwd-sensitive workspace.
   * @param options - lookup options; `cwd` selects the project roots to scan.
   * @returns local provider candidates with stable root ranks.
   */
  async list(options: SkillLookupOptions): Promise<SkillCandidate[]> {
    const roots = await this.roots(options.cwd)
    const candidates: SkillCandidate[] = []
    for (const root of roots) {
      for (const skill of await discoverRoot(root, this.ctx)) {
        candidates.push(skill)
      }
    }
    return candidates
  }

  /**
   * Load a complete local skill body from the candidate's file locator.
   * @param candidate - the winning candidate returned by this provider.
   * @param options - lookup options whose signal cancels filesystem reads.
   * @returns the full local skill, or `undefined` if the file disappeared.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as LocalLocator
    const parsed = await parseSkillFile(locator.path, this.ctx, options.signal)
    if (parsed === undefined) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      ...parsed.disableModelInvocation !== undefined ? { disableModelInvocation: parsed.disableModelInvocation } : {},
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      ...parsed.metadata !== undefined ? { metadata: parsed.metadata } : {},
      content: parsed.content,
    }
  }

  private async roots(cwd: string | undefined): Promise<SkillRoot[]> {
    const roots: SkillRoot[] = []
    if (cwd !== undefined) {
      const projectRoot = await findProjectRoot(resolve(cwd), optionalFileSystem(this.ctx))
      roots.push(
        { path: join(projectRoot, '.dsh/skills'), source: 'project-dsh', rank: PROJECT_DSH_RANK },
        { path: join(projectRoot, '.agents/skills'), source: 'project-agents', rank: PROJECT_AGENTS_RANK },
      )
    }
    roots.push(
      ...this.customSkillDirs.map(path => ({ path, source: 'custom' as const, rank: CUSTOM_RANK })),
      { path: join(this.dshHome, 'skills'), source: 'user-dsh', rank: USER_DSH_RANK, skipSystem: true },
      { path: join(this.agentsHome, 'skills'), source: 'user-agents', rank: USER_AGENTS_RANK },
    )
    return roots
  }
}

async function discoverRoot(root: SkillRoot, ctx: Context): Promise<SkillCandidate[]> {
  const skills: SkillCandidate[] = []
  const entries = await listSkillRootEntries(root, ctx)
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem && entry.name === '.system') continue
    const locator = entry.type === 'directory'
      ? { path: join(entry.path, 'SKILL.md'), directory: entry.path }
      : entry.type === 'file' && entry.name.endsWith('.md')
        ? { path: entry.path, directory: root.path }
        : undefined
    if (locator === undefined) continue
    const parsed = await parseSkillFile(locator.path, ctx)
    if (parsed === undefined) continue
    skills.push({
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      ...parsed.disableModelInvocation !== undefined ? { disableModelInvocation: parsed.disableModelInvocation } : {},
      provider: 'local',
      source: root.source,
      rank: root.rank,
      locator,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      ...parsed.metadata !== undefined ? { metadata: parsed.metadata } : {},
    })
  }
  return skills
}

async function listSkillRootEntries(root: SkillRoot, ctx: Context): Promise<SkillRootEntry[]> {
  const fs = optionalFileSystem(ctx)
  if (fs !== undefined) return await listSkillRootEntriesFromFileSystem(root, fs)
  return await listSkillRootEntriesFromNode(root, ctx)
}

async function listSkillRootEntriesFromFileSystem(root: SkillRoot, fs: FileSystem): Promise<SkillRootEntry[]> {
  // Skill roots are optional; an absent or unlistable root contributes no skills.
  const entries = await fsListDir(fs, root.path).catch(() => undefined)
  return entries === undefined ? [] : entries.map(entryFromFs)
}

async function fsListDir(fs: FileSystem, path: string): Promise<FsDirEntry[]> {
  const target = await fs.resolve(path)
  return await fs.listDir(target)
}

function entryFromFs(entry: FsDirEntry): SkillRootEntry {
  return { name: entry.name, type: entry.type, path: entry.target.displayPath }
}

async function listSkillRootEntriesFromNode(root: SkillRoot, ctx: Context): Promise<SkillRootEntry[]> {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // Missing or unreadable local skill roots are expected in most deployments.
    return []
  }

  const result: SkillRootEntry[] = []
  for (const entry of entries) {
    const path = join(root.path, entry.name)
    const type = await nodeEntryKind(path, entry, ctx)
    result.push({ name: entry.name, type: type ?? 'other', path })
  }
  return result
}

async function parseSkillFile(path: string, ctx: Context, signal?: AbortSignal): Promise<ParsedSkill | undefined> {
  const raw = await readSkillText(ctx, path, signal)
  signal?.throwIfAborted()
  if (raw === undefined) {
    return undefined
  }
  let parsed
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    ctx.logger.warn(`skill file ${path} ignored: invalid YAML frontmatter: ${errorMessage(error)}`)
    return undefined
  }
  if (!parsed) {
    ctx.logger.warn(`skill file ${path} ignored: missing YAML frontmatter`)
    return undefined
  }
  const name = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (name === undefined || description === undefined) {
    ctx.logger.warn(`skill file ${path} ignored: frontmatter requires name and description`)
    return undefined
  }
  if (!isSkillName(name)) {
    ctx.logger.warn(`skill file ${path} ignored: invalid skill name "${name}"`)
    return undefined
  }
  return {
    name,
    description,
    ...optionalString(parsed.data, 'whenToUse'),
    ...optionalBoolean(parsed.data, 'disableModelInvocation'),
    ...optionalMetadata(parsed.data),
    content: parsed.body.trim(),
  }
}

function optionalFileSystem(ctx: Context): FileSystem | undefined {
  return ctx.get('fs')
}

async function readSkillText(ctx: Context, path: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted()
  const fs = optionalFileSystem(ctx)
  if (fs !== undefined) {
    return await readSkillTextFromFileSystem(ctx, fs, path, signal)
  }
  try {
    return await readFile(path, { encoding: 'utf8', signal })
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
}

async function readSkillTextFromFileSystem(ctx: Context, fs: FileSystem, path: string, signal?: AbortSignal): Promise<string | undefined> {
  // A missing or temporarily inaccessible skill file is not fatal to discovery.
  signal?.throwIfAborted()
  const target = await fs.resolve(path).catch(() => undefined)
  signal?.throwIfAborted()
  if (target === undefined) return undefined
  let info
  try {
    info = await fs.stat(target, signal)
  } catch (error) {
    signal?.throwIfAborted()
    ctx.logger.warn(`skill file ${path} ignored: failed to stat through filesystem service: ${errorMessage(error)}`)
    return undefined
  }
  if (info === undefined || info.type !== 'file') return undefined
  try {
    return await fs.readText(target, signal)
  } catch (error) {
    signal?.throwIfAborted()
    ctx.logger.warn(`skill file ${path} ignored: ${fsReadErrorMessage(target, error)}`)
    return undefined
  }
}

function fsReadErrorMessage(target: FsTarget, error: unknown): string {
  return `failed to read text file at ${target.displayPath}: ${errorMessage(error)}`
}

async function nodeEntryKind(fullPath: string, entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }, ctx: Context): Promise<'directory' | 'file' | undefined> {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  /* v8 ignore next -- Non-file directory entries such as FIFOs are platform-specific and intentionally skipped. */
  if (!entry.isSymbolicLink()) return undefined
  try {
    const info = await stat(fullPath)
    if (info.isDirectory()) return 'directory'
    /* v8 ignore else -- the special-file symlink branch relies on POSIX /dev/null. */
    if (info.isFile()) return 'file'
    /* v8 ignore next -- The special-file symlink fixture relies on POSIX /dev/null. */
    return undefined
  } catch (error) {
    ctx.logger.warn(`skill entry ${fullPath} ignored: failed to follow symbolic link: ${errorMessage(error)}`)
    return undefined
  }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const yaml = raw.slice(start, closing.start)
  const parsed = parseYaml(yaml) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

async function findProjectRoot(cwd: string, fs: FileSystem | undefined): Promise<string> {
  let current = cwd
  while (true) {
    if (await pathExists(join(current, '.git'), fs)) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

async function pathExists(path: string, fs: FileSystem | undefined): Promise<boolean> {
  if (fs !== undefined) {
    return await pathExistsInFileSystem(path, fs)
  }
  return await pathExistsInNode(path)
}

async function pathExistsInFileSystem(path: string, fs: FileSystem): Promise<boolean> {
  let target
  try {
    target = await fs.resolve(path)
  } catch {
    // A backend may reject or hide this candidate; continue walking upward.
    return false
  }
  try {
    return await fs.stat(target) !== undefined
  } catch {
    // Transient stat failures make only this git-root candidate unusable.
    return false
  }
}

async function pathExistsInNode(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // Missing host paths are expected while walking toward the filesystem root.
    return false
  }
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(data: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

function optionalBoolean(data: Record<string, unknown>, key: string): { [K in typeof key]?: boolean } {
  const value = data[key]
  return typeof value === 'boolean' ? { [key]: value } : {}
}

function optionalMetadata(data: Record<string, unknown>): { metadata?: Record<string, unknown> } {
  const value = data.metadata
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { metadata: value as Record<string, unknown> }
  }
  return {}
}

function errorMessage(error: unknown): string {
  return String(error)
}
