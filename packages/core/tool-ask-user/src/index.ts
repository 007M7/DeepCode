/**
 * Model-facing `ask_user_question` tool over the `ctx.userInteraction` seam.
 * The tool pauses until a UI provider returns a human answer, then feeds that
 * answer back into the agent loop as an ordinary tool result.
 *
 * @module @deepseek-ai/dsh-tool-ask-user
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-interaction'

export const name = 'tool-ask-user'
export const inject = ['tools', 'userInteraction']

const description = 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
  + 'Use options when possible; mark the recommended option when one is safest.'

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description,
    parameters: {
      header: {
        type: 'string',
        description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
      },
      question: {
        type: 'string',
        required: true,
        description: 'The specific question to ask the user.',
      },
      options: {
        type: 'array',
        description: 'Optional mutually exclusive choices to show the user.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', required: true, description: 'Short user-facing option label.' },
            value: { type: 'string', description: 'Answer text returned to you if this option is selected. Defaults to label.' },
            description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
            recommended: { type: 'boolean', description: 'True for the recommended/default option.' },
          },
        },
      },
      allow_custom: {
        type: 'boolean',
        description: 'Whether the user may type a free-form answer instead of selecting an option. Defaults to true.',
      },
    },
    async execute(args, exec) {
      const result = await ctx.userInteraction.ask({
        question: args.question,
        ...args.header !== undefined ? { header: args.header } : {},
        ...args.options !== undefined ? { options: args.options } : {},
        ...args.allow_custom !== undefined ? { allowCustom: args.allow_custom } : {},
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
        ...exec.signal !== undefined ? { signal: exec.signal } : {},
      })
      return [{ type: 'text', text: result.answer }]
    },
  }))
}
