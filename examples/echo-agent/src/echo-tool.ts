import type { Context } from 'cordis'

export const name = 'echo-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'echo',
    description: 'Echo the given text back, uppercased.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async execute(args: any) {
      return [{ type: 'text', text: `ECHO: ${String(args?.text ?? '').toUpperCase()}` }]
    },
  })
}
