/**
 * Durable session skill catalog and model-facing `skill` loader tool.
 *
 * @module @deepseek-ai/dsh-tool-skill
 */

import { createHash } from 'node:crypto'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertNever, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  isModelInvocable,
  isSkillName,
  type SkillDefinition,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
const CATALOG_ENTRIES_START = '<available_skills>\n'
const CATALOG_ENTRIES_END = '</available_skills>'
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-tool-skill' } as const

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
 * durable session catalog. The catalog is emitted only when the calling agent
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
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal }
      const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
      if (!summary) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(summary)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(skill)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        content: skill.content,
      }
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

  // Register after the tool so reverse teardown removes guidance first. Exact definition
  // identity prevents a scoped shadow merely named `skill` from inheriting this catalog.
  ctx.on('agent/step', async (agent: Agent, _turn, _step, signal): Promise<void> => {
    const toolVisible = ctx.tools.get(skillTool.name, agent) === registeredSkillTool
    const snapshot = toolVisible
      ? await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal })
      : { skills: [], complete: true }
    signal.throwIfAborted()
    if (!snapshot.complete) return
    const skills = snapshot.skills.filter(isModelInvocable)
    const digest = catalogDigest(skills, catalogDescriptionMaxLength)
    const history = catalogHistory(agent)
    if (history.visibleDigest === digest) return
    if (!history.published && skills.length === 0) return
    const catalog = history.published
      ? renderCatalogUpdate(skills, catalogDescriptionMaxLength)
      : renderCatalogMessage(skills, catalogDescriptionMaxLength)
    agent.inject(catalog)
  })
}

function renderSkillContent(skill: Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'content'>): string {
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

function renderResourceHint(skill: Pick<SkillDefinition, 'provider' | 'resourceBase'>): string[] {
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
    /* v8 ignore start -- SkillResourceBase is a closed union; a future kind must fail compilation here. */
    default:
      return assertNever(base, 'SkillResourceBase.kind')
    /* v8 ignore stop */
  }
}

function renderCatalogMessage(skills: SkillSummary[], descriptionMaxLength: number): UserMessage {
  const entries = renderCatalogEntries(skills, descriptionMaxLength)
  return createUserMessage({
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
    source: PLUGIN_SOURCE,
  })
}

function renderCatalogUpdate(skills: SkillSummary[], descriptionMaxLength: number): UserMessage {
  const entries = renderCatalogEntries(skills, descriptionMaxLength)
  const availability = skills.length === 0
    ? [
      'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
    ]
    : [
      'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
    ]
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
        '',
        '<available_skills>',
        ...entries,
        '</available_skills>',
        '',
        ...availability,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: PLUGIN_SOURCE,
  })
}

function renderCatalogEntries(skills: SkillSummary[], descriptionMaxLength: number): string[] {
  return skills.map(skill => `- \`${skill.name}\`: ${catalogDescription(skill.description, descriptionMaxLength)}`)
}

function catalogDigest(skills: SkillSummary[], descriptionMaxLength: number): string {
  return digestCatalogEntries(renderCatalogEntries(skills, descriptionMaxLength).join('\n'))
}

function digestCatalogEntries(entries: string): string {
  return createHash('sha256')
    .update(entries)
    .digest('hex')
}

function catalogHistory(agent: Agent): { visibleDigest?: string; published: boolean } {
  const visible = new Set(agent.session.surface.nodes)
  const events = agent.session.events
  let published = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // The loop bounds prove the read-only event view contains this index.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const event = events[index]!
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== PLUGIN_SOURCE.plugin) continue
    const digest = catalogContentDigest(event.data.content)
    if (digest === undefined) continue
    published = true
    if (visible.has(event.seq)) return { visibleDigest: digest, published }
  }
  return { published }
}

function catalogContentDigest(content: UserMessage['content']): string | undefined {
  if (content.length !== 1 || content[0]?.type !== 'text') return undefined
  const text = content[0].text
  const start = text.indexOf(CATALOG_ENTRIES_START)
  if (start === -1) return undefined
  const entriesStart = start + CATALOG_ENTRIES_START.length
  const end = text.indexOf(CATALOG_ENTRIES_END, entriesStart)
  if (end === -1) return undefined
  const renderedEntries = text.slice(entriesStart, end)
  const entries = renderedEntries.endsWith('\n') ? renderedEntries.slice(0, -1) : renderedEntries
  return digestCatalogEntries(entries)
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
