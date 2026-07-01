import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import SkillService from '@deepseek-ai/dsh-skill'

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

  it('keeps skill body text that begins immediately after the closing frontmatter delimiter', async () => {
    const home = await tempDir('skill-frontmatter-body')
    const root = join(home, '.dsh/skills')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'tight-body.md'), [
      '---',
      'name: tight-body',
      'description: Tight body',
      '---First line must survive.',
      'Second line.',
    ].join('\n'))

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    expect((await ctx.skills.get('tight-body'))?.content).toBe('First line must survive.\nSecond line.')
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

  it('renders bundled system skill files with and without routing metadata', async () => {
    const home = await tempDir('skill-install-render')

    const ctx = new Context()
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })
    await ctx.skills.list()

    expect(await readFile(join(home, '.dsh/skills/.system/dsh-plugin-creator/SKILL.md'), 'utf8')).not.toContain('whenToUse:')
    expect(await readFile(join(home, '.dsh/skills/.system/dsh-skill-creator/SKILL.md'), 'utf8')).toContain('whenToUse:')
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
