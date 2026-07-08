/**
 * Model-facing `skill` tool.
 *
 * @module @deepseek-ai/dsh-tool-skill
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { isSkillName, type SkillDefinition } from '@deepseek-ai/dsh-skill'

export const name = 'tool-skill'
export const inject = ['tools', 'skills']

export function apply(ctx: Context): void {
  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for one available skill by name. Use this when the current task matches a skill listed in the system prompt.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      const skill = await ctx.skills.get(args.name, { cwd: exec.agent?.session.header.cwd })
      if (!skill) {
        throw new Error(`unknown skill "${args.name}"`)
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
}

function renderSkillContent(skill: SkillDefinition): string {
  const resourceHint = renderResourceHint(skill)
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    '',
    skill.content,
    '',
    ...resourceHint,
    '</skill_content>',
  ].join('\n')
}

function renderResourceHint(skill: SkillDefinition): string[] {
  const base = skill.resourceBase
  if (base === undefined) {
    return [`Resources for this skill are managed by provider "${skill.provider}".`]
  }
  switch (base.kind) {
    case 'directory':
      return [
        `Base directory for this skill: ${base.path}`,
        'Resolve relative files mentioned by this skill against the base directory before using them.',
      ]
    case 'url':
      return [`Base URL for this skill: ${base.url}`]
    case 'opaque':
      return [`Resources for this skill: ${base.description}`]
    default:
      return assertNever(base, 'SkillResourceBase.kind')
  }
}
