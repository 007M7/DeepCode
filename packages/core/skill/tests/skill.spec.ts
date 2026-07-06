import { describe, expect, it, vi } from 'vitest'
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import SkillService from '@deepseek-ai/dsh-skill'
import { FileSystem, FsVersion, type FsDirEntry, type FsEditOutcome, type FsEditRequest, type FsInfo, type FsTarget, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'

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

  override async resolve(path: string): Promise<FsTarget> {
    if (this.failResolvePaths.has(path)) throw new Error('resolve failed')
    return { targetKey: path as never, displayPath: path }
  }

  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    if (this.failStatPaths.has(target.displayPath)) throw new Error('stat failed')
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

  override async readText(target: FsTarget): Promise<string> {
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

describe('SkillService', () => {
  it('discovers project, user, agents, and system skill roots in priority order', async () => {
    const home = await tempDir('skill-home')
    const agentsHome = await tempDir('agents-home')
    const project = await tempDir('skill-project')
    await mkdir(join(project, '.git'), { recursive: true })

    await writeSkill(join(home, '.dsh/skills/.system'), 'same', 'system skill')
    await writeSkill(join(agentsHome, '.agents/skills'), 'same', 'user agents skill')
    await writeSkill(join(home, '.dsh/skills'), 'same', 'user dsh skill')
    await writeSkill(join(project, '.agents/skills'), 'same', 'project agents skill')
    await writeSkill(join(project, '.dsh/skills'), 'same', 'project dsh skill')
    await writeSkill(join(home, '.dsh/skills/.system'), 'system-only', 'system only')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(agentsHome, '.agents'), installSystemSkills: false })

    const skills = await ctx.skills.list({ cwd: join(project, 'src') })
    expect(skills.map(skill => [skill.name, skill.description])).toEqual([
      ['same', 'project dsh skill'],
      ['system-only', 'system only'],
    ])
    expect(skills.find(skill => skill.name === 'same')?.source).toBe('project-dsh')
  })

  it('sorts the final model-visible list by skill name after priority conflict resolution', async () => {
    const home = await tempDir('skill-sorted-home')
    const agentsHome = await tempDir('skill-sorted-agents')
    const project = await tempDir('skill-sorted-project')
    await mkdir(join(project, '.git'), { recursive: true })

    await writeSkill(join(project, '.dsh/skills'), 'z-project', 'Project skill')
    await writeSkill(join(home, '.dsh/skills'), 'm-user', 'User skill')
    await writeSkill(join(home, '.dsh/skills/.system'), 'a-system', 'System skill')
    await writeSkill(join(home, '.dsh/skills/.system'), 'm-user', 'Shadowed system skill')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(agentsHome, '.agents'), installSystemSkills: false })

    expect((await ctx.skills.list({ cwd: project })).map(skill => [skill.name, skill.description])).toEqual([
      ['a-system', 'System skill'],
      ['m-user', 'User skill'],
      ['z-project', 'Project skill'],
    ])
  })

  it('gives project skills priority over runtime skills while runtime overrides user and system skills', async () => {
    const home = await tempDir('skill-runtime-priority')
    const project = await tempDir('skill-runtime-project')
    await mkdir(join(project, '.git'), { recursive: true })

    await writeSkill(join(project, '.dsh/skills'), 'project-name', 'Project wins')
    await writeSkill(join(home, '.dsh/skills'), 'runtime-name', 'User loses')
    await writeSkill(join(home, '.dsh/skills/.system'), 'runtime-name', 'System loses')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })
    ctx.skills.register({
      name: 'project-name',
      description: 'Runtime loses to project',
      content: 'Runtime body.',
      directory: 'memory://project-name',
      source: 'runtime',
    })
    ctx.skills.register({
      name: 'runtime-name',
      description: 'Runtime wins',
      content: 'Runtime body.',
      directory: 'memory://runtime-name',
      source: 'runtime',
    })

    expect((await ctx.skills.get('project-name', { cwd: project }))?.description).toBe('Project wins')
    expect((await ctx.skills.get('runtime-name', { cwd: project }))?.description).toBe('Runtime wins')
  })

  it('does not scan .system twice through the user dsh root', async () => {
    const home = await tempDir('skill-system')
    await writeSkill(join(home, '.dsh/skills/.system'), 'builtin', 'builtin skill')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['builtin'])
  })

  it('parses flat skills and filters invalid or model-disabled skills from listing', async () => {
    const home = await tempDir('skill-flat')
    await writeFlatSkill(join(home, '.dsh/skills'), 'flat-skill', 'flat description', 'Flat instructions.')
    await writeFile(join(home, '.dsh/skills/bad.md'), '---\nname: Bad_Name\ndescription: bad\n---\n\nbad')
    await writeFile(join(home, '.dsh/skills/missing-description.md'), '---\nname: missing-description\n---\n\nbad')
    await writeFile(join(home, '.dsh/skills/no-frontmatter.md'), 'No frontmatter.')
    await writeFile(join(home, '.dsh/skills/plain-markdown.md'), '# Notes\nNot a skill.')
    await writeFile(join(home, '.dsh/skills/open-frontmatter.md'), '---\nname: open-frontmatter')
    await writeFile(join(home, '.dsh/skills/non-object.md'), '---\n[]\n---\n\nbad')
    await writeFile(join(home, '.dsh/skills/no-trailing-body.md'), '---\nname: no-trailing-body\ndescription: No trailing body\n---')
    await writeFile(join(home, '.dsh/skills/notes.txt'), 'ignored')
    await mkdir(join(home, '.dsh/skills/not-a-skill'), { recursive: true })
    await writeSkill(join(home, '.dsh/skills'), 'hidden-skill', 'hidden description', 'Hidden.')
    await writeFile(join(home, '.dsh/skills/hidden-skill/SKILL.md'), '---\nname: hidden-skill\ndescription: hidden description\ndisableModelInvocation: true\n---\n\nHidden.\n')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['flat-skill', 'no-trailing-body'])
    expect((await ctx.skills.get('hidden-skill'))?.content).toContain('Hidden.')
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

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect((await ctx.skills.get('crlf-skill'))?.content).toBe('CRLF body.')
    expect((await ctx.skills.get('crlf-skill'))?.metadata).toEqual({ marker: '----' })
    expect((await ctx.skills.get('block-skill'))?.description).toBe('Includes a ---- marker that is not a delimiter.\n')
    expect((await ctx.skills.get('block-skill'))?.content).toBe('Block body.')
  })

  it('skips invalid YAML skill files without poisoning discovery cache', async () => {
    const home = await tempDir('skill-invalid-yaml')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'good-skill', 'Good skill')
    await writeFile(join(root, 'bad-yaml.md'), '---\nname: bad-yaml\ndescription: [unclosed\n---\n\nBad body.\n')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['good-skill'])
    await writeFile(join(root, 'bad-yaml.md'), '---\nname: fixed-skill\ndescription: Fixed skill\n---\n\nFixed body.\n')

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['good-skill'])
    const dispose = ctx.skills.register({
      name: 'runtime-skill',
      description: 'Runtime skill',
      content: 'Runtime body.',
      directory: 'memory://runtime',
      source: 'runtime',
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['fixed-skill', 'good-skill', 'runtime-skill'])
    dispose()
  })

  it('does not cache a rejected discovery promise', async () => {
    const home = await tempDir('skill-rejected-cache')
    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })
    const internals = ctx.skills as unknown as {
      collectFresh(roots: unknown): Promise<unknown[]>
    }
    const original = internals.collectFresh.bind(ctx.skills)
    let fail = true
    internals.collectFresh = async (roots: unknown) => {
      if (fail) throw new Error('transient discovery failure')
      return await original(roots)
    }

    await expect(ctx.skills.list()).rejects.toThrow('transient discovery failure')
    fail = false
    await writeSkill(join(home, '.dsh/skills'), 'late-good', 'Late good')
    await expect(ctx.skills.list()).resolves.toMatchObject([{ name: 'late-good' }])
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

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['linked-dir', 'linked-flat'])
  })

  it('honors prompt and cache bounds from config', async () => {
    const home = await tempDir('skill-config-bounds')
    const firstProject = await tempDir('skill-config-first')
    const secondProject = await tempDir('skill-config-second')
    await mkdir(join(firstProject, '.git'), { recursive: true })
    await mkdir(join(secondProject, '.git'), { recursive: true })
    await writeSkill(join(firstProject, '.dsh/skills'), 'first-skill', 'abcdefghij')
    await writeSkill(join(secondProject, '.dsh/skills'), 'second-skill', 'Second')

    const ctx = new Context()
    await ctx.plugin(SkillService, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      installSystemSkills: false,
      promptFieldMaxLength: 6,
      collectCacheMaxEntries: 1,
    })

    expect(await ctx.skills.renderModelListing({ cwd: firstProject })).toContain('description: abc...')
    expect((await ctx.skills.list({ cwd: firstProject })).map(skill => skill.name)).toEqual(['first-skill'])
    await writeSkill(join(firstProject, '.dsh/skills'), 'late-first', 'Late first')
    expect((await ctx.skills.list({ cwd: firstProject })).map(skill => skill.name)).toEqual(['first-skill'])
    await ctx.skills.list({ cwd: secondProject })
    expect((await ctx.skills.list({ cwd: firstProject })).map(skill => skill.name)).toEqual(['first-skill', 'late-first'])
  })

  it('rejects invalid positive-integer config caps', async () => {
    const home = await tempDir('skill-invalid-config')
    const ctx = new Context()
    await expect(ctx.plugin(SkillService, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      installSystemSkills: false,
      promptFieldMaxLength: 0,
    })).rejects.toThrow('promptFieldMaxLength')
    await expect(ctx.plugin(SkillService, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      installSystemSkills: false,
      promptFieldMaxLength: 2,
    })).rejects.toThrow('greater than or equal to 3')
    await expect(ctx.plugin(SkillService, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      installSystemSkills: false,
      collectCacheMaxEntries: 1.5,
    })).rejects.toThrow('collectCacheMaxEntries')
  })

  it('renders no model listing when no model-invocable skills exist', async () => {
    const home = await tempDir('skill-empty-listing')
    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect(await ctx.skills.renderModelListing()).toBe('')
    const request = { model: 'm', messages: [], system: 'base' }
    const result = await ctx.waterfall('agent/request', {
      session: { header: { cwd: home } },
    } as never, 1, 1, request, () => Promise.resolve(request))
    expect(result.system).toBe('base')
  })

  it('supports default home root resolution without installing system skills', async () => {
    const previousDshHome = process.env.DSH_HOME
    const envHome = await tempDir('skill-env-home')
    try {
      process.env.DSH_HOME = join(envHome, '.dsh')
      await new Context().plugin(SkillService, { installSystemSkills: false })

      delete process.env.DSH_HOME
      await new Context().plugin(SkillService, { installSystemSkills: false })
    } finally {
      if (previousDshHome === undefined) {
        delete process.env.DSH_HOME
      } else {
        process.env.DSH_HOME = previousDshHome
      }
    }
  })

  it('keeps constructor defaults when schema preprocessing is not involved', async () => {
    const home = await tempDir('skill-constructor-defaults')
    const service = new SkillService(new Context(), {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
    })

    expect((await service.list()).map(skill => skill.name)).toEqual(['dsh-plugin-creator', 'dsh-skill-creator'])
  })

  it('installs system skills into the DSH home without overwriting existing files', async () => {
    const home = await tempDir('skill-install')
    const existing = join(home, '.dsh/skills/.system/dsh-plugin-creator/SKILL.md')
    await mkdir(join(home, '.dsh/skills/.system/dsh-plugin-creator'), { recursive: true })
    await writeFile(existing, '---\nname: dsh-plugin-creator\ndescription: Custom system skill\n---\n\nCustom body.\n')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })

    expect((await ctx.skills.list()).map(skill => [skill.name, skill.description])).toEqual([
      ['dsh-plugin-creator', 'Custom system skill'],
      ['dsh-skill-creator', 'Create or update DeepSeek Harness SKILL.md instructions.'],
    ])
    expect(await readFile(existing, 'utf8')).toContain('Custom body.')
    expect(await readFile(join(home, '.dsh/skills/.system/dsh-skill-creator/SKILL.md'), 'utf8')).toContain('dsh-skill-creator')
  })

  it('uses the filesystem service when installing bundled system skills', async () => {
    const home = await tempDir('skill-install-fs')
    const existing = join(home, '.dsh/skills/.system/dsh-plugin-creator/SKILL.md')
    await mkdir(join(home, '.dsh/skills/.system/dsh-plugin-creator'), { recursive: true })
    await writeFile(existing, '---\nname: dsh-plugin-creator\ndescription: Existing system skill\n---\n\nExisting body.\n')

    const ctx = new Context()
    await ctx.plugin(TestFileSystem)
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })

    expect((await ctx.skills.list()).map(skill => [skill.name, skill.description])).toEqual([
      ['dsh-plugin-creator', 'Existing system skill'],
      ['dsh-skill-creator', 'Create or update DeepSeek Harness SKILL.md instructions.'],
    ])
    expect(await readFile(existing, 'utf8')).toContain('Existing body.')
    expect(await readFile(join(home, '.dsh/skills/.system/dsh-skill-creator/SKILL.md'), 'utf8')).toContain('dsh-skill-creator')
  })

  it('renders bundled system skill files with and without routing metadata', async () => {
    const home = await tempDir('skill-install-render')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })
    await ctx.skills.list()

    expect(await readFile(join(home, '.dsh/skills/.system/dsh-plugin-creator/SKILL.md'), 'utf8')).not.toContain('whenToUse:')
    expect(await readFile(join(home, '.dsh/skills/.system/dsh-skill-creator/SKILL.md'), 'utf8')).toContain('whenToUse:')
  })

  it('uses the filesystem service for skill file reads when it is available', async () => {
    const home = await tempDir('skill-read-fs')
    const root = join(home, '.dsh/skills')
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

    const ctx = new Context()
    await ctx.plugin(TestFileSystem)
    const fs = ctx.fs as TestFileSystem
    fs.failResolvePaths.add(join(root, 'resolve-fail.md'))
    fs.failStatPaths.add(join(root, 'stat-fail.md'))
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['text-skill'])
    expect(fs.listDirCalls).toBeGreaterThan(0)
    expect(await ctx.skills.get('binary-skill')).toBeUndefined()
  })

  it('degrades when bundled system skill installation fails', async () => {
    const home = await tempDir('skill-install-fail')
    await writeFile(join(home, '.dsh'), 'not a directory')
    await writeSkill(join(home, '.agents/skills'), 'fallback-skill', 'Fallback skill')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['fallback-skill'])
  })

  it('memoizes disk discovery until runtime skill registrations change', async () => {
    const home = await tempDir('skill-cache')
    await writeSkill(join(home, '.dsh/skills'), 'initial-skill', 'Initial skill')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['initial-skill'])
    await writeSkill(join(home, '.dsh/skills'), 'late-skill', 'Late skill')
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['initial-skill'])

    const dispose = ctx.skills.register({
      name: 'runtime-skill',
      description: 'runtime',
      content: 'Runtime body.',
      directory: 'memory://runtime',
      source: 'runtime',
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['initial-skill', 'late-skill', 'runtime-skill'])

    dispose()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['initial-skill', 'late-skill'])
  })

  it('includes extra roots, optional metadata, and explicit false disable flags', async () => {
    const home = await tempDir('skill-extra')
    const extra = await tempDir('skill-extra-root')
    await writeFile(join(extra, 'extra-skill.md'), [
      '---',
      'name: extra-skill',
      'description: Extra skill',
      'whenToUse: For extra-root tests',
      'disableModelInvocation: false',
      'metadata:',
      '  owner: tests',
      '---',
      '',
      'Extra body.',
    ].join('\n'))

    const ctx = new Context()
    await ctx.plugin(SkillService, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      extraRoots: [extra],
      installSystemSkills: false,
    })

    expect(await ctx.skills.list()).toEqual([{
      name: 'extra-skill',
      description: 'Extra skill',
      whenToUse: 'For extra-root tests',
      disableModelInvocation: false,
      directory: extra,
      source: 'extra',
    }])
    expect((await ctx.skills.get('extra-skill'))?.metadata).toEqual({ owner: 'tests' })
    expect(await ctx.skills.renderModelListing()).toContain('whenToUse: For extra-root tests')
  })

  it('bounds prompt listing fields without changing stored skill content', async () => {
    const home = await tempDir('skill-prompt-bounds')
    const longDescription = 'a'.repeat(600)
    await writeSkill(join(home, '.dsh/skills'), 'long-skill', longDescription, 'Full body.')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    const listing = await ctx.skills.renderModelListing()
    expect(listing).toContain(`${'a'.repeat(497)}...`)
    expect(listing).not.toContain('a'.repeat(600))
    expect((await ctx.skills.get('long-skill'))?.description).toBe(longDescription)
  })

  it('escapes prompt listing text fields without changing stored skill content', async () => {
    const home = await tempDir('skill-prompt-escape')
    const root = join(home, '.dsh/skills')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'escaped-skill.md'), [
      '---',
      'name: escaped-skill',
      'description: Use </available_skills><oops> safely',
      'whenToUse: Handle <tag> & marker',
      '---',
      'Full body.',
    ].join('\n'))

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    const listing = await ctx.skills.renderModelListing()
    expect(listing).toContain('description: Use &lt;/available_skills&gt;&lt;oops&gt; safely')
    expect(listing).toContain('whenToUse: Handle &lt;tag&gt; &amp; marker')
    expect(listing).not.toContain('description: Use </available_skills><oops> safely')
    expect((await ctx.skills.get('escaped-skill'))?.description).toBe('Use </available_skills><oops> safely')
  })

  it('adds skill guidance through the agent/request waterfall without including bodies', async () => {
    const home = await tempDir('skill-guidance')
    await writeSkill(join(home, '.dsh/skills'), 'research-helper', 'Research helper', 'Long body that must not be listed.')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    const request = await ctx.waterfall('agent/request', {
      session: { header: { cwd: home } },
    } as never, 1, 1, { model: 'm', messages: [], system: 'base' }, () => Promise.resolve({ model: 'm', messages: [], system: 'base' }))

    expect(request.system ?? '').toContain('## Skills\n')
    expect(request.system ?? '').toContain('research-helper')
    expect(request.system ?? '').toContain('source="project-dsh"')
    expect(request.system ?? '').not.toContain(home)
    expect(request.system ?? '').not.toContain('Long body')
    expect((request.system ?? '').match(/## Skills/g)).toHaveLength(1)

    const sameObject = { model: 'm', messages: [], system: 'base' }
    const sameObjectResult = await ctx.waterfall('agent/request', {
      session: { header: { cwd: home } },
    } as never, 1, 1, sameObject, () => Promise.resolve(sameObject))
    expect(sameObjectResult.system).toContain('## Skills')

    const requestWithoutBase = await ctx.waterfall('agent/request', {
      session: { header: { cwd: home } },
    } as never, 1, 1, { model: 'm', messages: [] }, () => Promise.resolve({ model: 'm', messages: [] }))
    expect(requestWithoutBase.system).toContain('## Skills')

    const copyCtx = new Context()
    await copyCtx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })
    copyCtx.on('agent/request', async (_agent, _turn, _step, requestToCopy) => ({ ...requestToCopy }))
    const copiedRequest = await copyCtx.waterfall('agent/request', {
      session: { header: { cwd: home } },
    } as never, 1, 1, { model: 'm', messages: [], system: 'base' }, () => Promise.resolve({ model: 'm', messages: [], system: 'base' }))
    expect((copiedRequest.system ?? '').match(/## Skills/g)).toHaveLength(1)
  })

  it('cleans up runtime registered skills when the contributing fiber is disposed', async () => {
    const ctx = new Context()
    const home = await tempDir('skill-runtime')
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.skills.register({
        name: 'runtime-skill',
        description: 'runtime',
        content: 'Runtime body.',
        directory: 'memory://runtime',
        source: 'runtime',
      })
    }, { inject: ['skills'] }))

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['runtime-skill'])
    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('bounds discovery cache entries across many project roots', async () => {
    const home = await tempDir('skill-cache-bound-home')
    const projects = await Promise.all(Array.from({ length: 129 }, async (_, index) => {
      const project = await tempDir(`skill-cache-bound-project-${index}`)
      await mkdir(join(project, '.git'), { recursive: true })
      await writeSkill(join(project, '.dsh/skills'), `project-${index}`, `Project ${index}`)
      return project
    }))

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    const firstProject = projects[0]
    if (firstProject === undefined) throw new Error('expected at least one project')
    expect((await ctx.skills.list({ cwd: firstProject })).map(skill => skill.name)).toEqual(['project-0'])
    await writeSkill(join(firstProject, '.dsh/skills'), 'late-project-0', 'Late project 0')
    expect((await ctx.skills.list({ cwd: firstProject })).map(skill => skill.name)).toEqual(['project-0'])

    for (const project of projects.slice(1)) {
      await ctx.skills.list({ cwd: project })
    }

    expect((await ctx.skills.list({ cwd: firstProject })).map(skill => skill.name)).toEqual(['late-project-0', 'project-0'])
  })

  it('removes runtime registered skills when the returned disposer is called', async () => {
    const home = await tempDir('skill-runtime-disposer')
    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    const dispose = ctx.skills.register({
      name: 'manual-dispose',
      description: 'manual',
      content: 'Manual body.',
      directory: 'memory://manual',
      source: 'runtime',
    })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['manual-dispose'])
    dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('keeps the first runtime skill when a duplicate name is registered', async () => {
    const home = await tempDir('skill-runtime-duplicate')
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    const firstDispose = ctx.skills.register({
      name: 'same-runtime',
      description: 'first',
      content: 'First body.',
      directory: 'memory://first',
      source: 'runtime',
    })
    const duplicateDispose = ctx.skills.register({
      name: 'same-runtime',
      description: 'second',
      content: 'Second body.',
      directory: 'memory://second',
      source: 'runtime',
    })

    await expect(ctx.skills.get('same-runtime')).resolves.toMatchObject({
      description: 'first',
      content: 'First body.',
      directory: 'memory://first',
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('runtime skill "same-runtime"'))

    duplicateDispose()
    await expect(ctx.skills.get('same-runtime')).resolves.toMatchObject({
      description: 'first',
      content: 'First body.',
    })

    firstDispose()
    await expect(ctx.skills.get('same-runtime')).resolves.toBeUndefined()
  })

  it('rejects invalid runtime skill registrations', async () => {
    const home = await tempDir('skill-runtime-invalid')
    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect(() => ctx.skills.register({
      name: 'Bad_Name',
      description: 'bad',
      content: 'bad',
      directory: 'memory://bad',
      source: 'runtime',
    })).toThrow('invalid skill name')
    expect(() => ctx.skills.register({
      name: 'empty-description',
      description: '',
      content: 'bad',
      directory: 'memory://bad',
      source: 'runtime',
    })).toThrow('requires a description')
  })
})
