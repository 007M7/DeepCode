/**
 * Agent skill discovery and prompt listing.
 *
 * Skills are progressive-disclosure instructions: the model sees only a short
 * listing in the system prompt, then calls the `skill` tool to load the full
 * `SKILL.md` body when a task matches.
 *
 * @module @deepseek-ai/dsh-skill
 */

import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Context, Service } from 'cordis'
import z from 'schemastery'
import type Schema from 'schemastery'
import { parse as parseYaml } from 'yaml'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_PROMPT_FIELD_LENGTH = 500
const DEFAULT_COLLECT_CACHE_ENTRIES = 128

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** Origin bucket for a discovered skill. The value is prompt-visible metadata, not part of precedence by itself. */
export type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'extra' | 'system'

/** Model-visible skill metadata returned by `ctx.skills.list()` and rendered into the request prompt. */
export interface SkillSummary {
  /** Kebab-case identifier used with the `skill` tool. */
  name: string
  /** Short routing description shown to the model. */
  description: string
  /** Optional extra routing guidance shown to the model. */
  whenToUse?: string
  /** Whether the skill is hidden from model listings while remaining loadable by trusted callers. */
  disableModelInvocation?: boolean
  /** Base directory for resolving skill-relative references. */
  directory: string
  /** Discovery source that produced this winning skill. */
  source: SkillSource
}

/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
export interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after frontmatter removal. */
  content: string
  /** Absolute file path when the skill came from disk; runtime skills may omit it. */
  path?: string
  /** Parsed optional metadata object from frontmatter. */
  metadata?: Record<string, unknown>
}

/** Runtime skill contribution accepted by `ctx.skills.register()`. */
export type SkillRegistration = Omit<SkillDefinition, 'disableModelInvocation'> & { disableModelInvocation?: boolean }

/** Workspace selector used for cwd-sensitive project-root discovery. */
export interface SkillLookupOptions {
  cwd?: string | undefined
}

/** Skill plugin configuration. */
export interface Config {
  /** DeepSeek Harness config root. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Shared agent config root. Defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  agentsHome?: string
  /** Extra skill roots, scanned after user roots and before system skills. */
  extraRoots?: string[]
  /** Ensure bundled system skills exist under `<dshHome>/skills/.system`. Defaults true. */
  installSystemSkills?: boolean
  /** Maximum rendered description/whenToUse length in the prompt listing. */
  promptFieldMaxLength?: number
  /** Maximum number of cwd/root discovery promises kept in the in-memory cache. */
  collectCacheMaxEntries?: number
}

declare module 'cordis' {
  interface Context {
    skills: SkillService
  }
}

interface SkillRoot {
  path: string
  source: SkillSource
  skipSystem?: boolean
}

const SYSTEM_SKILLS: SkillDefinition[] = [
  {
    name: 'dsh-plugin-creator',
    description: 'Create or update DeepSeek Harness Cordis plugins and packages.',
    directory: 'system://dsh-plugin-creator',
    source: 'system',
    content: [
      'Use this skill to create DeepSeek Harness plugins that fit the repository architecture.',
      '',
      'Prefer Cordis services, plugin packages, effect-scoped registrations, and existing extension seams over loop changes.',
      'When adding a swappable capability, design the interface/implementation/consumer split first.',
      'Every registry or registration path needs disposal/HMR coverage.',
      'Update package docs, architecture docs, package graph references, and generated catalogs when public surfaces change.',
    ].join('\n'),
  },
  {
    name: 'dsh-skill-creator',
    description: 'Create or update DeepSeek Harness SKILL.md instructions.',
    whenToUse: 'Use when writing reusable agent instructions for DeepSeek Harness or adding system/project/user skills.',
    directory: 'system://dsh-skill-creator',
    source: 'system',
    content: [
      'Use this skill to write focused DeepSeek Harness skills.',
      '',
      'A skill is a directory `<name>/SKILL.md` or a flat `<name>.md` file with YAML frontmatter.',
      'Frontmatter must include kebab-case `name` and a concise `description` that tells the model when to load it.',
      'Use optional `whenToUse` for extra routing signal and `disableModelInvocation: true` for user-only skills.',
      'Keep the body procedural, evidence-oriented, and scoped to the workflow the skill owns.',
    ].join('\n'),
  },
]

