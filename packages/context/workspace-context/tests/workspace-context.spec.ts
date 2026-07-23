import { chmod, mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import * as workspaceContext from '@deepseek-ai/dsh-workspace-context'
import LlmService, { CallId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent, type HookContext } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import {
  discoverBaselineInstructionFiles,
  loadBaselineInstructions,
  renderWorkspaceContext,
} from '@deepseek-ai/dsh-workspace-context'
import {
  baselineInstructionState,
  commitPendingInstructionContexts,
  observeInstructionSessionEvent,
  rollbackPendingInstructionChanges,
  type InstructionVersionCache,
  type PendingInstructionChange,
} from '../src/state.ts'
import { candidateScopeKey } from '../src/render.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Per-candidate reconciliation scope key: directory paired with the file name. */
const sk = (directory: string, candidateName: string): string => candidateScopeKey(directory, candidateName)

const testToolSignal = new AbortController().signal

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-workspace-context-'))
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

class RecordingFileSystem extends FileSystem {
  entries = new Map<string, { type: FsInfo['type']; content?: string; version?: FsVersion }>()
  throwOnStat = new Set<string>()
  throwOnRead = new Set<string>()
  omitSizes = new Set<string>()
  readTargets: string[] = []
  readTextTargets: string[] = []
  signals: AbortSignal[] = []

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal !== undefined) this.signals.push(opts.signal)
    opts?.signal?.throwIfAborted()
    // resolve(), not join(): entries are seeded with host join() keys, and on
    // Windows a joined '/'-rooted prefix would not match a resolved drive path.
    const absolute = resolve(opts?.cwd ?? '/', path)
    return { targetKey: FsTargetKey(absolute), displayPath: absolute }
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal !== undefined) this.signals.push(signal)
    signal?.throwIfAborted()
    if (this.throwOnStat.has(target.targetKey)) throw new Error(`stat failed: ${target.displayPath}`)
    const entry = this.entries.get(target.targetKey)
    if (entry === undefined) return undefined
    const info: FsInfo = {
      version: entry.version ?? FsVersion(`v:${target.targetKey}:${entry.type}:${entry.content ?? ''}`),
      type: entry.type,
    }
    if (entry.content !== undefined && !this.omitSizes.has(target.targetKey)) info.size = Buffer.byteLength(entry.content, 'utf8')
    return info
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal !== undefined) this.signals.push(signal)
    signal?.throwIfAborted()
    const target = await this.resolve(path, { ...opts, ...signal === undefined ? {} : { signal } })
    const info = await this.stat(target, signal)
    if (info === undefined) return undefined
    return {
      version: info.version,
      type: info.type,
      ...(info.size !== undefined ? { size: info.size } : {}),
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    if (signal !== undefined) this.signals.push(signal)
    signal?.throwIfAborted()
    this.readTextTargets.push(target.targetKey)
    return this.entries.get(target.targetKey)?.content ?? ''
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (signal !== undefined) this.signals.push(signal)
    signal?.throwIfAborted()
    this.readTargets.push(target.targetKey)
    if (this.throwOnRead.has(target.targetKey)) throw new Error(`read failed: ${target.displayPath}`)
    const content = this.entries.get(target.targetKey)?.content ?? ''
    return (async function* () {
      const midpoint = Math.ceil(content.length / 2)
      yield content.slice(0, midpoint)
      signal?.throwIfAborted()
      yield content.slice(midpoint)
    })()
  }

  override async listDir(_target: FsTarget): Promise<FsDirEntry[]> {
    return []
  }

  override async writeText(_target: FsTarget, _content: string, _expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    return { operation: 'update', version: FsVersion('unused'), before: '', after: _content }
  }

  override async editText(_target: FsTarget, _edit: FsEditRequest): Promise<FsEditOutcome> {
    return { version: FsVersion('unused'), before: '', after: '' }
  }
}

class BlockingReadFileSystem extends RecordingFileSystem {
  readonly started = Promise.withResolvers<undefined>()

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (signal !== undefined) this.signals.push(signal)
    this.readTargets.push(target.targetKey)
    this.started.resolve(undefined)
    return (async function* () {
      await new Promise<void>((_resolve, reject) => {
        const abortReason = (): Error => signal?.reason instanceof Error ? signal.reason : new Error('aborted')
        if (signal?.aborted) { reject(abortReason()); return }
        signal?.addEventListener('abort', () => { reject(abortReason()) }, { once: true })
      })
      yield 'unreachable'
    })()
  }
}

async function mountWorkspaceContext(ctx: Context, config: workspaceContext.Config): Promise<Awaited<ReturnType<Context['plugin']>>> {
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  return ctx.plugin(workspaceContext, config)
}

async function mountFileToolsAndWorkspaceContext(ctx: Context, config: workspaceContext.Config): Promise<Awaited<ReturnType<Context['plugin']>>> {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ToolFs)
  return ctx.plugin(workspaceContext, config)
}

