import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'echo-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'Echo the given text back, uppercased.',
    parameters: {
      text: { type: 'string', required: true },
    },
    async execute(args) {
      // args is typed: { text: string }
      return [{ type: 'text', text: `ECHO: ${args.text.toUpperCase()}` }]
    },
  }))
}