/**
 * Skill discovery service. It scans project/user/system skill roots, exposes
 * model-visible summaries, loads full skill bodies on demand, and injects the
 * stable `## Skills` listing into each agent request.
 */
export class SkillService extends Service {
  static Config: Schema<Config> = z.object({
    dshHome: z.string(),
    agentsHome: z.string(),
    extraRoots: z.array(z.string()).default([]),
    installSystemSkills: z.boolean().default(true),
    promptFieldMaxLength: z.number().default(DEFAULT_PROMPT_FIELD_LENGTH),
    collectCacheMaxEntries: z.number().default(DEFAULT_COLLECT_CACHE_ENTRIES),
  })

  private readonly dshHome: string
  private readonly agentsHome: string
  private readonly extraRoots: string[]
  private readonly installSystemSkills: boolean
  private readonly promptFieldMaxLength: number
  private readonly collectCacheMaxEntries: number
  private readonly runtime = new Map<string, SkillDefinition>()
  private readonly collectCache = new Map<string, Promise<SkillDefinition[]>>()
  private runtimeRevision = 0
  private systemReady: Promise<void> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skills')
    this.dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
    this.agentsHome = resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
    this.extraRoots = (config.extraRoots ?? []).map(root => resolve(root))
    this.installSystemSkills = config.installSystemSkills ?? true
    this.promptFieldMaxLength = config.promptFieldMaxLength ?? DEFAULT_PROMPT_FIELD_LENGTH
    this.collectCacheMaxEntries = config.collectCacheMaxEntries ?? DEFAULT_COLLECT_CACHE_ENTRIES
    assertPositiveInteger('promptFieldMaxLength', this.promptFieldMaxLength)
    assertPositiveInteger('collectCacheMaxEntries', this.collectCacheMaxEntries)
    if (this.installSystemSkills) {
      const systemRoot = join(this.dshHome, 'skills/.system')
      this.systemReady = writeSystemSkills(systemRoot, this.ctx).catch((error: unknown) => {
        this.ctx.logger.warn(`failed to install bundled system skills under ${systemRoot}: ${errorMessage(error)}`)
      })
    }

