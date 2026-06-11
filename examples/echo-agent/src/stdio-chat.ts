import { createInterface } from 'node:readline'
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'stdio-chat'
export const inject = ['agents']

/**
 * Minimal UI plugin: reads lines from stdin → agent.send(); renders the
 * agent's stream chunks and tool activity to stdout. Demonstrates that a UI
 * is "just a plugin" — it only consumes the agent/* event taxonomy.
 */
export function apply(ctx: Context) {
  ctx.on('agent/stream-chunk', (_agent, _turn, _step, chunk) => {
    if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
  })

  ctx.on('agent/turn-start', (agent, turn) => {
    process.stdout.write(`\n[${agent.id} turn ${turn}] `)
  })

  ctx.on('agent/turn-end', () => {
    process.stdout.write('\n> ')
  })

  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/call') {
      const { name: toolName, arguments: args } = event.data
      process.stdout.write(`\n  [tool call] ${toolName}(${args})`)
    } else if (event.type === 'tool/result') {
      const { content } = event.data
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('')
      process.stdout.write(`\n  [tool result] ${text}\n  `)
    }
  })

  ctx.effect(() => {
    const reader = createInterface({ input: process.stdin })
    reader.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      const agent = ctx.agents.get('main')
      if (!agent) {
        console.error('agent "main" is not running')
        return
      }
      if (agent.status === 'running') {
        agent.steer([{ type: 'text', text }])
      } else {
        agent.send([{ type: 'text', text }])
      }
    })
    reader.on('close', () => {
      // allow the process to exit when stdin ends (piped input)
      setTimeout(() => process.exit(0), 200)
    })
    process.stdout.write('echo-agent ready. Type a message ("echo <text>" triggers the tool).\n> ')
    return () => reader.close()
  }, 'stdio-chat')
}
