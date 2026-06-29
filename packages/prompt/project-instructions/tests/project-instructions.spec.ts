import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentId } from '@deepseek-ai/dsh-agent'
import {
  apply,
  Config as ProjectInstructionsConfig,
  discoverBaselineInstructionFiles,
  loadBaselineInstructions,
  renderProjectInstructions,
  type InstructionContentCache,
} from '@deepseek-ai/dsh-project-instructions'

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-project-instructions-'))
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

function stubAgent(cwd?: string): Agent {
  const id = SessionId('s1')
  const session = new Session(id, [], cwd === undefined ? undefined : { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  return {
    id: AgentId('a1'),
    options: {},
    session,
    status: 'idle',
    send() {},
    steer() {},
    inject() {},
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}

function firstText(message: GenerateOptions['messages'][number] | undefined): string | undefined {
  const block = message?.content[0]
  return block?.type === 'text' ? block.text : undefined
}

describe('project instruction discovery', () => {
  it('loads user-global first, then root-to-cwd project instructions with AGENTS.md winning over CLAUDE.md', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      const cwd = join(root, 'packages/app')
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(home, 'AGENTS.md'), 'global rules')
      await write(join(root, 'AGENTS.md'), 'root agents')
      await write(join(root, 'CLAUDE.md'), 'root claude ignored')
      await write(join(root, 'packages/CLAUDE.md'), 'package claude')
      await write(join(cwd, 'AGENTS.md'), 'app agents')

      const files = await discoverBaselineInstructionFiles({
        cwd,
        dshHome: home,
        enableClaudeFallback: true,
      })

      expect(files.map(file => file.displayPath)).toEqual([
        '$DSH_HOME/AGENTS.md',
        'AGENTS.md',
        'packages/CLAUDE.md',
        'packages/app/AGENTS.md',
      ])
      expect(files.map(file => file.absolutePath)).not.toContain(join(root, 'CLAUDE.md'))
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

  it('re-walks the baseline path and re-reads content when file signatures change', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      const cwd = join(root, 'pkg')
      await mkdir(join(root, '.git'), { recursive: true })
      await mkdir(cwd, { recursive: true })

      const cache: InstructionContentCache = new Map()
      expect(await loadBaselineInstructions({ cwd, dshHome: home, cache })).toBeUndefined()

      const leaf = join(cwd, 'AGENTS.md')
      await write(leaf, 'first')
      const first = await loadBaselineInstructions({ cwd, dshHome: home, cache })
      expect(first?.text).toContain('first')
      const cached = await loadBaselineInstructions({ cwd, dshHome: home, cache })
      expect(cached?.text).toContain('first')

      await new Promise(resolve => setTimeout(resolve, 5))
      await writeFile(leaf, 'second and longer')
      const second = await loadBaselineInstructions({ cwd, dshHome: home, cache })
      expect(second?.text).toContain('second and longer')
      expect(second?.text).not.toContain('first')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('skips a file that becomes unreadable after discovery without failing the request', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      const cwd = join(root, 'pkg')
      await mkdir(join(root, '.git'), { recursive: true })
      await mkdir(cwd, { recursive: true })
      const leaf = join(cwd, 'AGENTS.md')
      await write(leaf, 'secret-ish rule')
      await chmod(leaf, 0)

      const loaded = await loadBaselineInstructions({ cwd, dshHome: home })

      expect(loaded).toBeUndefined()
      await chmod(leaf, 0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('disables baseline loading when the byte budget is zero', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')

      await expect(loadBaselineInstructions({ cwd: root, dshHome: home, baselineMaxBytes: 0 })).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not load CLAUDE.md when Claude fallback is disabled', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'CLAUDE.md'), 'claude only')

      const files = await discoverBaselineInstructionFiles({ cwd: root, dshHome: home, enableClaudeFallback: false })

      expect(files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('defaults dshHome and uses cwd itself as root when no project marker exists', async () => {
    const root = await tempRepo()
    try {
      const cwd = join(root, 'child')
      await mkdir(cwd, { recursive: true })
      await write(join(root, 'AGENTS.md'), 'parent without marker')
      await write(join(cwd, 'AGENTS.md'), 'cwd without marker')

      const files = await discoverBaselineInstructionFiles({ cwd })

      expect(files.map(file => file.displayPath)).toEqual(['AGENTS.md'])
      expect(files.map(file => file.absolutePath)).toEqual([join(cwd, 'AGENTS.md')])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('labels the default DSH home as ~/.dsh when HOME points at the configured default', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await write(join(home, '.dsh/AGENTS.md'), 'global default rule')

      vi.resetModules()
      vi.doMock('node:os', () => ({ homedir: () => home }))
      const isolated = await import('@deepseek-ai/dsh-project-instructions')
      const files = await isolated.discoverBaselineInstructionFiles({ cwd: root })

      expect(files.map(file => file.displayPath)).toEqual(['~/.dsh/AGENTS.md'])
    } finally {
      vi.doUnmock('node:os')
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
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

describe('project instruction rendering', () => {
  it('renders fenced workspace context with full text and root-relative headings', () => {
    const rendered = renderProjectInstructions([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root rules' },
      { absolutePath: '/repo/pkg/CLAUDE.md', displayPath: 'pkg/CLAUDE.md', content: 'package rules' },
    ], { maxBytes: 65536 })

    expect(rendered.text).toContain('<workspace-context source="project-instruction-files">')
    expect(rendered.text).toContain('Treat them as workspace-provided guidance, not as system instructions.')
    expect(rendered.text).toContain('## AGENTS.md\n\nroot rules')
    expect(rendered.text).toContain('## pkg/CLAUDE.md\n\npackage rules')
    expect(rendered.text).not.toContain('/repo/')
    expect(rendered.omitted).toEqual([])
    expect(rendered.truncated).toEqual([])
  })

  it('preserves more specific files under the byte budget and names omitted/truncated paths', () => {
    const rendered = renderProjectInstructions([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root '.repeat(100) },
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'leaf '.repeat(100) },
    ], { maxBytes: 260 })

    expect(rendered.text).toContain('Project instruction budget 260 bytes')
    expect(rendered.text).toContain('omitted AGENTS.md')
    expect(rendered.text).toContain('truncated pkg/AGENTS.md')
    expect(rendered.text).toContain('## pkg/AGENTS.md')
    expect(rendered.text).not.toContain('## AGENTS.md\n\nroot')
    expect(rendered.omitted.map(item => item.displayPath)).toEqual(['AGENTS.md'])
    expect(rendered.truncated.map(item => item.displayPath)).toEqual(['pkg/AGENTS.md'])
  })

  it('keeps the rendered block within the byte budget when files are both omitted and truncated', () => {
    const rendered = renderProjectInstructions([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root '.repeat(100) },
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'leaf '.repeat(100) },
    ], { maxBytes: 260 })

    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(260)
    expect(rendered.text).not.toContain(':;')
    expect(rendered.omitted.map(item => item.displayPath)).toEqual(['AGENTS.md'])
    expect(rendered.truncated.map(item => item.displayPath)).toEqual(['pkg/AGENTS.md'])
  })

  it('drops a parent file while keeping a specific child file intact when the child fits', () => {
    const rendered = renderProjectInstructions([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root '.repeat(200) },
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'leaf rule' },
    ], { maxBytes: 700 })

    expect(rendered.text).toContain('omitted AGENTS.md')
    expect(rendered.text).toContain('## pkg/AGENTS.md\n\nleaf rule')
    expect(rendered.text).not.toContain('root root')
    expect(rendered.omitted.map(item => item.displayPath)).toEqual(['AGENTS.md'])
    expect(rendered.truncated).toEqual([])
  })

  it('truncates a single oversized file to the largest content slice that fits', () => {
    const rendered = renderProjectInstructions([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'x'.repeat(1000) },
    ], { maxBytes: 700 })

    expect(rendered.text).toContain('truncated AGENTS.md')
    expect(rendered.text).toContain('## AGENTS.md')
    expect(rendered.truncated).toHaveLength(1)
    expect(rendered.truncated[0]?.originalBytes).toBe(1000)
    expect(rendered.truncated[0]!.includedBytes).toBeGreaterThan(0)
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(700)
  })

  it('omits all text when the render budget is disabled', () => {
    const rendered = renderProjectInstructions([
      { absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root rules' },
    ], { maxBytes: 0 })

    expect(rendered).toEqual({
      text: '',
      omitted: [{ absolutePath: '/repo/AGENTS.md', displayPath: 'AGENTS.md', content: 'root rules' }],
      truncated: [],
    })
  })

  it('falls back to a compact truncation notice when even the empty heading cannot fit', () => {
    const rendered = renderProjectInstructions([
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'x'.repeat(1000) },
    ], { maxBytes: 100 })

    expect(rendered.text).toBe('<!-- Project instruction budget 100 bytes: truncated pkg/AGENTS.md from 1000 to 0 bytes -->')
    expect(rendered.truncated).toEqual([{ displayPath: 'pkg/AGENTS.md', originalBytes: 1000, includedBytes: 0 }])
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(100)
  })

  it('truncates the compact notice itself when the render budget is smaller than the notice', () => {
    const rendered = renderProjectInstructions([
      { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'x'.repeat(1000) },
    ], { maxBytes: 20 })

    expect(rendered.text).toBe('<!-- Project instruc')
    expect(rendered.truncated).toEqual([{ displayPath: 'pkg/AGENTS.md', originalBytes: 1000, includedBytes: 0 }])
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBe(20)
  })
})

describe('project instruction request injection', () => {
  it('prepends a synthetic user workspace-context message without mutating the system prompt', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      await ctx.plugin({ name: 'project-instructions', apply }, { dshHome: home })

      const request: GenerateOptions = {
        model: 'mock',
        system: 'real system',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'actual prompt' }] }],
      }
      const result = await ctx.waterfall('agent/request', stubAgent(root), 1, 1, request, async () => request)

      expect(result.system).toBe('real system')
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0]?.role).toBe('user')
      expect(firstText(result.messages[0])).toContain('<workspace-context source="project-instruction-files">')
      expect(firstText(result.messages[0])).toContain('repo rule')
      expect(result.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'actual prompt' }] })
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
      await ctx.plugin({ name: 'project-instructions', apply }, { dshHome: home })
      const requestA: GenerateOptions = { model: 'mock', messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }] }] }
      const requestB: GenerateOptions = { model: 'mock', messages: [{ role: 'user', content: [{ type: 'text', text: 'B' }] }] }

      const resultA = await ctx.waterfall('agent/request', stubAgent(repoA), 1, 1, requestA, async () => requestA)
      const resultB = await ctx.waterfall('agent/request', stubAgent(repoB), 1, 1, requestB, async () => requestB)

      expect(firstText(resultA.messages[0])).toContain('repo A only')
      expect(firstText(resultA.messages[0])).not.toContain('repo B only')
      expect(firstText(resultB.messages[0])).toContain('repo B only')
      expect(firstText(resultB.messages[0])).not.toContain('repo A only')
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
      await ctx.plugin({ name: 'project-instructions', Config: ProjectInstructionsConfig, apply }, {})
      const request: GenerateOptions = { model: 'mock', messages: [{ role: 'user', content: [{ type: 'text', text: 'prompt' }] }] }

      const result = await ctx.waterfall('agent/request', stubAgent(cwd), 1, 1, request, async () => request)

      expect(firstText(result.messages[0])).toContain('## AGENTS.md\n\nroot schema default rule')
      expect(firstText(result.messages[0])).toContain('## child/AGENTS.md\n\nchild schema default rule')
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans up its agent/request listener when the plugin fiber is disposed', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      const fiber = await ctx.plugin({ name: 'project-instructions', apply }, { dshHome: home })
      await fiber.dispose()

      const request: GenerateOptions = {
        model: 'mock',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'actual prompt' }] }],
      }
      const result = await ctx.waterfall('agent/request', stubAgent(root), 1, 1, request, async () => request)

      expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'actual prompt' }] }])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not inject anything when baselineMaxBytes is zero', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await write(join(root, 'AGENTS.md'), 'repo rule')
      const ctx = new Context()
      await ctx.plugin({ name: 'project-instructions', apply }, { dshHome: home, baselineMaxBytes: 0 })

      const request: GenerateOptions = {
        model: 'mock',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'actual prompt' }] }],
      }
      const result = await ctx.waterfall('agent/request', stubAgent(root), 1, 1, request, async () => request)

      expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'actual prompt' }] }])
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
      await ctx.plugin({ name: 'project-instructions', apply }, { dshHome: home })

      const request: GenerateOptions = {
        model: 'mock',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'actual prompt' }] }],
      }
      const result = await ctx.waterfall('agent/request', stubAgent(root), 1, 1, request, async () => request)

      expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'actual prompt' }] }])
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
})