    ctx.on('agent/request', async (agent, _turn, _step, _request, next) => {
      const listing = await this.renderModelListing({ cwd: agent.session.header.cwd })
      const result = await next()
      if (listing.length > 0) appendSystem(result, listing)
      return result
    })
  }

  /**
   * Register a runtime skill contribution.
   * @param skill - the complete skill definition to expose for discovery.
   * @returns a disposer that removes the runtime skill and invalidates caches.
   */
  register(skill: SkillRegistration): () => void {
    const normalized = normalizeSkill(skill)
    const dispose = this.ctx.effect(function* (this: SkillService) {
      this.runtime.set(normalized.name, normalized)
      this.invalidateCache()
      yield () => {
        this.runtime.delete(normalized.name)
        this.invalidateCache()
      }
    }.bind(this), 'skills.register()')
    return () => void dispose()
  }

  /**
   * List model-invocable skill summaries for a workspace.
   * @param options - lookup options; `cwd` selects the project roots to scan.
   * @returns sorted summaries, excluding skills disabled for model invocation.
   */
  async list(options: SkillLookupOptions = {}): Promise<SkillSummary[]> {
    return (await this.collect(options))
      .filter(skill => skill.disableModelInvocation !== true)
      .map(toSummary)
      .sort(compareSummary)
  }

  /**
   * Load one full skill definition by name.
   * @param name - kebab-case skill name.
   * @param options - lookup options; `cwd` selects the project roots to scan.
   * @returns the full skill, including body content, or `undefined`.
   */
  async get(name: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (!isSkillName(name)) return undefined
    return (await this.collect(options)).find(skill => skill.name === name)
  }

  /**
   * Render the request-time `## Skills` prompt fragment.
   * @param options - lookup options; `cwd` selects the project roots to scan.
   * @returns an empty string when no model-invocable skills are available.
   */
  async renderModelListing(options: SkillLookupOptions = {}): Promise<string> {
    const skills = await this.list(options)
    if (skills.length === 0) return ''
    const entries = skills.map((skill) => {
      const lines = [
        `<skill name="${escapeAttr(skill.name)}" source="${escapeAttr(skill.source)}">`,
        `description: ${promptLine(skill.description, this.promptFieldMaxLength)}`,
        ...skill.whenToUse ? [`whenToUse: ${promptLine(skill.whenToUse, this.promptFieldMaxLength)}`] : [],
        '</skill>',
      ]
      return lines.join('\n')
    }).join('\n')
    return [
      '## Skills',
      'Available skills are listed below. Load a skill with the `skill` tool before following its instructions; do not infer or follow instructions from a skill body that has not been loaded.',
      '<available_skills>',
      entries,
      '</available_skills>',
    ].join('\n')
  }

  private async collect(options: SkillLookupOptions): Promise<SkillDefinition[]> {
    await this.ensureSystemSkills()
    const roots = await this.roots(options.cwd)
    const key = collectCacheKey(roots, this.runtimeRevision)
    const cached = this.collectCache.get(key)
    if (cached !== undefined) return cached

    const collected = this.collectFresh(roots)
    const cachedPromise = collected.catch((error: unknown) => {
      this.collectCache.delete(key)
      throw error
    })
    this.collectCache.set(key, cachedPromise)
    if (this.collectCache.size > this.collectCacheMaxEntries) {
      const oldest = this.collectCache.keys().next() as IteratorYieldResult<string>
      this.collectCache.delete(oldest.value)
    }
    return cachedPromise
  }

  private async collectFresh(roots: { project: SkillRoot[]; shared: SkillRoot[] }): Promise<SkillDefinition[]> {
    const seen = new Set<string>()
    const result: SkillDefinition[] = []

    const add = (skill: SkillDefinition): void => {
      if (seen.has(skill.name)) {
        this.ctx.logger.warn(`skill "${skill.name}" from ${skill.directory} ignored because a higher-priority skill already exists`)
        return
      }
      seen.add(skill.name)
      result.push(skill)
    }

    for (const root of roots.project) {
      for (const skill of await discoverRoot(root, this.ctx)) add(skill)
    }
    for (const skill of [...this.runtime.values()].sort((a, b) => a.name.localeCompare(b.name))) add(skill)
    for (const root of roots.shared) {
      for (const skill of await discoverRoot(root, this.ctx)) add(skill)
    }
    return result
  }

  private async roots(cwd: string | undefined): Promise<{ project: SkillRoot[]; shared: SkillRoot[] }> {
    const project: SkillRoot[] = []
    if (cwd !== undefined) {
      const projectRoot = await findProjectRoot(resolve(cwd))
      project.push(
        { path: join(projectRoot, '.dsh/skills'), source: 'project-dsh' },
        { path: join(projectRoot, '.agents/skills'), source: 'project-agents' },
      )
    }
    const shared: SkillRoot[] = [
      { path: join(this.dshHome, 'skills'), source: 'user-dsh', skipSystem: true },
      { path: join(this.agentsHome, 'skills'), source: 'user-agents' },
      ...this.extraRoots.map(path => ({ path, source: 'extra' as const })),
      { path: join(this.dshHome, 'skills/.system'), source: 'system' },
    ]
    return { project, shared }
  }

  private ensureSystemSkills(): Promise<void> {
    return this.systemReady ?? Promise.resolve()
  }

  private invalidateCache(): void {
    this.runtimeRevision += 1
    this.collectCache.clear()
  }
}

async function writeSystemSkills(systemRoot: string, ctx: Context): Promise<void> {
  await Promise.all(SYSTEM_SKILLS.map(async (skill) => {
    const dir = join(systemRoot, skill.name)
    const file = join(dir, 'SKILL.md')
    if (await skillFileExists(ctx, file)) {
      return
    }
    await writeSkillText(ctx, file, renderSkillFile(skill))
    ctx.logger.debug(`installed system skill ${skill.name} at ${file}`)
  }))
}

function renderSkillFile(skill: SkillDefinition): string {
  const frontmatter = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    ...skill.whenToUse ? [`whenToUse: ${skill.whenToUse}`] : [],
    '---',
    '',
  ]
  return `${frontmatter.join('\n')}${skill.content}\n`
}