function stubAgent(cwd?: string, seed: SessionEvent[] = []): Agent {
  const id = SessionId('s1')
  const session = new Session(id, seed, cwd === undefined ? undefined : { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id: SessionId('a1'),
    options: {},
    session,
    status: 'idle',
    send() {},
    steer() {},
    inject(content, options) {
      session.append('context/message', {
        content,
        source: options?.source ?? { kind: 'user' },
        ...options?.meta !== undefined ? { meta: options.meta } : {},
      }, { surfaceOp: 'append' })
    },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}

function stubToolExecution(input: Omit<ToolExecution, 'token'>): ToolExecution {
  return {
    token: Symbol('workspace-context-test-execution') as ToolExecutionToken,
    ...input,
  }
}

function blocksText(blocks: { type: string; text?: string }[] | undefined): string {
  return blocks?.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n') ?? ''
}

function workspaceContextOf(result: { additionalContexts?: HookContext[] }): HookContext | undefined {
  return result.additionalContexts?.find(context =>
    context.source.kind === 'plugin' && context.source.plugin === 'workspace-context')
}

function workspaceChangeContext(scope: string, digest: string): HookContext {
  return {
    content: [{ type: 'text', text: `instructions for ${scope}` }],
    source: { kind: 'plugin', plugin: 'workspace-context' },
    meta: {
      kind: 'workspace-instructions',
      version: 1,
      changes: [{ action: 'set', scope, path: `${scope}/AGENTS.md`, digest }],
    },
  }
}

function appendAdditionalContexts(agent: Agent, result: { additionalContexts?: HookContext[] }): number | undefined {
  let lastSeq: number | undefined
  for (const context of result.additionalContexts ?? []) {
    lastSeq = agent.session.append('context/message', {
      content: context.content,
      source: context.source,
      ...context.meta !== undefined ? { meta: context.meta } : {},
    }, { surfaceOp: 'append' }).seq
  }
  return lastSeq
}

const composedPrefixes = new WeakMap<object, Message[]>()

async function composeBaselinePrefix(ctx: Context, agent: Agent): Promise<Message[]> {
  const empty: Message[] = []
  const prefix = await ctx.waterfall(
    'agent/session-prefix', agent, empty, AbortSignal.timeout(1000),
    () => Promise.resolve(empty),
  )
  composedPrefixes.set(agent, prefix)
  return prefix
}

function derivedText(agent: Agent): string {
  return blocksText(composedPrefixes.get(agent)?.[0]?.content)
}

function expectNoDerivedMessages(agent: Agent): void {
  expect(agent.session.deriveMessages()).toEqual([])
  expect(composedPrefixes.get(agent) ?? []).toEqual([])
}

describe('workspace context instruction discovery', () => {
  it('treats ENOTDIR while probing a host candidate as confirmed absence', async () => {
    const root = await tempRepo()
    const homeFile = join(root, 'not-a-directory')
    try {
      await writeFile(homeFile, 'file')

      const files = await discoverBaselineInstructionFiles({ cwd: root, dshHome: homeFile })

      expect(files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads user-global first, then every root-to-cwd candidate in precedence order', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      const cwd = join(root, 'packages/app')
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(home, 'AGENTS.md'), 'global rules')
      await write(join(root, 'AGENTS.md'), 'root agents')
      await write(join(root, 'CLAUDE.md'), 'root claude')
      await write(join(root, 'packages/CLAUDE.md'), 'package claude')
      await write(join(cwd, 'AGENTS.md'), 'app agents')

      const files = await discoverBaselineInstructionFiles({ cwd, dshHome: home })

      expect(files.map(file => file.displayPath)).toEqual([
        '$DSH_HOME/AGENTS.md',
        'AGENTS.md',
        'CLAUDE.md',
        join('packages', 'CLAUDE.md'),
        join('packages', 'app', 'AGENTS.md'),
      ])
      expect(files.map(file => file.absolutePath)).toContain(join(root, 'CLAUDE.md'))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads a same-directory local overlay in addition to the base file by default', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      const cwd = join(root, 'pkg')
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'root base')
      await write(join(root, 'AGENTS.local.md'), 'root local')
      await write(join(cwd, 'CLAUDE.md'), 'pkg base')
      await write(join(cwd, 'CLAUDE.local.md'), 'pkg local')

      const files = await discoverBaselineInstructionFiles({ cwd, dshHome: home })

      expect(files.map(file => file.displayPath)).toEqual([
        'AGENTS.md',
        'AGENTS.local.md',
        join('pkg', 'CLAUDE.md'),
        join('pkg', 'CLAUDE.local.md'),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads no local overlay when localInstructionFileCandidates is empty', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'base rule')
      await write(join(root, 'AGENTS.local.md'), 'local rule')

      const files = await discoverBaselineInstructionFiles({
        cwd: root,
        dshHome: home,
        localInstructionFileCandidates: [],
      })

      expect(files.map(file => file.displayPath)).toEqual(['AGENTS.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('treats a .git file as a project root marker and does not search above it', async () => {
    const outer = await tempRepo()
    const home = await tempRepo()
    try {
      const root = join(outer, 'worktree')
      const cwd = join(root, 'src')
      await write(join(outer, 'AGENTS.md'), 'outer must not load')
      await write(join(root, '.git'), 'gitdir: ../.git/worktrees/worktree')
      await write(join(root, 'AGENTS.md'), 'root')
      await mkdir(cwd, { recursive: true })

      const files = await discoverBaselineInstructionFiles({ cwd, dshHome: home })

      expect(files.map(file => file.displayPath)).toEqual(['AGENTS.md'])
    } finally {
      await rm(outer, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('re-reads content after a same-version, same-size rewrite', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      const cwd = join(root, 'pkg')
      await mkdir(join(root, '.git'), { recursive: true })
      await mkdir(cwd, { recursive: true })

      expect(await loadBaselineInstructions({ cwd, dshHome: home, maxBytes: 65536 })).toBeUndefined()

      const leaf = join(cwd, 'AGENTS.md')
      await write(leaf, 'first')
      const first = await loadBaselineInstructions({ cwd, dshHome: home, maxBytes: 65536 })
      expect(first?.text).toContain('first')
      const again = await loadBaselineInstructions({ cwd, dshHome: home, maxBytes: 65536 })
      expect(again?.text).toContain('first')

      const before = await stat(leaf)
      await writeFile(leaf, 'other')
      await utimes(leaf, before.atime, before.mtime)
      const second = await loadBaselineInstructions({ cwd, dshHome: home, maxBytes: 65536 })
      expect(second?.text).toContain('other')
      expect(second?.text).not.toContain('first')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  // POSIX-only fixture: chmod 0 cannot make a file unreadable to its owner on Windows.
  it.skipIf(process.platform === 'win32')('skips a file that becomes unreadable after discovery without failing the request', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      const cwd = join(root, 'pkg')
      await mkdir(join(root, '.git'), { recursive: true })
      await mkdir(cwd, { recursive: true })
      const leaf = join(cwd, 'AGENTS.md')
      await write(leaf, 'secret-ish rule')
      await chmod(leaf, 0)

      const loaded = await loadBaselineInstructions({ cwd, dshHome: home, maxBytes: 65536 })

      expect(loaded).toBeUndefined()
      await chmod(leaf, 0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('follows a symlinked instruction file to its target content', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    const outside = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(outside, 'shared.md'), 'shared instruction body')
      await symlink(join(outside, 'shared.md'), join(root, 'AGENTS.md'))

      const files = await discoverBaselineInstructionFiles({ cwd: root, dshHome: home })
      const loaded = await loadBaselineInstructions({ cwd: root, dshHome: home, maxBytes: 65536 })

      expect(files.map(file => file.displayPath)).toContain('AGENTS.md')
      expect(loaded?.text).toContain('shared instruction body')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('follows a symlinked instruction file through ctx.fs to its target content', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    const outside = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(outside, 'shared.md'), 'shared provider instruction body')
      await symlink(join(outside, 'shared.md'), join(root, 'AGENTS.md'))
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('shared provider instruction body')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('disables baseline loading when the byte budget is zero', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')

      await expect(loadBaselineInstructions({ cwd: root, dshHome: home, maxBytes: 0 })).resolves.toBeUndefined()
      await expect(loadBaselineInstructions({ cwd: root, dshHome: home, maxBytes: 65536, maxSourceBytes: 0 })).resolves.toBeUndefined()
      await expect(loadBaselineInstructions({
        cwd: root, dshHome: home, maxBytes: 65536, maxSourceBytes: Infinity,
      })).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('honors configured instruction candidates that exclude CLAUDE.md', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'CLAUDE.md'), 'claude only')

      const files = await discoverBaselineInstructionFiles({
        cwd: root,
        dshHome: home,
        instructionFileCandidates: ['AGENTS.md'],
      })

      expect(files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads every configured instruction candidate in configured order without hard-coding AGENTS.md priority', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'native rule')
      await write(join(root, 'CLAUDE.local.md'), 'local claude rule')
      await write(join(root, 'CLAUDE.md'), 'claude rule')

      const files = await discoverBaselineInstructionFiles({
        cwd: root,
        dshHome: home,
        instructionFileCandidates: ['CLAUDE.local.md', 'AGENTS.md', 'CLAUDE.md'],
      })

      expect(files.map(file => file.displayPath)).toEqual(['CLAUDE.local.md', 'AGENTS.md', 'CLAUDE.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('ignores configured instruction candidates that are not same-directory file names', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'native rule')
      await write(join(root, '.claude/CLAUDE.md'), 'nested claude rule')

      const files = await discoverBaselineInstructionFiles({
        cwd: root,
        dshHome: home,
        instructionFileCandidates: ['', '.', '..', '.claude/CLAUDE.md', 'nested\\CLAUDE.md', 'AGENTS.md'],
      })

      expect(files.map(file => file.displayPath)).toEqual(['AGENTS.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('defaults dshHome and uses cwd itself as root when no project marker exists', async () => {
    const root = await tempRepo()
    const emptyHome = await tempRepo()
    // Isolate the default-home fallback: blank DSH_HOME is treated as unset, and
    // HOME points at an empty dir so the default ~/.dsh holds no global scope.
    // Symlinks are now followed, so a real ~/.dsh/AGENTS.md would otherwise leak in.
    vi.stubEnv('DSH_HOME', '')
    vi.stubEnv('HOME', emptyHome)
    try {
      const cwd = join(root, 'child')
      await mkdir(cwd, { recursive: true })
      await write(join(root, 'AGENTS.md'), 'parent without marker')
      await write(join(cwd, 'AGENTS.md'), 'cwd without marker')

      const files = await discoverBaselineInstructionFiles({ cwd })

      expect(files.map(file => file.displayPath)).toEqual(['AGENTS.md'])
      expect(files.map(file => file.absolutePath)).toEqual([join(cwd, 'AGENTS.md')])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
      await rm(emptyHome, { recursive: true, force: true })
    }
  })

  it('honors DSH_HOME when dshHome is not configured explicitly', async () => {
    const root = await tempRepo()
    const envHome = await tempRepo()
    try {
      await write(join(envHome, 'AGENTS.md'), 'env global rule')
      vi.stubEnv('DSH_HOME', envHome)

      const files = await discoverBaselineInstructionFiles({ cwd: root })

      expect(files).toEqual([{ absolutePath: join(envHome, 'AGENTS.md'), displayPath: '$DSH_HOME/AGENTS.md' }])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
      await rm(envHome, { recursive: true, force: true })
    }
  })

  it('labels the default DSH home as ~/.dsh when HOME points at the configured default', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await write(join(home, '.dsh/AGENTS.md'), 'global default rule')

      vi.resetModules()
      vi.doMock('node:os', () => ({ homedir: () => home }))
      const isolated = await import('@deepseek-ai/dsh-workspace-context')
      const files = await isolated.discoverBaselineInstructionFiles({ cwd: root })

      expect(files.map(file => file.displayPath)).toEqual(['~/.dsh/AGENTS.md'])
    } finally {
      vi.doUnmock('node:os')
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('expands a configured ~/.dsh home to the operating-system home directory', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await write(join(home, '.dsh/AGENTS.md'), 'global tilde rule')

      vi.resetModules()
      vi.doMock('node:os', () => ({ homedir: () => home }))
      const isolated = await import('@deepseek-ai/dsh-workspace-context')
      const files = await isolated.discoverBaselineInstructionFiles({ cwd: root, dshHome: '~/.dsh' })

      expect(files).toEqual([{ absolutePath: join(home, '.dsh/AGENTS.md'), displayPath: '~/.dsh/AGENTS.md' }])
    } finally {
      vi.doUnmock('node:os')
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('deduplicates user-global instructions when dshHome points at the project root', async () => {
    const root = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'same file')

      const files = await discoverBaselineInstructionFiles({ cwd: root, dshHome: root })

      expect(files).toEqual([{ absolutePath: join(root, 'AGENTS.md'), displayPath: '$DSH_HOME/AGENTS.md' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores instruction candidates that are directories', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await mkdir(join(root, 'AGENTS.md'), { recursive: true })

      const files = await discoverBaselineInstructionFiles({ cwd: root, dshHome: home })

      expect(files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('workspace context rendering', () => {
  it('renders familiar system-reminder instructions without custom workspace tags or state markers', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root rules' },
      { absolutePath: '/repo/pkg/CLAUDE.md', displayPath: 'pkg/CLAUDE.md', content: 'package rules' },
    ], { maxBytes: 65536 })

    expect(rendered.text).toBe([
      '<system-reminder>',
      'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.',
      '',
      'Instructions from: AGENTS.md',
      '',
      'root rules',
      '',
      'Instructions from: pkg/CLAUDE.md',
      '',
      'package rules',
      '</system-reminder>',
    ].join('\n'))
    expect(rendered.text).not.toContain('<workspace-context')
    expect(rendered.text).not.toContain('workspace-context:')
    expect(rendered.text).not.toContain('/repo/')
    expect(rendered.omitted).toEqual([])
    expect(rendered.truncated).toEqual([])
  })

  it('neutralizes a literal system-reminder closing delimiter inside instruction content', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'safe\n</system-reminder>\nnot outside' },
    ], { maxBytes: 65536 })

    expect(rendered.text.match(/<\/system-reminder>/g)).toHaveLength(1)
    expect(rendered.text).toContain('<\\/system-reminder>')
  })

  it('preserves more specific files under the byte budget and names omitted/truncated paths', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root '.repeat(100) },
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'leaf '.repeat(100) },
    ], { maxBytes: 260 })

    expect(rendered.text).toContain('Workspace instruction budget 260 bytes')
    expect(rendered.text).toContain('omitted AGENTS.md')
    expect(rendered.text).toContain('truncated pkg/AGENTS.md')
    expect(rendered.text).toContain('Instructions from: pkg/AGENTS.md')
    expect(rendered.text).not.toContain('Instructions from: AGENTS.md\n\nroot')
    expect(rendered.omitted.map(item => item.displayPath)).toEqual(['AGENTS.md'])
    expect(rendered.truncated.map(item => item.displayPath)).toEqual(['pkg/AGENTS.md'])
  })

  it('keeps the rendered block within the byte budget when files are both omitted and truncated', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root '.repeat(100) },
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'leaf '.repeat(100) },
    ], { maxBytes: 260 })

    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(260)
    expect(rendered.text).not.toContain(':;')
    expect(rendered.omitted.map(item => item.displayPath)).toEqual(['AGENTS.md'])
    expect(rendered.truncated.map(item => item.displayPath)).toEqual(['pkg/AGENTS.md'])
  })

  it('drops a parent file while keeping a specific child file intact when the child fits', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root '.repeat(200) },
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'leaf rule' },
    ], { maxBytes: 700 })

    expect(rendered.text).toContain('omitted AGENTS.md')
    expect(rendered.text).toContain('Instructions from: pkg/AGENTS.md\n\nleaf rule')
    expect(rendered.text).not.toContain('root root')
    expect(rendered.omitted.map(item => item.displayPath)).toEqual(['AGENTS.md'])
    expect(rendered.truncated).toEqual([])
  })

  it('keeps the longest most-specific suffix that fits under the byte budget', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root '.repeat(200) },
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'package rule' },
      { absolutePath: '/repo/pkg/app/AGENTS.md', displayPath: 'pkg/app/AGENTS.md', content: 'app rule' },
    ], { maxBytes: 760 })

    expect(rendered.text).toContain('omitted AGENTS.md')
    expect(rendered.text).toContain('Instructions from: pkg/AGENTS.md\n\npackage rule')
    expect(rendered.text).toContain('Instructions from: pkg/app/AGENTS.md\n\napp rule')
    expect(rendered.text).not.toContain('root root')
    expect(rendered.omitted.map(item => item.displayPath)).toEqual(['AGENTS.md'])
    expect(rendered.truncated).toEqual([])
  })

  it('truncates a single oversized file to the largest content slice that fits', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'x'.repeat(1000) },
    ], { maxBytes: 700 })

    expect(rendered.text).toContain('truncated AGENTS.md')
    expect(rendered.text).toContain('Instructions from: AGENTS.md')
    expect(rendered.truncated).toHaveLength(1)
    expect(rendered.truncated[0]?.originalBytes).toBe(1000)
    expect(rendered.truncated[0]!.includedBytes).toBeGreaterThan(0)
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(700)
  })

  it('omits all text when the render budget is disabled', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root rules' },
    ], { maxBytes: 0 })

    expect(rendered).toEqual({
      text: '',
      omitted: [{ absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root rules' }],
      truncated: [],
    })
  })

  it('falls back to a compact truncation notice when even the empty heading cannot fit', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'x'.repeat(1000) },
    ], { maxBytes: 100 })

    expect(rendered.text).toBe('Workspace instruction budget 100 bytes: truncated pkg/AGENTS.md from 1000 to 0 bytes')
    expect(rendered.truncated).toEqual([{ displayPath: 'pkg/AGENTS.md', originalBytes: 1000, includedBytes: 0 }])
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(100)
  })

  it('keeps the empty instruction heading when it fits beside the compact notice', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'x'.repeat(1000) },
    ], { maxBytes: 120 })

    expect(rendered.text).toBe([
      'Workspace instruction budget 120 bytes: truncated pkg/AGENTS.md from 1000 to 0 bytes',
      '',
      'Instructions from: pkg/AGENTS.md',
      '',
      '',
    ].join('\n'))
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBe(120)
  })

  it('truncates the compact notice itself when the render budget is smaller than the notice', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'x'.repeat(1000) },
    ], { maxBytes: 20 })

    expect(rendered.text).toBe('Workspace instructio')
    expect(rendered.truncated).toEqual([{ displayPath: 'pkg/AGENTS.md', originalBytes: 1000, includedBytes: 0 }])
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBe(20)
  })

  it('keeps compact truncation notices within budget when a multibyte display path is cut', () => {
    const rendered = renderWorkspaceContext([
      { absolutePath: '/repo/路径/AGENTS.md', displayPath: '路径/AGENTS.md', content: 'x'.repeat(1000) },
    ], { maxBytes: 51 })

    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(51)
  })
})

