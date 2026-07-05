import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SkillService from '@deepseek-ai/dsh-skill'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(home: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })
  await ctx.plugin(toolSkill)
  return ctx
}

describe('dsh-tool-skill', () => {
  it('registers the skill tool schema and removes it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const home = await tempDir('tool-schema')
    await ctx.plugin(SkillService, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), installSystemSkills: false })

    const fiber = await ctx.plugin(toolSkill)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
    expect(ctx.tools.get('skill')?.presentCall?.({ name: 'project-skill' })).toEqual({
      card: 'generic',
      title: 'Load skill project-skill',
      kind: 'read',
      rawInput: 'project-skill',
    })
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('loads a skill for the calling agent cwd', async () => {
    const home = await tempDir('tool-load')
    const project = await tempDir('tool-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill', 'Project instructions.')
    const ctx = await setup(home)

    const result = await ctx.tools.execute({
      callId: CallId('c1'),
      name: 'skill',
      arguments: { name: 'project-skill' },
      agent: { session: { header: { cwd: project } } } as never,
    })

    expect(result.isError).toBe(false)
    const block = result.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') throw new Error('expected text skill result')
    expect(block.text).toContain('<skill_content name="project-skill">')
    expect(block.text).toContain('Project instructions.')
  })

  it('returns isError for unknown, invalid, and model-disabled skills', async () => {
    const home = await tempDir('tool-errors')
    await writeSkill(join(home, '.dsh/skills'), 'hidden-skill', 'Hidden skill', 'Hidden instructions.')
    await writeFile(join(home, '.dsh/skills/hidden-skill/SKILL.md'), '---\nname: hidden-skill\ndescription: Hidden skill\ndisableModelInvocation: true\n---\n\nHidden instructions.\n')
    const ctx = await setup(home)

    const unknown = await ctx.tools.execute({ callId: CallId('c1'), name: 'skill', arguments: { name: 'missing' } })
    const invalid = await ctx.tools.execute({ callId: CallId('c2'), name: 'skill', arguments: { name: 'Bad_Name' } })
    const disabled = await ctx.tools.execute({ callId: CallId('c3'), name: 'skill', arguments: { name: 'hidden-skill' } })

    expect(unknown.isError).toBe(true)
    expect(invalid.isError).toBe(true)
    expect(disabled.isError).toBe(true)
  })
})
