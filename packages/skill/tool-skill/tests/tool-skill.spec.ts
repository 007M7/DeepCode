import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import { CallId, type Message } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SkillService from '@deepseek-ai/dsh-skill'
import * as SkillLocal from '@deepseek-ai/dsh-skill-local'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(home: string, config: toolSkill.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(SkillService)
  await ctx.plugin(SkillLocal, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })
  await ctx.plugin(toolSkill, config)
  return ctx
}

function agentForCwd(cwd: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

async function composePrefix(ctx: Context, cwd: string, signal = new AbortController().signal): Promise<Message[]> {
  return await composePrefixForAgent(ctx, agentForCwd(cwd), signal)
}

async function composePrefixForAgent(ctx: Context, agent: Agent, signal = new AbortController().signal): Promise<Message[]> {
  const empty: Message[] = []
  return await agentEvents(ctx, agent).waterfall(
    'agent/session-prefix', empty, signal,
    () => Promise.resolve(empty),
  )
}

async function mintAgentScope(ctx: Context, cwd: string): Promise<{ agent: Agent; scope: Scope }> {
  const agent = agentForCwd(cwd)
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools'],
  }))
  return { agent, scope }
}

describe('dsh-tool-skill', () => {
  it('registers the skill tool schema and removes it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const home = await tempDir('tool-schema')
    await ctx.plugin(SkillService)
    await ctx.plugin(SkillLocal, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })
    ctx.skills.register({ name: 'lifecycle-skill', description: 'Lifecycle', source: 'runtime', content: 'body' })

    const fiber = await ctx.plugin(toolSkill)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
    expect(await composePrefix(ctx, '/workspace')).toHaveLength(1)
    expect(ctx.tools.get('skill')?.presentCall?.({ name: 'project-skill' })).toEqual({
      card: 'generic',
      title: 'Load skill project-skill',
      kind: 'read',
      rawInput: 'project-skill',
    })
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(await composePrefix(ctx, '/workspace')).toEqual([])

    toolSkill.apply(ctx)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
  })

  it('forwards the session-prefix abort signal to skill discovery', async () => {
    const home = await tempDir('tool-prefix-signal')
    const ctx = await setup(home)
    let seenSignal: AbortSignal | undefined
    ctx.skills.registerProvider({
      name: 'signal-probe',
      async list(options) {
        seenSignal = options.signal
        return []
      },
      async get() {
        return undefined
      },
    })
    const controller = new AbortController()

    await composePrefix(ctx, '/workspace', controller.signal)

    expect(seenSignal).toBe(controller.signal)
  })

  it('contributes a stable name-and-description catalog through the session prefix', async () => {
    const home = await tempDir('tool-catalog')
    const ctx = await setup(home, { catalogDescriptionMaxLength: 50 })
    ctx.skills.register({
      name: 'z-skill',
      description: 'Long   description '.repeat(5),
      whenToUse: 'Never render this routing hint.',
      source: 'secret-source',
      provider: 'runtime',
      resourceBase: { kind: 'directory', path: '/secret/path' },
      content: 'Secret body.',
    })
    ctx.skills.register({
      name: 'a-skill',
      description: 'Use {{placeholder}} <safely> & carefully.',
      source: 'runtime',
      provider: 'runtime',
      content: 'A body.',
    })
    ctx.on('agent/session-prefix', async (_agent, _prefix, _signal, next): Promise<Message[]> => [
      { role: 'user', content: [{ type: 'text', text: 'later contribution' }] },
      ...await next(),
    ])

    const prefix = await composePrefix(ctx, '/workspace')

    expect(prefix).toEqual([
      {
        role: 'user',
        content: [{
          type: 'text',
          text: [
            '<system-reminder>',
            'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
            '',
            '<available_skills>',
            '- `a-skill`: Use {{placeholder}} &lt;safely&gt; &amp; carefully.',
            '- `z-skill`: Long description Long description Long descript...',
            '</available_skills>',
            '',
            "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
            '</system-reminder>',
          ].join('\n'),
        }],
      },
      { role: 'user', content: [{ type: 'text', text: 'later contribution' }] },
    ])
    const rendered = JSON.stringify(prefix[0])
    expect(rendered).not.toContain('whenToUse')
    expect(rendered).not.toContain('secret-source')
    expect(rendered).not.toContain('/secret/path')
    expect(rendered).not.toContain('Secret body')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ agent: agentForCwd('/workspace') }))).not.toContain('<available_skills>')
  })

  it('does not contribute a session-prefix message when no skills are available', async () => {
    const home = await tempDir('tool-empty-catalog')
    const ctx = await setup(home)

    expect(await composePrefix(ctx, '/workspace')).toEqual([])
  })

  it('omits catalog guidance when the calling agent restricts away the shipped skill tool', async () => {
    const home = await tempDir('tool-restricted-catalog')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const { agent, scope } = await mintAgentScope(ctx, '/workspace')
    scope.ctx.tools.restrict({ deny: ['skill'] })

    expect(ctx.tools.get('skill', agent)).toBeUndefined()
    expect(await composePrefixForAgent(ctx, agent)).toEqual([])
    expect(await composePrefix(ctx, '/workspace')).toHaveLength(1)
    await scope.dispose()
  })

  it('does not attach shipped catalog guidance to a scoped same-name tool shadow', async () => {
    const home = await tempDir('tool-shadowed-catalog')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const { agent, scope } = await mintAgentScope(ctx, '/workspace')
    scope.ctx.tools.register(defineTool({
      name: 'skill',
      description: 'A scoped tool with unrelated semantics.',
      parameters: {},
      execute() {
        return Promise.resolve([{ type: 'text', text: 'shadow' }])
      },
    }))

    expect(ctx.tools.get('skill', agent)).not.toBe(ctx.tools.get('skill'))
    expect(await composePrefixForAgent(ctx, agent)).toEqual([])
    expect(await composePrefix(ctx, '/workspace')).toHaveLength(1)
    await scope.dispose()
  })

  it('validates the catalog description cap', async () => {
    const home = await tempDir('tool-invalid-catalog-cap')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(SkillService)
    await ctx.plugin(SkillLocal, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents') })

    await expect(ctx.plugin(toolSkill, { catalogDescriptionMaxLength: 2 })).rejects.toThrow('greater than or equal to 3')
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
    expect(block.text).toBe([
      '<skill_content name="project-skill">',
      '<skill_resources>',
      `Base directory for this skill: ${join(project, '.dsh/skills/project-skill')}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      'Project instructions.',
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n'))
    expect(block.text).not.toContain('# Skill:')
  })

  it('renders provider-managed resource hints for non-local skills', async () => {
    const home = await tempDir('tool-resource-hints')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'opaque-skill',
      description: 'Opaque skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'opaque', description: 'runtime memory' },
      content: 'Opaque instructions.',
    })
    ctx.skills.register({
      name: 'url-skill',
      description: 'URL skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'url', url: 'https://skills.example.test/url-skill' },
      content: 'URL instructions.',
    })
    ctx.skills.register({
      name: 'provider-skill',
      description: 'Provider skill',
      source: 'runtime',
      provider: 'runtime',
      content: 'Provider instructions.',
    })

    const opaque = await ctx.tools.execute({ callId: CallId('c2'), name: 'skill', arguments: { name: 'opaque-skill' } })
    const url = await ctx.tools.execute({ callId: CallId('c3'), name: 'skill', arguments: { name: 'url-skill' } })
    const provider = await ctx.tools.execute({ callId: CallId('c4'), name: 'skill', arguments: { name: 'provider-skill' } })

    if (opaque.content[0]?.type !== 'text' || url.content[0]?.type !== 'text' || provider.content[0]?.type !== 'text') {
      throw new Error('expected text tool results')
    }
    expect(opaque.content[0].text).toContain('<skill_resources>\nResources for this skill: runtime memory\nLoad referenced resources only as needed.\n</skill_resources>')
    expect(url.content[0].text).toContain('<skill_resources>\nBase URL for this skill: https://skills.example.test/url-skill\nResolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.\n</skill_resources>')
    expect(provider.content[0].text).toContain('<skill_resources>\nResources for this skill are managed by provider "runtime".\nLoad referenced resources only as needed.\n</skill_resources>')
  })

  it('fails loud on an unknown resource base kind', async () => {
    const home = await tempDir('tool-resource-assert-never')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'rogue-resource-skill',
      description: 'Rogue resource skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'future' } as never,
      content: 'Rogue instructions.',
    })

    const result = await ctx.tools.execute({ callId: CallId('c5'), name: 'skill', arguments: { name: 'rogue-resource-skill' } })

    expect(result.isError).toBe(true)
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text tool result')
    expect(block.text).toContain('unreachable variant')
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
    const unknownBlock = unknown.content[0]
    if (unknownBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(unknownBlock.text).toContain('skill "missing" is unknown or no longer available')
  })
})