describe('workspace context request injection', () => {
  it('requires an explicit maxBytes configuration', async () => {
    const ctx = new Context()

    await expect(ctx.plugin(workspaceContext, {} as workspaceContext.Config)).rejects.toThrow(/maxBytes/)
  })

  it('mounts without requiring a filesystem provider', async () => {
    const ctx = new Context()
    try {
      const outcome = await Promise.race([
        ctx.plugin(workspaceContext, { maxBytes: 65536 }).then(() => {
          return 'settled' as const
        }),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => {
            resolve('pending')
          }, 50)
        }),
      ])

      expect(outcome).toBe('settled')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not declare fs as a static inject dependency', () => {
    expect('inject' in workspaceContext).toBe(false)
  })

  it('does not inject baseline context when no filesystem provider is present', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(workspaceContext, { maxBytes: 65536 })
      const agent = stubAgent('/virtual/repo')

      await composeBaselinePrefix(ctx, agent)

      expectNoDerivedMessages(agent)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves post-execute decisions unchanged when no filesystem provider is present', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(workspaceContext, { maxBytes: 65536 })

      const decision = await ctx.waterfall('tools/post-execute', stubToolExecution({
        signal: testToolSignal,
        callId: CallId('no-fs-post-execute'),
        name: 'read',
        arguments: { file_path: join('pkg', 'file.txt') },
        agent: stubAgent('/virtual/repo'),
      }), {
        isError: false,
        content: [{ type: 'text', text: 'file content' }],
      }, async () => ({
        kind: 'accept',
        content: [{ type: 'text', text: 'downstream content' }],
      }))

      expect(decision).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream content' }] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not load workspace instructions when a downstream listener blocks the tool call', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'pkg/AGENTS.md'), { type: 'file', content: 'nested package rule' })
      fs.entries.set(join(root, 'pkg/file.txt'), { type: 'file', content: 'hello' })
      await ctx.plugin(ToolFs)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const exec = stubToolExecution({
        signal: testToolSignal,
        callId: CallId('read-blocked-post-execute'),
        name: 'read',
        arguments: { file_path: join('pkg', 'file.txt') },
        agent,
      })
      const result = {
        isError: false,
        content: [{ type: 'text' as const, text: 'hello' }],
      }

      // A later PostToolUse-style policy blocks this otherwise-successful read.
      const blocked = await ctx.waterfall('tools/post-execute', exec, result, async () => ({
        kind: 'block' as const,
        feedback: [{ type: 'text' as const, text: 'blocked by policy' }],
      }))

      expect(blocked).toEqual({
        kind: 'block',
        feedback: [{ type: 'text', text: 'blocked by policy' }],
      })
      expect(blocked.additionalContexts).toBeUndefined()

      // The same read, when the downstream accepts, DOES surface the nested
      // instructions — proving the block branch above is what suppressed them,
      // and that the block did not consume the pending nested change.
      const accepted = await ctx.waterfall('tools/post-execute', exec, result, async () => ({
        kind: 'accept' as const,
      }))
      expect(accepted.kind).toBe('accept')
      expect(workspaceContextOf(accepted)?.source).toEqual({ kind: 'plugin', plugin: 'workspace-context' })
      expect(blocksText(workspaceContextOf(accepted)?.content)).toContain('nested package rule')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('contributes baseline instructions through the frozen session prefix instead of durable history', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(agent.session.deriveMessages()).toEqual([])
      expect(composedPrefixes.get(agent)).toHaveLength(1)
      expect(derivedText(agent)).toContain('<system-reminder>')
      expect(derivedText(agent)).toContain('Instructions from: AGENTS.md')
      expect(derivedText(agent)).toContain('repo rule')
      expect(derivedText(agent)).not.toContain('<context source=')
      expect(derivedText(agent)).not.toContain('<workspace-context')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('returns one baseline contribution per session-prefix composition without appending context events', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await composeBaselinePrefix(ctx, agent)
      const second = await composeBaselinePrefix(ctx, agent)

      expect(second).toEqual(first)
      expect(agent.session.events.filter(event => event.type === 'context/message')).toHaveLength(0)
      expect(derivedText(agent)).toContain('repo rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('tracks only baseline files that were actually included under the byte budget', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      const cwd = join(root, 'pkg')
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'root '.repeat(200))
      await write(join(cwd, 'AGENTS.md'), 'package rule')
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 700 })
      const agent = stubAgent(cwd)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('omitted AGENTS.md')
      expect(derivedText(agent)).toContain(`Instructions from: ${join('pkg', 'AGENTS.md')}\n\npackage rule`)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('places workspace instructions before later session-prefix contributors such as a skills catalog', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      ctx.on('agent/session-prefix', async (_agent, _prefix, _signal, next) => {
        const rest = await next()
        return [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>Available skills</system-reminder>' }] }, ...rest]
      })

      const prefix = await composeBaselinePrefix(ctx, stubAgent(root))

      expect(prefix).toHaveLength(2)
      expect(blocksText(prefix[0]?.content)).toContain('Instructions from: AGENTS.md')
      expect(blocksText(prefix[1]?.content)).toBe('<system-reminder>Available skills</system-reminder>')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('appends a replacement when a frozen baseline file changes before a later fs tool call', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'old root rule')
      await write(join(root, 'file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)
      await write(join(root, 'AGENTS.md'), 'new root rule with more detail')
      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-baseline-change'), name: 'read', arguments: { file_path: 'file.txt' }, agent,
      })

      expect(workspaceContextOf(result)?.meta).toMatchObject({
        changes: [{ action: 'replace', scope: sk('.', 'AGENTS.md'), path: 'AGENTS.md' }],
      })
      expect(blocksText(workspaceContextOf(result)?.content)).toContain('Updated instructions from: AGENTS.md')
      expect(blocksText(workspaceContextOf(result)?.content)).toContain('new root rule with more detail')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('appends a removal when a frozen baseline file is deleted before a later fs tool call', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'root rule')
      await write(join(root, 'file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)
      await rm(join(root, 'AGENTS.md'))
      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-baseline-remove'), name: 'read', arguments: { file_path: 'file.txt' }, agent,
      })

      expect(workspaceContextOf(result)?.meta).toMatchObject({
        changes: [{ action: 'remove', scope: sk('.', 'AGENTS.md'), path: 'AGENTS.md' }],
      })
      expect(blocksText(workspaceContextOf(result)?.content)).toContain('Instructions removed: AGENTS.md')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('deduplicates one AGENTS.md that is both user-global and the project-root candidate', async () => {
    const root = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'shared root and global rule')
      await write(join(root, 'file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: root, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)
      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-with-shared-global-root'), name: 'read', arguments: { file_path: 'file.txt' }, agent,
      })

      expect(derivedText(agent).match(/shared root and global rule/g)).toHaveLength(1)
      expect(result.additionalContexts).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deduplicates trimmed-identical sibling candidates in one directory and renders the earliest original bytes', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'shared repo rule')
      await write(join(root, 'CLAUDE.md'), '  shared repo rule\n\n')
      await write(join(root, 'file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      const text = derivedText(agent)
      expect(text.match(/shared repo rule/g)).toHaveLength(1)
      expect(text).toContain('Instructions from: AGENTS.md')
      expect(text).not.toContain('Instructions from: CLAUDE.md')
      // The kept candidate's original bytes are rendered, not the whitespace-padded duplicate.
      expect(text).not.toContain('  shared repo rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not expose state markers when a tiny budget reduces the baseline contribution', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 10 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(agent.session.events.filter(event => event.type === 'context/message')).toHaveLength(0)
      expect(derivedText(agent)).not.toContain('workspace-context:')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads instruction file content through ctx.fs instead of direct node reads', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'node fs rule')
      const ctx = new Context()
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'AGENTS.md'), { type: 'file', content: 'ctx.fs rule' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('ctx.fs rule')
      expect(derivedText(agent)).not.toContain('node fs rule')
      expect(fs.readTargets).toEqual([join(root, 'AGENTS.md')])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads provider-visible instruction files that do not exist on the host filesystem', async () => {
    const root = join(await tempRepo(), 'virtual-repo')
    const home = join(await tempRepo(), 'virtual-home')
    const ctx = new Context()
    try {
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'AGENTS.md'), { type: 'file', content: 'provider-only rule' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('provider-only rule')
      expect(fs.readTargets).toEqual([join(root, 'AGENTS.md')])
    } finally {
      await ctx.fiber.dispose()
      await rm(dirname(root), { recursive: true, force: true })
      await rm(dirname(home), { recursive: true, force: true })
    }
  })

  it('keeps the direct provider API usable without an operation signal', async () => {
    const root = resolve('/virtual/no-signal-repo')
    const home = resolve('/virtual/no-signal-home')
    const ctx = new Context()
    try {
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'AGENTS.md'), { type: 'file', content: 'optional capability signal' })

      const rendered = await loadBaselineInstructions({ cwd: root, dshHome: home, maxBytes: 65536 }, fs)

      expect(rendered?.text).toContain('optional capability signal')
      expect(fs.signals).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a provider-sized instruction file before reading content', async () => {
    const root = join(await tempRepo(), 'virtual-repo')
    const home = join(await tempRepo(), 'virtual-home')
    const ctx = new Context()
    try {
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'AGENTS.md'), { type: 'file', content: 'far too large' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536, maxSourceBytes: 4 })

      const prefix = await composeBaselinePrefix(ctx, stubAgent(root))

      expect(prefix).toEqual([])
      expect(fs.readTargets).toEqual([])
      expect(fs.readTextTargets).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(dirname(root), { recursive: true, force: true })
      await rm(dirname(home), { recursive: true, force: true })
    }
  })

  it('bounds streamed instruction content when provider size is unavailable', async () => {
    const root = join(await tempRepo(), 'virtual-repo')
    const home = join(await tempRepo(), 'virtual-home')
    const ctx = new Context()
    try {
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      const instructionPath = join(root, 'AGENTS.md')
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(instructionPath, { type: 'file', content: 'far too large' })
      fs.omitSizes.add(instructionPath)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536, maxSourceBytes: 4 })

      const prefix = await composeBaselinePrefix(ctx, stubAgent(root))

      expect(prefix).toEqual([])
      expect(fs.readTargets).toEqual([instructionPath])
      expect(fs.readTextTargets).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(dirname(root), { recursive: true, force: true })
      await rm(dirname(home), { recursive: true, force: true })
    }
  })

  it('aborts an in-flight baseline stream with the session-prefix signal', async () => {
    const root = join(await tempRepo(), 'virtual-repo')
    const home = join(await tempRepo(), 'virtual-home')
    const ctx = new Context()
    try {
      await ctx.plugin(BlockingReadFileSystem)
      const fs = ctx.fs as BlockingReadFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'AGENTS.md'), { type: 'file', content: 'blocked' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const controller = new AbortController()
      const reason = new Error('cancel prefix')
      const empty: Message[] = []
      const pending = ctx.waterfall(
        'agent/session-prefix', stubAgent(root), empty, controller.signal,
        () => Promise.resolve(empty),
      )

      await fs.started.promise
      controller.abort(reason)

      await expect(pending).rejects.toBe(reason)
      expect(fs.signals).toContain(controller.signal)
    } finally {
      await ctx.fiber.dispose()
      await rm(dirname(root), { recursive: true, force: true })
      await rm(dirname(home), { recursive: true, force: true })
    }
  })

  it('loads user-global and CLAUDE fallback content through ctx.fs', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(home, 'AGENTS.md'), 'node global rule')
      await write(join(root, 'CLAUDE.md'), 'node claude rule')
      const ctx = new Context()
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(home, 'AGENTS.md'), { type: 'file', content: 'ctx global rule' })
      fs.entries.set(join(root, 'CLAUDE.md'), { type: 'file', content: 'ctx claude rule' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('ctx global rule')
      expect(derivedText(agent)).toContain('ctx claude rule')
      expect(derivedText(agent)).not.toContain('node global rule')
      expect(derivedText(agent)).not.toContain('node claude rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('skips provider-visible instruction candidates when ctx.fs reports a non-file target', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'node fs rule')
      const ctx = new Context()
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'AGENTS.md'), { type: 'directory' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expectNoDerivedMessages(agent)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads instruction files when ctx.fs omits the metadata size', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'node fs rule')
      const ctx = new Context()
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'AGENTS.md'), { type: 'file' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('Instructions from: AGENTS.md')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('skips provider-visible instruction candidates when ctx.fs cannot stat them', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'node fs rule')
      const ctx = new Context()
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.throwOnStat.add(join(root, 'AGENTS.md'))
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expectNoDerivedMessages(agent)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('skips a candidate whose provider probe fails while still loading its available sibling', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      const ctx = new Context()
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.throwOnStat.add(join(root, 'AGENTS.md'))
      fs.entries.set(join(root, 'CLAUDE.md'), { type: 'file', content: 'claude sibling rule' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('claude sibling rule')
      expect(fs.readTargets).toContain(join(root, 'CLAUDE.md'))
      expect(fs.readTargets).not.toContain(join(root, 'AGENTS.md'))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('treats ctx.fs marker lookup failures as absent root markers', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.throwOnStat.add(join(root, '.git'))
      fs.entries.set(join(root, 'AGENTS.md'), { type: 'file', content: 'repo rule' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('repo rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('keeps different session cwd instruction files isolated in one context', async () => {
    const repoA = await tempRepo()
    const repoB = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(repoA, '.git'), { recursive: true })
      await mkdir(join(repoB, '.git'), { recursive: true })
      await write(join(repoA, 'AGENTS.md'), 'repo A only')
      await write(join(repoB, 'AGENTS.md'), 'repo B only')
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agentA = stubAgent(repoA)
      const agentB = stubAgent(repoB)

      await composeBaselinePrefix(ctx, agentA)
      await composeBaselinePrefix(ctx, agentB)

      expect(derivedText(agentA)).toContain('repo A only')
      expect(derivedText(agentA)).not.toContain('repo B only')
      expect(derivedText(agentB)).toContain('repo B only')
      expect(derivedText(agentB)).not.toContain('repo A only')
    } finally {
      await rm(repoA, { recursive: true, force: true })
      await rm(repoB, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('uses schema defaults on the plugin path so ancestor discovery still finds .git roots', async () => {
    const root = await tempRepo()
    try {
      const cwd = join(root, 'child')
      await mkdir(join(root, '.git'), { recursive: true })
      await mkdir(cwd, { recursive: true })
      await write(join(root, 'AGENTS.md'), 'root schema default rule')
      await write(join(cwd, 'AGENTS.md'), 'child schema default rule')
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(workspaceContext, { maxBytes: 65536 })
      const agent = stubAgent(cwd)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('Instructions from: AGENTS.md\n\nroot schema default rule')
      expect(derivedText(agent)).toContain(`Instructions from: ${join('child', 'AGENTS.md')}\n\nchild schema default rule`)
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders a default local overlay alongside the base file in the baseline prefix', async () => {
    const root = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'base rule')
      await write(join(root, 'AGENTS.local.md'), 'local rule')
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(workspaceContext, { maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expect(derivedText(agent)).toContain('Instructions from: AGENTS.md\n\nbase rule')
      expect(derivedText(agent)).toContain('Instructions from: AGENTS.local.md\n\nlocal rule')
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans up its agent/session-prefix listener when the plugin fiber is disposed', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      const fiber = await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      await fiber.dispose()
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expectNoDerivedMessages(agent)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not inject anything when maxBytes is zero', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 0 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expectNoDerivedMessages(agent)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not inject an empty workspace-context message when maxBytes is negative', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: -1 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expectNoDerivedMessages(agent)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('leaves the request unchanged when no instruction files are present', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      const ctx = new Context()
      await mountWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      await composeBaselinePrefix(ctx, agent)

      expectNoDerivedMessages(agent)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('labels a custom dshHome as DSH_HOME instead of pretending it is ~/.dsh', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await write(join(home, 'AGENTS.md'), 'global custom rule')
      const files = await discoverBaselineInstructionFiles({ cwd: root, dshHome: home })

      expect(files.map(file => file.displayPath)).toEqual(['$DSH_HOME/AGENTS.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not repeat a candidate metadata probe during one discovery and read pass', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')

      const observedStats = new Map<string, number>()
      vi.resetModules()
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>()
        return {
          ...actual,
          stat: async (path: string) => {
            observedStats.set(path, (observedStats.get(path) ?? 0) + 1)
            return actual.stat(path)
          },
        }
      })
      const isolated = await import('@deepseek-ai/dsh-workspace-context')
      await isolated.loadBaselineInstructions({ cwd: root, dshHome: home, maxBytes: 65536 })
      observedStats.clear()
      await isolated.loadBaselineInstructions({ cwd: root, dshHome: home, maxBytes: 65536 })

      expect(observedStats.get(join(root, 'AGENTS.md'))).toBe(1)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('skips an unavailable host candidate but still loads its available sibling', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'CLAUDE.md'), 'claude host sibling rule')
      vi.resetModules()
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>()
        return {
          ...actual,
          stat: async (path: string) => {
            if (path === join(root, 'AGENTS.md')) {
              throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
            }
            return actual.stat(path)
          },
        }
      })
      const isolated = await import('@deepseek-ai/dsh-workspace-context')

      const rendered = await isolated.loadBaselineInstructions({ cwd: root, dshHome: home, maxBytes: 65536 })

      expect(rendered?.text).toContain('claude host sibling rule')
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('dynamic nested workspace context injection', () => {
  it('commits a buffered instruction change before a later tool abort closes the step', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    const ctx = new Context()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested rule survives an aborted tool batch')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const adapter = new MockAdapter([
        [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('read-before-abort'), name: 'read', arguments: '{"file_path":"pkg/deep/file.txt"}' } },
          { type: 'block-start', index: 1, blockType: 'tool-call' },
          { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('abort-after-read'), name: 'abort_step', arguments: '{}' } },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ] satisfies StreamChunk[],
        toolCallResponse('read-after-abort', 'read', { file_path: join('pkg', 'deep', 'file.txt') }),
        textResponse('done'),
      ])
      await ctx.plugin(LlmService)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(ToolFs)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = ctx.agentLoop.create(SessionId('workspace-context-abort'), { provider: 'mock', model: 'mock' }, { cwd: root })
      ctx.tools.register(defineTool({
        name: 'abort_step',
        description: 'Abort the current test step.',
        parameters: {},
        async execute() {
          agent.cancel({ kind: 'user' })
          return [{ type: 'text', text: 'aborted' }]
        },
      }))

      agent.send([{ type: 'text', text: 'read and abort' }])
      await agent.whenIdle()
      expect(agent.session.events.filter(event => event.type === 'context/message')).toHaveLength(1)

      agent.send([{ type: 'text', text: 'retry the read' }])
      await agent.whenIdle()

      const contexts = agent.session.events.filter(event => event.type === 'context/message')
      // The aborted batch drained its accepted context before step close, so the
      // retry sees durable history without producing a duplicate instruction.
      expect(contexts).toHaveLength(1)
      expect(adapter.requests).toHaveLength(3)
      expect(adapter.requests[2]?.messages.map(blocks => blocksText(blocks.content)).join('\n'))
        .toContain('nested rule survives an aborted tool batch')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('builds persisted digest state without inventing a provider version', () => {
    const state = baselineInstructionState([{
      absolutePath: '/repo/AGENTS.md',
      displayPath: 'AGENTS.md',
      content: 'root rule',
    }])

    const change = state.changes.get(sk('.', 'AGENTS.md'))
    expect(change).toMatchObject({
      action: 'set',
      path: 'AGENTS.md',
    })
    expect(change?.digest).toMatch(/^[a-f0-9]{40}$/)
    expect(state.versions).toEqual(new Map())
  })

  it('propagates the tool execution signal into dynamic filesystem reconciliation', async () => {
    const root = join(await tempRepo(), 'virtual-repo')
    const home = join(await tempRepo(), 'virtual-home')
    const ctx = new Context()
    try {
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'pkg/AGENTS.md'), { type: 'file', content: 'nested' })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const controller = new AbortController()
      const reason = new Error('cancel dynamic reconciliation')
      controller.abort(reason)
      const exec = stubToolExecution({
        callId: CallId('cancelled-dynamic-read'),
        name: 'read',
        arguments: { file_path: join('pkg', 'file.txt') },
        agent: stubAgent(root),
        signal: controller.signal,
      })

      const pending = ctx.waterfall('tools/post-execute', exec, {
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }, () => Promise.resolve({ kind: 'accept' as const }))

      await expect(pending).rejects.toBe(reason)
      expect(fs.signals).toContain(controller.signal)
    } finally {
      await ctx.fiber.dispose()
      await rm(dirname(root), { recursive: true, force: true })
      await rm(dirname(home), { recursive: true, force: true })
    }
  })

  it('attaches newly discovered nested instructions after a successful file read touches a descendant path', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'baseline root rule')
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-nested'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })

      expect(result.isError).toBe(false)
      expect(workspaceContextOf(result)?.source).toEqual({ kind: 'plugin', plugin: 'workspace-context' })
      expect(workspaceContextOf(result)?.meta).toMatchObject({
        kind: 'workspace-instructions',
        version: 1,
        changes: [{
          action: 'set',
          scope: sk('pkg', 'AGENTS.md'),
          path: join('pkg', 'AGENTS.md'),
        }],
      })
      const meta = workspaceContextOf(result)?.meta
      const firstChange = typeof meta === 'object' && meta !== null && !Array.isArray(meta) && Array.isArray(meta.changes)
        ? meta.changes[0]
        : undefined
      const changeDigest = typeof firstChange === 'object' && firstChange !== null && !Array.isArray(firstChange)
        ? firstChange.digest
        : undefined
      expect(changeDigest).toMatch(/^[a-f0-9]{40}$/)
      const text = blocksText(workspaceContextOf(result)?.content)
      expect(text).toBe([
        '<system-reminder>',
        `Additional instructions from: ${join('pkg', 'AGENTS.md')}`,
        '',
        'These instructions apply to work under `pkg`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.',
        '',
        'nested package rule',
        '</system-reminder>',
      ].join('\n'))
      expect(text).not.toContain('<workspace-context')
      expect(text).not.toContain('baseline root rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads every configured instruction candidate present in a nested scope', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'native package rule')
      await write(join(root, 'pkg/CLAUDE.local.md'), 'local package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, {
        dshHome: home,
        maxBytes: 65536,
        instructionFileCandidates: ['CLAUDE.local.md', 'AGENTS.md', 'CLAUDE.md'],
      })

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-configured-nested-candidate'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent: stubAgent(root),
      })

      const text = blocksText(workspaceContextOf(result)?.content)
      expect(text).toContain(`Additional instructions from: ${join('pkg', 'CLAUDE.local.md')}`)
      expect(text).toContain('local package rule')
      expect(text).toContain(`Additional instructions from: ${join('pkg', 'AGENTS.md')}`)
      expect(text).toContain('native package rule')
      expect(text.indexOf(join('pkg', 'CLAUDE.local.md'))).toBeLessThan(text.indexOf(join('pkg', 'AGENTS.md')))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('attaches a nested base file and its local overlay together by default', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'baseline root rule')
      await write(join(root, 'pkg/AGENTS.md'), 'nested base rule')
      await write(join(root, 'pkg/AGENTS.local.md'), 'nested local rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-nested-overlay'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent: stubAgent(root),
      })

      const meta = workspaceContextOf(result)?.meta
      const changes = typeof meta === 'object' && meta !== null && !Array.isArray(meta) && Array.isArray(meta.changes)
        ? meta.changes
        : []
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'set', path: join('pkg', 'AGENTS.md') }),
        expect.objectContaining({ action: 'set', path: join('pkg', 'AGENTS.local.md') }),
      ]))
      const text = blocksText(workspaceContextOf(result)?.content)
      expect(text).toContain(`Additional instructions from: ${join('pkg', 'AGENTS.md')}`)
      expect(text).toContain('nested base rule')
      expect(text).toContain(`Additional instructions from: ${join('pkg', 'AGENTS.local.md')}`)
      expect(text).toContain('nested local rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not attach a nested local overlay when the overlay is disabled', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested base rule')
      await write(join(root, 'pkg/AGENTS.local.md'), 'nested local rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, {
        dshHome: home,
        maxBytes: 65536,
        localInstructionFileCandidates: [],
      })

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-nested-overlay-disabled'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent: stubAgent(root),
      })

      const text = blocksText(workspaceContextOf(result)?.content)
      expect(text).toContain(`Additional instructions from: ${join('pkg', 'AGENTS.md')}`)
      expect(text).not.toContain(join('pkg', 'AGENTS.local.md'))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not attach nested instructions again for the same session once a path has been loaded', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-nested-1'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })
      const second = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-nested-2'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })

      expect(first.additionalContexts).toBeDefined()
      expect(second.additionalContexts).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('skips instruction content reads while provider version and effective state are unchanged', async () => {
    const root = join(await tempRepo(), 'virtual-repo')
    const home = join(await tempRepo(), 'virtual-home')
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      const instructionPath = join(root, 'pkg/AGENTS.md')
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(instructionPath, { type: 'file', content: 'nested package rule' })
      fs.entries.set(join(root, 'pkg/file.txt'), { type: 'file', content: 'hello' })
      await ctx.plugin(ToolFs)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-version-fast-path'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, first)
      const second = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-with-version-fast-path'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(first.additionalContexts).toBeDefined()
      expect(second.additionalContexts).toBeUndefined()
      expect(fs.readTargets.filter(path => path === instructionPath)).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(dirname(root), { recursive: true, force: true })
      await rm(dirname(home), { recursive: true, force: true })
    }
  })

  it('re-reads a changed provider version, then refreshes metadata when SHA-1 is unchanged', async () => {
    const root = join(await tempRepo(), 'virtual-repo')
    const home = join(await tempRepo(), 'virtual-home')
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      const instructionPath = join(root, 'pkg/AGENTS.md')
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(instructionPath, { type: 'file', content: 'same package rule', version: FsVersion('revision-1') })
      fs.entries.set(join(root, 'pkg/file.txt'), { type: 'file', content: 'hello' })
      await ctx.plugin(ToolFs)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-same-digest-version-change'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, first)
      fs.entries.set(instructionPath, { type: 'file', content: 'same package rule', version: FsVersion('revision-2') })
      const afterVersionChange = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-same-digest-version-change'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      const afterRefresh = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-version-cache-refresh'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(afterVersionChange.additionalContexts).toBeUndefined()
      expect(afterRefresh.additionalContexts).toBeUndefined()
      expect(fs.readTargets.filter(path => path === instructionPath)).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
      await rm(dirname(root), { recursive: true, force: true })
      await rm(dirname(home), { recursive: true, force: true })
    }
  })

  it('isolates instruction version caches between sessions that touch the same scope', async () => {
    const root = join(await tempRepo(), 'virtual-repo')
    const home = join(await tempRepo(), 'virtual-home')
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      const instructionPath = join(root, 'pkg/AGENTS.md')
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(instructionPath, { type: 'file', content: 'shared path, separate sessions' })
      fs.entries.set(join(root, 'pkg/file.txt'), { type: 'file', content: 'hello' })
      await ctx.plugin(ToolFs)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-from-first-session'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent: stubAgent(root),
      })
      const second = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-from-second-session'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent: stubAgent(root),
      })

      expect(first.additionalContexts).toBeDefined()
      expect(second.additionalContexts).toBeDefined()
      expect(fs.readTargets.filter(path => path === instructionPath)).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
      await rm(dirname(root), { recursive: true, force: true })
      await rm(dirname(home), { recursive: true, force: true })
    }
  })

  it('replaces previously loaded instructions when the same file content changes', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'old package rule')
      await write(join(root, 'pkg/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-change'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, first)
      await write(join(root, 'pkg/AGENTS.md'), 'new package rule with more detail')
      const changed = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-change'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(workspaceContextOf(changed)?.meta).toMatchObject({
        kind: 'workspace-instructions',
        changes: [{ action: 'replace', scope: sk('pkg', 'AGENTS.md'), path: join('pkg', 'AGENTS.md') }],
      })
      expect(blocksText(workspaceContextOf(changed)?.content)).toBe([
        '<system-reminder>',
        `Updated instructions from: ${join('pkg', 'AGENTS.md')}`,
        '',
        'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.',
        '',
        'new package rule with more detail',
        '</system-reminder>',
      ].join('\n'))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reconciles distinct sibling candidates as independent scopes', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'native package rule')
      await write(join(root, 'pkg/CLAUDE.md'), 'sibling package rule')
      await write(join(root, 'pkg/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-both-siblings'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      const firstText = blocksText(workspaceContextOf(first)?.content)
      expect(firstText).toContain('native package rule')
      expect(firstText).toContain('sibling package rule')
      appendAdditionalContexts(agent, first)
      await rm(join(root, 'pkg/AGENTS.md'))
      const removed = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-one-sibling-removed'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      // Removing one candidate only removes its own scope; the sibling scope is untouched.
      expect(workspaceContextOf(removed)?.meta).toMatchObject({
        changes: [{ action: 'remove', scope: sk('pkg', 'AGENTS.md'), path: join('pkg', 'AGENTS.md') }],
      })
      expect(blocksText(workspaceContextOf(removed)?.content)).toContain(`Instructions removed: ${join('pkg', 'AGENTS.md')}`)
      expect(blocksText(workspaceContextOf(removed)?.content)).not.toContain('sibling package rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('drops a newly discovered sibling whose content duplicates an earlier candidate in the scope', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested rule')
      await write(join(root, 'pkg/CLAUDE.md'), 'nested rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-nested-dup-siblings'), name: 'read', arguments: { file_path: join('pkg', 'deep', 'file.txt') }, agent,
      })

      expect(workspaceContextOf(result)?.meta).toMatchObject({
        changes: [{ action: 'set', scope: sk('pkg', 'AGENTS.md'), path: join('pkg', 'AGENTS.md') }],
      })
      const text = blocksText(workspaceContextOf(result)?.content)
      expect(text.match(/nested rule/g)).toHaveLength(1)
      expect(text).toContain(`Additional instructions from: ${join('pkg', 'AGENTS.md')}`)
      expect(text).not.toContain(join('pkg', 'CLAUDE.md'))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('keeps deduplicating against a loaded candidate whose probe transiently fails', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'pkg/AGENTS.md'), { type: 'file', content: 'nested rule' })
      fs.entries.set(join(root, 'pkg/file.txt'), { type: 'file', content: 'hello' })
      await ctx.plugin(ToolFs)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-transient-probe-failure'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, first)
      expect(first.additionalContexts).toBeDefined()

      // The loaded candidate's probe fails while an identical sibling appears:
      // the cached candidate stays effective (last good state), so the sibling
      // must still deduplicate against it rather than land as a duplicate set.
      fs.throwOnStat.add(join(root, 'pkg/AGENTS.md'))
      fs.entries.set(join(root, 'pkg/CLAUDE.md'), { type: 'file', content: 'nested rule' })
      const duringFailure = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-during-transient-probe-failure'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(duringFailure.additionalContexts).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('removes a previously rendered sibling once its content becomes a duplicate of an earlier candidate', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'canonical nested rule')
      await write(join(root, 'pkg/CLAUDE.md'), 'divergent nested rule')
      await write(join(root, 'pkg/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-dup-convergence'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      const firstText = blocksText(workspaceContextOf(first)?.content)
      expect(firstText).toContain('canonical nested rule')
      expect(firstText).toContain('divergent nested rule')
      appendAdditionalContexts(agent, first)
      await write(join(root, 'pkg/CLAUDE.md'), 'canonical nested rule')
      const converged = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-dup-convergence'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(workspaceContextOf(converged)?.meta).toMatchObject({
        changes: [{ action: 'remove', scope: sk('pkg', 'CLAUDE.md'), path: join('pkg', 'CLAUDE.md') }],
      })
      expect(blocksText(workspaceContextOf(converged)?.content)).toContain(`Instructions removed: ${join('pkg', 'CLAUDE.md')}`)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('removes an unchanged sibling when an earlier candidate changes to match its content', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'primary nested rule')
      await write(join(root, 'pkg/CLAUDE.md'), 'secondary nested rule')
      await write(join(root, 'pkg/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-earlier-converges'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, first)
      // Only the earlier candidate changes; the sibling stays byte-identical but now duplicates it.
      await write(join(root, 'pkg/AGENTS.md'), 'secondary nested rule')
      const converged = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-earlier-converges'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(workspaceContextOf(converged)?.meta).toMatchObject({
        changes: [
          { action: 'replace', scope: sk('pkg', 'AGENTS.md'), path: join('pkg', 'AGENTS.md') },
          { action: 'remove', scope: sk('pkg', 'CLAUDE.md'), path: join('pkg', 'CLAUDE.md') },
        ],
      })
      const text = blocksText(workspaceContextOf(converged)?.content)
      expect(text).toContain(`Instructions removed: ${join('pkg', 'CLAUDE.md')}`)
      expect(text).toContain(`Updated instructions from: ${join('pkg', 'AGENTS.md')}`)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('removes previously loaded instructions when no candidate remains in the scope', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'package rule')
      await write(join(root, 'pkg/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-remove'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, first)
      await rm(join(root, 'pkg/AGENTS.md'))
      const removed = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-remove'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(workspaceContextOf(removed)?.meta).toEqual({
        kind: 'workspace-instructions',
        version: 1,
        changes: [{ action: 'remove', scope: sk('pkg', 'AGENTS.md'), path: join('pkg', 'AGENTS.md') }],
      })
      expect(blocksText(workspaceContextOf(removed)?.content)).toBe([
        '<system-reminder>',
        `Instructions removed: ${join('pkg', 'AGENTS.md')}`,
        '',
        'The previously loaded instructions from this file no longer apply.',
        '</system-reminder>',
      ].join('\n'))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('removes a previously loaded instruction file once it resolves to a directory through a symlink', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'package rule')
      await write(join(root, 'pkg/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-symlink-dir'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, first)
      expect(blocksText(workspaceContextOf(first)?.content)).toContain('package rule')

      // The candidate now resolves through a symlink to a directory. A non-file
      // target is a confirmed absence (not unavailable), so the loaded scope is
      // removed; an unavailable classification would emit no change at all.
      await rm(join(root, 'pkg/AGENTS.md'))
      await mkdir(join(root, 'pkg/elsewhere'), { recursive: true })
      await symlink(join(root, 'pkg/elsewhere'), join(root, 'pkg/AGENTS.md'))
      const removed = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-symlink-dir'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(workspaceContextOf(removed)?.meta).toMatchObject({
        changes: [{ action: 'remove', scope: sk('pkg', 'AGENTS.md'), path: join('pkg', 'AGENTS.md') }],
      })
      expect(blocksText(workspaceContextOf(removed)?.content)).toContain(`Instructions removed: ${join('pkg', 'AGENTS.md')}`)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads a candidate again after a logged removal tombstone', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'first package rule')
      await write(join(root, 'pkg/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-tombstone'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, first)
      await rm(join(root, 'pkg/AGENTS.md'))
      const removed = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-to-create-tombstone'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, removed)
      await write(join(root, 'pkg/AGENTS.md'), 'restored package rule')

      const restored = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-tombstone'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(workspaceContextOf(restored)?.meta).toMatchObject({
        changes: [{ action: 'set', scope: sk('pkg', 'AGENTS.md'), path: join('pkg', 'AGENTS.md') }],
      })
      expect(blocksText(workspaceContextOf(restored)?.content)).toContain(`Additional instructions from: ${join('pkg', 'AGENTS.md')}`)
      expect(blocksText(workspaceContextOf(restored)?.content)).toContain('restored package rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not report removal when a previously loaded scope is temporarily unavailable', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(join(root, 'pkg/AGENTS.md'), { type: 'file', content: 'provider package rule' })
      fs.entries.set(join(root, 'pkg/file.txt'), { type: 'file', content: 'hello' })
      await ctx.plugin(ToolFs)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-provider-failure'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })
      appendAdditionalContexts(agent, first)
      fs.throwOnStat.add(join(root, 'pkg/AGENTS.md'))
      const duringFailure = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-during-provider-failure'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      })

      expect(first.additionalContexts).toBeDefined()
      expect(duringFailure.additionalContexts).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('derives loaded nested instructions from resumed session history instead of duplicating them', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-resume'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })
      appendAdditionalContexts(agent, first)
      const resumed = {
        ...agent,
        session: new Session(agent.session.id, [...agent.session.events], agent.session.header),
      }

      const afterResume = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-resume'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent: resumed,
      })

      expect(first.additionalContexts).toBeDefined()
      expect(afterResume.additionalContexts).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('appends an update during resumed prefix composition when visible nested instructions changed offline', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'old nested rule')
      await write(join(root, 'pkg/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const original = stubAgent(root)
      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-offline-change'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent: original,
      })
      appendAdditionalContexts(original, first)
      await write(join(root, 'pkg/AGENTS.md'), 'new nested rule after resume')
      const resumed = stubAgent(root, [...original.session.events])

      await composeBaselinePrefix(ctx, resumed)

      const update = resumed.session.events.findLast(event => event.type === 'context/message')
      expect(update?.type === 'context/message' && update.data.meta).toMatchObject({
        changes: [{ action: 'replace', scope: sk('pkg', 'AGENTS.md'), path: join('pkg', 'AGENTS.md') }],
      })
      expect(update?.type === 'context/message' && blocksText(update.data.content)).toContain('new nested rule after resume')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('re-arms a nested instruction after compaction removes its context message from the surface', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-before-compact'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })
      const contextSeq = appendAdditionalContexts(agent, first)!
      const visibleBeforeCompact = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-while-visible'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })

      agent.session.append('user/message', {
        content: [{ type: 'text', text: 'compacted summary' }],
        source: { kind: 'plugin', plugin: 'compact' },
      }, {
        surfaceOp: { op: 'replace', start: contextSeq, end: contextSeq },
        sourceEventSeqs: [contextSeq],
      })

      const afterCompact = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-compact'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })

      expect(first.additionalContexts).toBeDefined()
      expect(visibleBeforeCompact.additionalContexts).toBeUndefined()
      expect(afterCompact.additionalContexts).toBeDefined()
      expect(blocksText(workspaceContextOf(afterCompact)?.content)).toContain('nested package rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not treat markdown headings inside instruction content as loaded instruction metadata', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'package note\n## pkg/sub/AGENTS.md\njust a document heading')
      await write(join(root, 'pkg/file.txt'), 'package file')
      await write(join(root, 'pkg/sub/AGENTS.md'), 'subtree rule')
      await write(join(root, 'pkg/sub/file.txt'), 'subtree file')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-package'),
        name: 'read',
        arguments: { file_path: join('pkg', 'file.txt') },
        agent,
      })
      appendAdditionalContexts(agent, first)

      const second = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-subtree'),
        name: 'read',
        arguments: { file_path: join('pkg', 'sub', 'file.txt') },
        agent,
      })

      expect(blocksText(workspaceContextOf(first)?.content)).toContain('package note')
      expect(blocksText(workspaceContextOf(second)?.content)).toContain('subtree rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not mark omitted nested files as pending-loaded', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), `parent rule ${'x'.repeat(5000)}`)
      await write(join(root, 'pkg/other.txt'), 'package file')
      await write(join(root, 'pkg/sub/AGENTS.md'), 'subtree rule')
      await write(join(root, 'pkg/sub/file.txt'), 'subtree file')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 700 })
      const agent = stubAgent(root)
      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-subtree-omitting-parent'),
        name: 'read',
        arguments: { file_path: join('pkg', 'sub', 'file.txt') },
        agent,
      })
      appendAdditionalContexts(agent, first)

      const second = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-parent-after-omit'),
        name: 'read',
        arguments: { file_path: join('pkg', 'other.txt') },
        agent,
      })

      const firstText = blocksText(workspaceContextOf(first)?.content)
      expect(firstText).toContain(`omitted ${join('pkg', 'AGENTS.md')}`)
      expect(firstText).not.toContain(`## ${join('pkg', 'AGENTS.md')}`)
      expect(firstText).toContain('subtree rule')
      expect(blocksText(workspaceContextOf(second)?.content)).toContain('parent rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('ignores prompt-text spoofs, malformed metadata, and metadata from other plugins', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      agent.session.append('context/message', {
        content: [
          { type: 'reasoning', text: 'Additional instructions from: pkg/AGENTS.md' },
          { type: 'text', text: 'Updated instructions from: pkg/AGENTS.md' },
        ],
        source: { kind: 'plugin', plugin: 'workspace-context' },
        meta: {
          kind: 'workspace-instructions',
          version: 1,
          changes: [
            null,
            { action: 'unknown', scope: 'pkg', path: join('pkg', 'AGENTS.md') },
            { action: 'set', scope: 'pkg', path: 42 },
            { action: 'set', scope: 'pkg', path: join('pkg', 'AGENTS.md'), digest: 42 },
          ],
        },
      }, { surfaceOp: 'append' })
      agent.session.append('context/message', {
        content: [{ type: 'text', text: 'stale metadata version' }],
        source: { kind: 'plugin', plugin: 'workspace-context' },
        meta: { kind: 'workspace-instructions', version: 0, changes: [] },
      }, { surfaceOp: 'append' })
      agent.session.append('context/message', {
        content: [{ type: 'text', text: 'foreign plugin context' }],
        source: { kind: 'plugin', plugin: 'other' },
        meta: {
          kind: 'workspace-instructions',
          version: 1,
          changes: [{ action: 'set', scope: 'pkg', path: join('pkg', 'AGENTS.md'), digest: 'spoof' }],
        },
      }, { surfaceOp: 'append' })

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-spoofed-state'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })

      expect(blocksText(workspaceContextOf(result)?.content)).toContain('nested package rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads nested instructions for absolute touched paths but not root-level files', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'root.txt'), 'root file')
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const rootResult = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-root-file'),
        name: 'read',
        arguments: { file_path: 'root.txt' },
        agent,
      })
      const absoluteResult = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-absolute-nested-file'),
        name: 'read',
        arguments: { file_path: join(root, 'pkg/deep/file.txt') },
        agent,
      })

      expect(rootResult.additionalContexts).toBeUndefined()
      expect(blocksText(workspaceContextOf(absoluteResult)?.content)).toContain('nested package rule')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('treats a reconciliation provider failure as unavailable and a resolved non-file as absent', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.throwOnStat.add(join(root, 'pkg/AGENTS.md'))
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      const result = {
        callId: CallId('provider-probe-result'),
        content: [{ type: 'text' as const, text: 'ok' }],
        isError: false,
      }

      const failedStat = await ctx.waterfall('tools/post-execute', stubToolExecution({
        signal: testToolSignal,
        callId: CallId('provider-stat-failure'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      }), result, async () => ({ kind: 'accept' as const }))
      fs.throwOnStat.clear()
      fs.entries.set(join(root, 'pkg/AGENTS.md'), { type: 'directory' })
      const mismatchedStat = await ctx.waterfall('tools/post-execute', stubToolExecution({
        signal: testToolSignal,
        callId: CallId('provider-stat-mismatch'), name: 'read', arguments: { file_path: join('pkg', 'file.txt') }, agent,
      }), result, async () => ({ kind: 'accept' as const }))

      expect(failedStat).toEqual({ kind: 'accept' })
      expect(mismatchedStat).toEqual({ kind: 'accept' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('skips unreadable nested instruction files without attaching empty context', async () => {
    // Cross-platform unreadable fixture: the provider read throws (chmod 0
    // cannot make a file unreadable to its owner on Windows).
    const root = await tempRepo()
    const home = await tempRepo()
    const ctx = new Context()
    try {
      const nested = join(root, 'pkg/AGENTS.md')
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(RecordingFileSystem)
      const fs = ctx.fs as RecordingFileSystem
      fs.entries.set(join(root, '.git'), { type: 'directory' })
      fs.entries.set(nested, { type: 'file', content: 'nested package rule' })
      fs.entries.set(join(root, 'pkg/deep/file.txt'), { type: 'file', content: 'hello' })
      fs.throwOnRead.add(nested)
      await ctx.plugin(ToolFs)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-with-unreadable-nested-instruction'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent: stubAgent(root),
      })

      expect(result.isError).toBe(false)
      expect(result.additionalContexts).toBeUndefined()
      expect(fs.readTargets).toContain(nested)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('preserves nested and downstream post-execute contexts as separate entries', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      ctx.on('tools/post-execute', async () => ({
        kind: 'accept' as const,
        content: [{ type: 'text' as const, text: 'downstream replacement' }],
        additionalContexts: [{
          content: [{ type: 'text' as const, text: 'downstream context' }],
          source: { kind: 'plugin' as const, plugin: 'downstream' },
        }],
      }))

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-with-downstream'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent: stubAgent(root),
      })

      expect(blocksText(result.content)).toBe('downstream replacement')
      expect(result.additionalContexts).toHaveLength(2)
      expect(workspaceContextOf(result)?.source).toEqual({ kind: 'plugin', plugin: 'workspace-context' })
      expect(workspaceContextOf(result)?.meta).toMatchObject({
        kind: 'workspace-instructions',
        changes: [{ action: 'set', scope: sk('pkg', 'AGENTS.md'), path: join('pkg', 'AGENTS.md') }],
      })
      expect(blocksText(workspaceContextOf(result)?.content)).toContain('nested package rule')
      expect(blocksText(workspaceContextOf(result)?.content)).not.toContain('downstream context')
      expect(result.additionalContexts?.[1]).toEqual({
        content: [{ type: 'text', text: 'downstream context' }],
        source: { kind: 'plugin', plugin: 'downstream' },
      })
      const agent = stubAgent(root)
      appendAdditionalContexts(agent, result)
      expect(blocksText(agent.session.deriveMessages()[1]?.content)).toContain('downstream context')
      expect(blocksText(agent.session.deriveMessages()[1]?.content)).not.toContain('<context source=')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not attach discovered instructions when a downstream listener blocks the tool call', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      ctx.on('tools/post-execute', async () => ({
        kind: 'block' as const,
        feedback: [{ type: 'text' as const, text: 'blocked downstream' }],
      }))

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-blocked-downstream'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent: stubAgent(root),
      })

      // The pipeline rejected this touch, so no workspace instructions from it
      // should reach the model, and the block feedback must survive unchanged.
      expect(result.isError).toBe(true)
      expect(blocksText(result.content)).toBe('blocked downstream')
      expect(result.additionalContexts).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not commit pending state when an outer post-execute listener blocks the final result', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    const ctx = new Context()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(ToolFs)
      let shouldBlock = true
      ctx.on('tools/post-execute', async (_exec, _result, next) => {
        const downstream = await next()
        return shouldBlock
          ? { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'outer policy block' }] }
          : downstream
      })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const blocked = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('outer-block-first'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })
      shouldBlock = false
      const accepted = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('outer-block-retry'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent,
      })

      expect(blocked.isError).toBe(true)
      expect(blocked.additionalContexts).toBeUndefined()
      expect(accepted.isError).toBe(false)
      expect(blocksText(workspaceContextOf(accepted)?.content)).toContain('nested package rule')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rolls back parent-token pending state when a composite result is blocked', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    const ctx = new Context()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(ToolFs)
      ctx.tools.register(defineTool({
        name: 'composite-read',
        description: 'read through a nested dispatch',
        parameters: {},
        async execute(_args, exec) {
          const nested = await ctx.tools.execute({
            signal: testToolSignal,
            callId: CallId(`${exec.callId}:nested`),
            name: 'read',
            arguments: { file_path: join('pkg', 'deep', 'file.txt') },
            ...exec.agent === undefined ? {} : { agent: exec.agent },
            parent: exec.token,
            ...exec.signal === undefined ? {} : { signal: exec.signal },
          })
          for (const context of nested.additionalContexts ?? []) exec.deferContext(context)
          return nested.content
        },
      }))
      let shouldBlock = true
      ctx.on('tools/post-execute', async (exec, _result, next) => {
        const downstream = await next()
        return exec.name === 'composite-read' && shouldBlock
          ? { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'outer composite block' }] }
          : downstream
      })
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)

      const blocked = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('composite-first'), name: 'composite-read', arguments: {}, agent,
      })
      shouldBlock = false
      const accepted = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('composite-retry'), name: 'composite-read', arguments: {}, agent,
      })

      expect(blocked.isError).toBe(true)
      expect(blocked.additionalContexts).toBeUndefined()
      expect(accepted.isError).toBe(false)
      expect(blocksText(workspaceContextOf(accepted)?.content)).toContain('nested package rule')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('handles defensive tools/result observer branches without retaining staged state', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(workspaceContext, { maxBytes: 65536 })
      const agent = stubAgent('/')
      const parent = Symbol('parent') as ToolExecutionToken
      const plainResult = { callId: CallId('plain'), content: [], isError: false }

      ctx.emit('tools/result', stubToolExecution({
        signal: testToolSignal,
        callId: CallId('agentless-child'), name: 'read', arguments: {}, parent,
      }), plainResult)
      ctx.emit('tools/result', stubToolExecution({
        signal: testToolSignal,
        callId: CallId('contextless-child'), name: 'read', arguments: {}, agent, parent,
      }), { ...plainResult, additionalContexts: [{ content: [], source: { kind: 'plugin', plugin: 'workspace-context' } }] })
      ctx.emit('tools/result', stubToolExecution({
        signal: testToolSignal,
        callId: CallId('first-child'), name: 'read', arguments: {}, agent, parent,
      }), { ...plainResult, additionalContexts: [workspaceChangeContext('first', 'one')] })
      ctx.emit('tools/result', stubToolExecution({
        signal: testToolSignal,
        callId: CallId('second-child'), name: 'read', arguments: {}, agent, parent,
      }), { ...plainResult, additionalContexts: [workspaceChangeContext('second', 'two')] })
      ctx.emit('tools/result', {
        ...stubToolExecution({ signal: testToolSignal, callId: CallId('agentless-parent'), name: 'composite', arguments: {} }),
        token: parent,
      }, plainResult)

      expect(agent.session.deriveMessages()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores post-execute events that are not successful structured file touches', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      const result = {
        callId: CallId('manual'),
        content: [{ type: 'text' as const, text: 'manual result' }],
        isError: false,
      }
      const cases = [
        { name: 'read', arguments: { file_path: join('pkg', 'deep', 'file.txt') }, agent: undefined },
        { name: 'bash', arguments: { file_path: join('pkg', 'deep', 'file.txt') }, agent },
        { name: 'read', arguments: null, agent },
        { name: 'read', arguments: {}, agent },
        { name: 'read', arguments: { file_path: 1 }, agent },
        { name: 'read', arguments: { file_path: '   ' }, agent },
      ]

      for (const item of cases) {
        const decision = await ctx.waterfall('tools/post-execute', stubToolExecution({
          signal: testToolSignal,
          callId: CallId(`manual-${item.name}-${cases.indexOf(item)}`),
          name: item.name,
          arguments: item.arguments,
          ...item.agent === undefined ? {} : { agent: item.agent },
        }), result, async () => ({ kind: 'accept' as const }))
        expect(decision).toEqual({ kind: 'accept' })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not attach nested instructions when the byte budget is disabled', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 0 })

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-with-disabled-budget'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent: stubAgent(root),
      })

      expect(result.isError).toBe(false)
      expect(result.additionalContexts).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not attach nested instructions after a failed file read', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      const ctx = new Context()
      await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-missing'),
        name: 'read',
        arguments: { file_path: join('pkg', 'missing.txt') },
        agent: stubAgent(root),
      })

      expect(result.isError).toBe(true)
      expect(result.additionalContexts).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('cleans up its tools/post-execute listener when the plugin fiber is disposed', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
      await write(join(root, 'pkg/deep/file.txt'), 'hello')
      const ctx = new Context()
      const fiber = await mountFileToolsAndWorkspaceContext(ctx, { dshHome: home, maxBytes: 65536 })
      await fiber.dispose()

      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('read-after-dispose'),
        name: 'read',
        arguments: { file_path: join('pkg', 'deep', 'file.txt') },
        agent: stubAgent(root),
      })

      expect(result.isError).toBe(false)
      expect(result.additionalContexts).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('workspace context pending state', () => {
  it('leaves pending transitions from other or untracked steps untouched', () => {
    const agent = stubAgent('/')
    const change = (scope: string) => ({
      action: 'set' as const, scope, path: `${scope}/AGENTS.md`, digest: scope,
    })
    const pending = new WeakMap<object, Map<string, PendingInstructionChange>>([[
      agent.session,
      new Map([
        ['untracked', { change: change('untracked'), afterSeq: 0 }],
        ['other-turn', { change: change('other-turn'), afterSeq: 0, step: { turn: 2, step: 1 } }],
        ['other-step', { change: change('other-step'), afterSeq: 0, step: { turn: 1, step: 2 } }],
        ['current', { change: change('current'), afterSeq: 0, step: { turn: 1, step: 1 } }],
      ]),
    ]])
    const versions: InstructionVersionCache = new WeakMap()
    const ended = agent.session.append('step/end', { turn: 1, step: 1 })

    observeInstructionSessionEvent(agent.session, ended, pending, versions)

    expect([...pending.get(agent.session)?.keys() ?? []]).toEqual(['untracked', 'other-turn', 'other-step'])
  })

  it('confirms a pending transition only when its matching workspace context reaches the log', () => {
    const agent = stubAgent('/')
    const pending = new WeakMap<object, Map<string, PendingInstructionChange>>()
    const versions: InstructionVersionCache = new WeakMap()
    const [change] = commitPendingInstructionContexts(agent, [workspaceChangeContext('pkg', 'one')], pending)
    expect(change).toBeDefined()
    versions.set(agent.session, new Map([['pkg', {
      path: join('pkg', 'AGENTS.md'), version: FsVersion('v1'), digest: 'one', trimmedDigest: 'one',
    }]]))

    const unrelated = agent.session.append('context/message', {
      content: [], source: { kind: 'plugin', plugin: 'other' },
    }, { surfaceOp: 'append' })
    observeInstructionSessionEvent(agent.session, unrelated, pending, versions)
    expect(pending.get(agent.session)?.has('pkg')).toBe(true)

    const otherContext = workspaceChangeContext('other', 'other')
    const otherWorkspaceEvent = agent.session.append('context/message', {
      content: otherContext.content,
      source: otherContext.source,
      ...otherContext.meta !== undefined ? { meta: otherContext.meta } : {},
    }, { surfaceOp: 'append' })
    observeInstructionSessionEvent(agent.session, otherWorkspaceEvent, pending, versions)
    expect(pending.get(agent.session)?.has('pkg')).toBe(true)

    const context = workspaceChangeContext('pkg', 'one')
    const confirmed = agent.session.append('context/message', {
      content: context.content,
      source: context.source,
      ...context.meta !== undefined ? { meta: context.meta } : {},
    }, { surfaceOp: 'append' })
    observeInstructionSessionEvent(agent.session, confirmed, pending, versions)

    expect(pending.has(agent.session)).toBe(false)
    expect(versions.get(agent.session)?.has('pkg')).toBe(true)
  })

  it('discards pending state and its version fast path when the owning step closes first', () => {
    const agent = stubAgent('/')
    const pending = new WeakMap<object, Map<string, PendingInstructionChange>>()
    const versions: InstructionVersionCache = new WeakMap()
    agent.session.append('step/start', { turn: 1, step: 1 })
    commitPendingInstructionContexts(agent, [workspaceChangeContext('pkg', 'one')], pending)
    versions.set(agent.session, new Map([['pkg', {
      path: join('pkg', 'AGENTS.md'), version: FsVersion('v1'), digest: 'one', trimmedDigest: 'one',
    }]]))

    const ended = agent.session.append('step/end', { turn: 1, step: 1 })
    observeInstructionSessionEvent(agent.session, ended, pending, versions)

    expect(pending.has(agent.session)).toBe(false)
    expect(versions.has(agent.session)).toBe(false)
  })

  it('rolls back only the exact current transition and releases empty session state', () => {
    const agent = stubAgent('/')
    const pending = new WeakMap<object, Map<string, PendingInstructionChange>>()

    rollbackPendingInstructionChanges(agent, [{
      action: 'set', scope: 'missing', path: 'missing/AGENTS.md', digest: 'none',
    }], pending)
    expect(commitPendingInstructionContexts(agent, [{
      content: [], source: { kind: 'plugin', plugin: 'workspace-context' },
    }], pending)).toEqual([])

    const committed = commitPendingInstructionContexts(agent, [
      workspaceChangeContext('first', 'one'),
      workspaceChangeContext('second', 'two'),
    ], pending)
    const [first, second] = committed
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    const [newer] = commitPendingInstructionContexts(agent, [workspaceChangeContext('first', 'newer')], pending)
    rollbackPendingInstructionChanges(agent, [first!], pending)
    rollbackPendingInstructionChanges(agent, [{
      action: 'set', scope: 'unknown', path: 'unknown/AGENTS.md', digest: 'unknown',
    }], pending)
    rollbackPendingInstructionChanges(agent, [second!], pending)
    expect(pending.get(agent.session)?.get('first')?.change).toEqual(newer)

    rollbackPendingInstructionChanges(agent, [newer!], pending)
    expect(pending.has(agent.session)).toBe(false)
  })
})

describe('workspace context plugin export shape', () => {
  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/Config/apply', () => {
    expect('default' in workspaceContext).toBe(false)
    expect(typeof workspaceContext.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(workspaceContext) as Record<string, unknown>
    expect(unwrapped).toBe(workspaceContext)
    expect(unwrapped.name).toBe('workspace-context')
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
