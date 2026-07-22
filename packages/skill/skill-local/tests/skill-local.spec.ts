import { describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import SkillService from '@deepseek-ai/dsh-skill'
import { FileSystem, FsVersion, type FsDirEntry, type FsEditOutcome, type FsEditRequest, type FsInfo, type FsPathInfo, type FsTarget, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import * as SkillLocal from '../src/index.ts'

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
}

async function writeSkill(root: string, name: string, description: string, body = 'Use the skill.'): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function writeFlatSkill(root: string, name: string, description: string, body = 'Flat body.'): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

class TestFileSystem extends FileSystem {
  listDirCalls = 0
  failResolvePaths = new Set<string>()
  failStatPaths = new Set<string>()
  statOverrides = new Map<string, FsInfo | undefined>()
  statSignals: Array<AbortSignal | undefined> = []
  readTextSignals: Array<AbortSignal | undefined> = []
  readTextOverride?: (target: FsTarget, signal?: AbortSignal) => Promise<string>

  override async resolve(path: string): Promise<FsTarget> {
    if (this.failResolvePaths.has(path)) throw new Error('resolve failed')
    return { targetKey: path as never, displayPath: path }
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    this.statSignals.push(signal)
    if (this.failStatPaths.has(target.displayPath)) throw new Error('stat failed')
    if (this.statOverrides.has(target.displayPath)) return this.statOverrides.get(target.displayPath)
    try {
      const fs = await import('node:fs/promises')
      const info = await fs.stat(target.displayPath)
      return {
        version: FsVersion(String(info.mtimeMs)),
        type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
        size: info.size,
      }
    } catch {
      return undefined
    }
  }

  override async lstat(path: string): Promise<FsPathInfo | undefined> {
    try {
      const fs = await import('node:fs/promises')
      const info = await fs.lstat(path)
      return {
        version: FsVersion(String(info.mtimeMs)),
        type: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
        size: info.size,
      }
    } catch {
      return undefined
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    this.readTextSignals.push(signal)
    if (this.readTextOverride !== undefined) return await this.readTextOverride(target, signal)
    const text = await readFile(target.displayPath, 'utf8')
    if (text.includes('\uFFFD')) throw new Error('not text')
    return text
  }

  override async streamText(_target: FsTarget): Promise<AsyncIterable<string>> {
    throw new Error('not needed in skill tests')
  }

  override async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    this.listDirCalls += 1
    const entries = await readdir(target.displayPath, { withFileTypes: true, encoding: 'utf8' })
    const result: FsDirEntry[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = join(target.displayPath, entry.name)
      let type: FsInfo['type'] = 'other'
      let size: number | undefined
      try {
        const info = await stat(childPath)
        type = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
        size = info.isFile() ? info.size : undefined
      } catch {
        type = 'other'
      }
      result.push({
        name: entry.name,
        type,
        target: { targetKey: childPath as never, displayPath: childPath },
        version: FsVersion('test'),
        ...(size !== undefined ? { size } : {}),
      })
    }
    return result
  }

  override async writeText(target: FsTarget, content: string): Promise<FsWriteOutcome> {
    await mkdir(dirname(target.displayPath), { recursive: true })
    await writeFile(target.displayPath, content)
    return { operation: 'create', version: FsVersion('test'), before: null, after: content }
  }

  override async editText(_target: FsTarget, _request: FsEditRequest): Promise<FsEditOutcome> {
    throw new Error('not needed in skill tests')
  }
}

async function setupLocal(home: string, config: Partial<SkillLocal.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillService)
  await ctx.plugin(SkillLocal, {
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    ...config,
  })
  return ctx
}

describe('dsh-skill-local plugin exports', () => {
  it('declares stable plugin metadata', () => {
    expect(SkillLocal.name).toBe('skill-local')
    expect(SkillLocal.inject).toEqual(['skills'])
  })
})

