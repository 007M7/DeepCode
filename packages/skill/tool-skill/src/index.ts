/**
 * Session-prefix skill catalog and model-facing `skill` loader tool.
 *
 * @module @deepseek-ai/dsh-tool-skill
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertNever, type Message } from '@deepseek-ai/dsh-llm'
import { isSkillName, type SkillDefinition, type SkillSummary } from '@deepseek-ai/dsh-skill'

export const name = 'tool-skill'
export const inject = ['tools', 'skills']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500

/** Model-facing skill catalog configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the session catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
}

/** Validate and default the model-facing skill catalog configuration. */
export const Config: z<Config> = z.object({
  catalogDescriptionMaxLength: z.number().default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
})

/**
 * Register the model-facing skill loader and its visibility-matched
 * session-prefix catalog. The catalog is emitted only when the calling agent
 * resolves this plugin's exact tool registration; a restriction or scoped
 * same-name shadow therefore removes both the schema and its call guidance.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      const skill = await ctx.skills.get(args.name, { cwd: exec.agent?.session.header.cwd, signal: exec.signal })
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (skill.disableModelInvocation === true) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      return [{ type: 'text', text: renderSkillContent(skill) }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  ctx.tools.register(skillTool)
  const registeredSkillTool = ctx.tools.get(skillTool.name)
  /* v8 ignore next 3 -- register() publishes synchronously or throws; this guards future registry drift. */
  if (registeredSkillTool === undefined) {
    throw new Error('dsh-tool-skill: registered skill tool is not visible in the global registry')
  }

  // Register after the tool so reverse-order fiber teardown removes this
  // guidance listener before its referenced tool. Exact definition identity is
  // the shared truth for restrictions and scoped shadows: another tool merely
  // named `skill` must not inherit this plugin's catalog or instructions.
  ctx.on('agent/session-prefix', async (agent, _prefix, signal, next): Promise<Message[]> => {
    if (ctx.tools.get(skillTool.name, agent) !== registeredSkillTool) return await next()
    const skills = await ctx.skills.list({ cwd: agent.session.header.cwd, signal })
    const rest = await next()
    if (skills.length === 0) return rest
    return [renderCatalogMessage(skills, catalogDescriptionMaxLength), ...rest]
  })
}

function renderSkillContent(skill: SkillDefinition): string {
  const resourceHint = renderResourceHint(skill)
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...resourceHint,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

function renderResourceHint(skill: SkillDefinition): string[] {
  const base = skill.resourceBase
  if (base === undefined) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
      'Load referenced resources only as needed.',
    ]
  }
  switch (base.kind) {
    case 'directory':
      return [
        `Base directory for this skill: ${escapeText(base.path)}`,
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      ]
    case 'url':
      return [
        `Base URL for this skill: ${escapeText(base.url)}`,
        'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.',
      ]
    case 'opaque':
      return [
        `Resources for this skill: ${escapeText(base.description)}`,
        'Load referenced resources only as needed.',
      ]
    default:
      return assertNever(base, 'SkillResourceBase.kind')
  }
}

function renderCatalogMessage(skills: SkillSummary[], descriptionMaxLength: number): Message {
  const entries = skills.map(skill => `- \`${skill.name}\`: ${catalogDescription(skill.description, descriptionMaxLength)}`)
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
        '',
        '<available_skills>',
        ...entries,
        '</available_skills>',
        '',
        "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
        '</system-reminder>',
      ].join('\n'),
    }],
  }
}

function catalogDescription(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  const truncated = normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`
  return escapeText(truncated)
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