async function discoverRoot(root: SkillRoot, ctx: Context): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []
  const entries = await listSkillRootEntries(root, ctx)
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem && entry.name === '.system') continue
    const parsed = entry.type === 'directory'
      ? await parseSkillFile(join(entry.path, 'SKILL.md'), entry.path, root.source, ctx)
      : entry.type === 'file' && entry.name.endsWith('.md')
        ? await parseSkillFile(entry.path, root.path, root.source, ctx)
        : undefined
    if (parsed) skills.push(parsed)
  }
  return skills
}

interface SkillRootEntry {
  name: string
  type: 'directory' | 'file' | 'other'
  path: string
}

async function listSkillRootEntries(root: SkillRoot, ctx: Context): Promise<SkillRootEntry[]> {
  const fs = optionalFileSystem(ctx)
  if (fs !== undefined) return await listSkillRootEntriesFromFileSystem(root, fs)
  return await listSkillRootEntriesFromNode(root, ctx)
}

async function listSkillRootEntriesFromFileSystem(root: SkillRoot, fs: FileSystem): Promise<SkillRootEntry[]> {
  try {
    const target = await fs.resolve(root.path)
    const entries = await fs.listDir(target)
    return entries.map(entryFromFs)
  } catch {
    return []
  }
}

function entryFromFs(entry: FsDirEntry): SkillRootEntry {
  return { name: entry.name, type: entry.type, path: entry.target.displayPath }
}

async function listSkillRootEntriesFromNode(root: SkillRoot, ctx: Context): Promise<SkillRootEntry[]> {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch {
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

async function parseSkillFile(path: string, directory: string, source: SkillSource, ctx: Context): Promise<SkillDefinition | undefined> {
  const raw = await readSkillText(ctx, path)
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
    directory,
    path,
    source,
    content: parsed.body.trim(),
  }
}

function optionalFileSystem(ctx: Context): FileSystem | undefined {
  return ctx.get('fs')
}

async function skillFileExists(ctx: Context, path: string): Promise<boolean> {
  const fs = optionalFileSystem(ctx)
  if (fs !== undefined) {
    const target = await fs.resolve(path)
    return await fs.stat(target) !== undefined
  }
  try {
    await access(path)
    return true
  } catch {
    // Expected first-run path: the bundled system skill has not been installed.
    return false
  }
}

async function writeSkillText(ctx: Context, path: string, content: string): Promise<void> {
  const fs = optionalFileSystem(ctx)
  if (fs !== undefined) {
    await fs.writeText(await fs.resolve(path), content)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function readSkillText(ctx: Context, path: string): Promise<string | undefined> {
  const fs = optionalFileSystem(ctx)
  if (fs !== undefined) {
    return await readSkillTextFromFileSystem(ctx, fs, path)
  }
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function readSkillTextFromFileSystem(ctx: Context, fs: FileSystem, path: string): Promise<string | undefined> {
  const target = await fs.resolve(path)
  const info = await fs.stat(target)
  if (info === undefined || info.type !== 'file') return undefined
  try {
    return await fs.readText(target)
  } catch (error) {
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
    if (info.isFile()) return 'file'
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

async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd
  while (true) {
    try {
      await access(join(current, '.git'))
      return current
    } catch {
      // Continue walking upward until a git root is found.
    }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

function normalizeSkill(skill: SkillRegistration): SkillDefinition {
  if (!SKILL_NAME.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`)
  if (skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`)
  return { ...skill, source: skill.source }
}

function toSummary(skill: SkillDefinition): SkillSummary {
  const { name, description, whenToUse, disableModelInvocation, directory, source } = skill
  return {
    name,
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    ...disableModelInvocation !== undefined ? { disableModelInvocation } : {},
    directory,
    source,
  }
}

function compareSummary(left: SkillSummary, right: SkillSummary): number {
  return left.name.localeCompare(right.name)
}

function promptLine(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  const truncated = normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`
  return escapeText(truncated)
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`skill: ${name} must be a positive integer`)
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

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function collectCacheKey(roots: { project: SkillRoot[]; shared: SkillRoot[] }, runtimeRevision: number): string {
  return JSON.stringify({ runtimeRevision, roots })
}

function errorMessage(error: unknown): string {
  return String(error)
}

function appendSystem(request: GenerateOptions, text: string): void {
  request.system = [request.system ?? '', text].filter(part => part.length > 0).join('\n\n')
}

export default SkillService