describe('LocalSkillProvider', () => {
  it('discovers project, custom, user, and agents skill roots in priority order', async () => {
    const home = await tempDir('skill-home')
    const project = await tempDir('skill-project')
    const custom = await tempDir('skill-custom')
    await mkdir(join(project, '.git'), { recursive: true })

    await writeSkill(join(home, '.agents/skills'), 'same', 'user agents skill')
    await writeSkill(join(home, '.dsh/skills'), 'same', 'user dsh skill')
    await writeSkill(custom, 'same', 'custom skill')
    await writeSkill(join(project, '.agents/skills'), 'same', 'project agents skill')
    await writeSkill(join(project, '.dsh/skills'), 'same', 'project dsh skill')
    await writeSkill(custom, 'custom-only', 'custom only')
    await writeSkill(join(home, '.dsh/skills/.system'), 'hidden-system', 'hidden system')

    const ctx = await setupLocal(home, { customSkillDirs: [custom] })

    const skills = await ctx.skills.list({ cwd: join(project, 'src') })
    expect(skills.map(skill => [skill.name, skill.description])).toEqual([
      ['custom-only', 'custom only'],
      ['same', 'project dsh skill'],
    ])
    expect(skills.find(skill => skill.name === 'same')?.source).toBe('project-dsh')
    expect(skills.find(skill => skill.name === 'hidden-system')).toBeUndefined()

    const noGit = await tempDir('skill-no-git')
    await writeSkill(join(noGit, '.dsh/skills'), 'fallback-root', 'Fallback root')
    expect((await ctx.skills.list({ cwd: noGit })).map(skill => skill.name)).toContain('fallback-root')
  })

  it('lets project skills override runtime while runtime overrides custom and user skills', async () => {
    const home = await tempDir('skill-runtime-priority')
    const project = await tempDir('skill-runtime-project')
    const custom = await tempDir('skill-runtime-custom')
    await mkdir(join(project, '.git'), { recursive: true })

    await writeSkill(join(project, '.dsh/skills'), 'project-name', 'Project wins')
    await writeSkill(custom, 'runtime-name', 'Custom loses')
    await writeSkill(join(home, '.dsh/skills'), 'runtime-name', 'User loses')

    const ctx = await setupLocal(home, { customSkillDirs: [custom] })
    ctx.skills.register({
      name: 'project-name',
      description: 'Runtime loses to project',
      content: 'Runtime body.',
      source: 'runtime',
    })
    ctx.skills.register({
      name: 'runtime-name',
      description: 'Runtime wins',
      content: 'Runtime body.',
      source: 'runtime',
    })

    expect((await ctx.skills.get('project-name', { cwd: project }))?.description).toBe('Project wins')
    expect((await ctx.skills.get('runtime-name', { cwd: project }))?.description).toBe('Runtime wins')
  })

  it('parses flat skills and filters invalid or model-disabled skills from listing', async () => {
    const home = await tempDir('skill-flat')
    const root = join(home, '.dsh/skills')
    await writeFlatSkill(root, 'flat-skill', 'flat description', 'Flat instructions.')
    await writeFile(join(root, 'rich-skill.md'), [
      '---',
      'name: rich-skill',
      'description: rich description',
      'whenToUse: For richer local parsing',
      'disableModelInvocation: false',
      'metadata:',
      '  owner: tests',
      '---',
      '',
      'Rich body.',
    ].join('\n'))
    await writeFile(join(root, 'bad.md'), '---\nname: Bad_Name\ndescription: bad\n---\n\nbad')
    await writeFile(join(root, 'missing-description.md'), '---\nname: missing-description\n---\n\nbad')
    await writeFile(join(root, 'no-frontmatter.md'), 'No frontmatter.')
    await writeFile(join(root, 'plain-markdown.md'), '# Notes\nNot a skill.')
    await writeFile(join(root, 'open-frontmatter.md'), '---\nname: open-frontmatter')
    await writeFile(join(root, 'non-object.md'), '---\n[]\n---\n\nbad')
    await writeFile(join(root, 'no-trailing-body.md'), '---\nname: no-trailing-body\ndescription: No trailing body\n---')
    await writeFile(join(root, 'notes.txt'), 'ignored')
    await mkdir(join(root, 'not-a-skill'), { recursive: true })
    await writeSkill(root, 'hidden-skill', 'hidden description', 'Hidden.')
    await writeFile(join(root, 'hidden-skill/SKILL.md'), '---\nname: hidden-skill\ndescription: hidden description\ndisableModelInvocation: true\n---\n\nHidden.\n')

    const ctx = await setupLocal(home)
    const listedBeforeDelete = await ctx.skills.list()
    const flatSummary = listedBeforeDelete.find(skill => skill.name === 'flat-skill')
    if (flatSummary === undefined) throw new Error('expected flat-skill')
    await writeFile(join(root, 'flat-skill.md'), '')

    expect(listedBeforeDelete.map(skill => skill.name)).toEqual(['flat-skill', 'no-trailing-body', 'rich-skill'])
    expect(await ctx.skills.get('flat-skill')).toBeUndefined()
    expect((await ctx.skills.get('hidden-skill'))?.content).toContain('Hidden.')
    expect(await ctx.skills.get('rich-skill')).toMatchObject({
      whenToUse: 'For richer local parsing',
      disableModelInvocation: false,
      metadata: { owner: 'tests' },
    })
    expect(await ctx.skills.get('Bad_Name')).toBeUndefined()
  })

  it('supports CRLF frontmatter and ignores delimiter-looking text inside YAML values', async () => {
    const home = await tempDir('skill-frontmatter-crlf')
    const root = join(home, '.dsh/skills')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'crlf-skill.md'), [
      '---',
      'name: crlf-skill',
      'description: CRLF skill',
      'metadata:',
      '  marker: "----"',
      '---',
      '',
      'CRLF body.',
    ].join('\r\n'))
    await writeFile(join(root, 'block-skill.md'), [
      '---',
      'name: block-skill',
      'description: |',
      '  Includes a ---- marker that is not a delimiter.',
      '---',
      '',
      'Block body.',
    ].join('\n'))

    const ctx = await setupLocal(home)

    expect((await ctx.skills.get('crlf-skill'))?.content).toBe('CRLF body.')
    expect((await ctx.skills.get('crlf-skill'))?.metadata).toEqual({ marker: '----' })
    expect((await ctx.skills.get('block-skill'))?.description).toBe('Includes a ---- marker that is not a delimiter.\n')
    expect((await ctx.skills.get('block-skill'))?.content).toBe('Block body.')
  })

  it('skips invalid YAML skill files without hiding valid siblings', async () => {
    const home = await tempDir('skill-invalid-yaml')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'good-skill', 'Good skill')
    await writeFile(join(root, 'bad-yaml.md'), '---\nname: bad-yaml\ndescription: [unclosed\n---\n\nBad body.\n')

    const ctx = await setupLocal(home)

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['good-skill'])
  })

  it('discovers symlinked skill directories and flat files', async () => {
    const home = await tempDir('skill-symlink-home')
    const external = await tempDir('skill-symlink-external')
    await writeSkill(external, 'linked-dir', 'Linked directory')
    await writeFlatSkill(external, 'linked-flat', 'Linked flat')
    await mkdir(join(home, '.dsh/skills'), { recursive: true })
    await symlink(join(external, 'linked-dir'), join(home, '.dsh/skills/linked-dir'))
    await symlink(join(external, 'linked-flat.md'), join(home, '.dsh/skills/linked-flat.md'))
    await symlink(join(external, 'missing'), join(home, '.dsh/skills/broken-link'))
    await symlink('/dev/null', join(home, '.dsh/skills/device-link'))

    const ctx = await setupLocal(home)

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['linked-dir', 'linked-flat'])
  })

  it('uses the filesystem service for discovery, reads, and project-root lookup', async () => {
    const home = await tempDir('skill-read-fs')
    const project = await tempDir('skill-project-root-backend')
    const nestedCwd = join(project, 'packages/app')
    const root = join(home, '.dsh/skills')
    await mkdir(nestedCwd, { recursive: true })
    await writeFlatSkill(root, 'text-skill', 'Text skill', 'Text body.')
    await writeFlatSkill(root, 'resolve-fail', 'Resolve fail', 'Resolve body.')
    await writeFlatSkill(root, 'stat-fail', 'Stat fail', 'Stat body.')
    await mkdir(join(root, 'empty-dir'), { recursive: true })
    await mkdir(join(root, 'directory-skill/SKILL.md'), { recursive: true })
    await writeFile(join(root, 'binary-skill.md'), Buffer.concat([
      Buffer.from('---\nname: binary-skill\ndescription: Binary skill\n---\n\n'),
      Buffer.from([0xff]),
      Buffer.from('\n'),
    ]))
    await writeSkill(join(project, '.agents/skills'), 'backend-root', 'Backend root skill')

    const ctx = new Context()
    await ctx.plugin(TestFileSystem)
    const fs = ctx.fs as TestFileSystem
    fs.failResolvePaths.add(join(root, 'resolve-fail.md'))
    fs.failStatPaths.add(join(root, 'stat-fail.md'))
    fs.failResolvePaths.add(join(nestedCwd, '.git'))
    fs.failStatPaths.add(join(project, 'packages/.git'))
    fs.statOverrides.set(join(project, '.git'), {
      version: FsVersion('virtual-git'),
      type: 'directory',
      size: 0,
    })
    await ctx.plugin(SkillService)
    await ctx.plugin(SkillLocal, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })

    expect((await ctx.skills.list({ cwd: nestedCwd })).map(skill => [skill.name, skill.source])).toEqual([
      ['backend-root', 'project-agents'],
      ['text-skill', 'user-dsh'],
    ])
    expect(fs.listDirCalls).toBeGreaterThan(0)
    expect(await ctx.skills.get('binary-skill')).toBeUndefined()
  })

  it('forwards cancellation to filesystem reads while loading a skill', async () => {
    const home = await tempDir('skill-read-abort')
    await writeSkill(join(home, '.dsh/skills'), 'abortable-skill', 'Abortable skill')

    const ctx = new Context()
    await ctx.plugin(TestFileSystem)
    const fs = ctx.fs as TestFileSystem
    await ctx.plugin(SkillService)
    await ctx.plugin(SkillLocal, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['abortable-skill'])

    fs.statSignals = []
    fs.readTextSignals = []
    const started = Promise.withResolvers<undefined>()
    fs.readTextOverride = async (_target, signal) => {
      if (signal === undefined) throw new Error('expected the skill lookup signal')
      started.resolve(undefined)
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const abortReason = signal.reason as unknown
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason)))
        }, { once: true })
      })
    }
    const controller = new AbortController()
    const reason = new Error('turn cancelled')
    const loading = ctx.skills.get('abortable-skill', { signal: controller.signal })
    await started.promise
    controller.abort(reason)

    await expect(loading).rejects.toBe(reason)
    expect(fs.statSignals).toEqual([controller.signal])
    expect(fs.readTextSignals).toEqual([controller.signal])
  })

  it('uses default home root resolution without exposing builtin skills', async () => {
    const previousDshHome = process.env.DSH_HOME
    const previousAgentsHome = process.env.DSH_AGENTS_HOME
    const envHome = await tempDir('skill-env-home')
    try {
      process.env.DSH_HOME = join(envHome, '.dsh')
      process.env.DSH_AGENTS_HOME = join(envHome, '.agents')
      await writeSkill(join(envHome, '.dsh/skills'), 'env-skill', 'Env skill')
      const ctx = new Context()
      await ctx.plugin(SkillService)
      await ctx.plugin(SkillLocal)
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['env-skill'])

      process.env.DSH_HOME = join(envHome, 'empty-dsh')
      process.env.DSH_AGENTS_HOME = join(envHome, 'empty-agents')
      const empty = new Context()
      await empty.plugin(SkillService)
      SkillLocal.apply(empty, {})
      expect(await empty.skills.list()).toEqual([])

      delete process.env.DSH_AGENTS_HOME
      expect(new SkillLocal.LocalSkillProvider(empty, { dshHome: join(envHome, 'empty-dsh') }).name).toBe('local')
    } finally {
      if (previousDshHome === undefined) {
        delete process.env.DSH_HOME
      } else {
        process.env.DSH_HOME = previousDshHome
      }
      if (previousAgentsHome === undefined) {
        delete process.env.DSH_AGENTS_HOME
      } else {
        process.env.DSH_AGENTS_HOME = previousAgentsHome
      }
    }
  })
})
