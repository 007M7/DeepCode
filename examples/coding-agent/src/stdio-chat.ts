import { createInterface } from 'node:readline'
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'stdio-chat'
export const inject = ['agents']

// Copied from examples/echo-agent (welcome text + reasoning rendering
// adjusted). Deliberately example-local rather than a shared package — two
// examples don't justify the abstraction yet; revisit at the third.

/**
 * Minimal UI plugin: reads lines from stdin → agent.send(); renders the
 * agent's stream chunks and tool activity to stdout. Demonstrates that a UI
 * is "just a plugin" — it only consumes the agent/* event taxonomy.
 */
export function apply(ctx: Context) {
  let inReasoning = false
  ctx.on('agent/stream-chunk', (_agent, _turn, _step, chunk) => {
    if (chunk.type === 'reasoning-delta') {
      // Dim the chain-of-thought so the answer stands out.
      if (!inReasoning) process.stdout.write('\x1B[2m')
      inReasoning = true
      process.stdout.write(chunk.text)
    } else if (chunk.type === 'text-delta') {
      if (inReasoning) process.stdout.write('\x1B[0m\n')
      inReasoning = false
      process.stdout.write(chunk.text)
    }
  })

  ctx.on('agent/turn-start', (agent, turn) => {
    process.stdout.write(`\n[${agent.id} turn ${turn}] `)
  })

  ctx.on('agent/turn-end', () => {
    if (inReasoning) process.stdout.write('\x1B[0m')
    inReasoning = false
    process.stdout.write('\n> ')
  })

  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/call') {
      const { name: toolName, arguments: args } = event.data
      if (inReasoning) process.stdout.write('\x1B[0m')
      inReasoning = false
      process.stdout.write(`\n  [tool call] ${toolName}(${args})`)
    } else if (event.type === 'tool/result') {
      const { content } = event.data
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('')
      process.stdout.write(`\n  [tool result] ${text}\n  `)
    }
  })

  ctx.effect(() => {
    const reader = createInterface({ input: process.stdin })
    // Piped-input exit, once stdin reaches EOF:
    //  - If no line ever submitted work (empty stdin, blank-only lines), exit
    //    immediately — no turn will ever start, so there is nothing to wait
    //    for. (Gating on an observed 'running' here would hang forever.)
    //  - If work WAS submitted, exit the next time the agent settles to idle
    //    AFTER having run. Two subtleties this handles: the loop batches
    //    several queued messages into ONE turn (one idle), so we don't count
    //    sends; and agent.send() does NOT synchronously flip status to
    //    'running', so requiring an observed 'running' first (`sawRunning`)
    //    avoids exiting in the gap before the turn starts and dropping work.
    let stdinClosed = false
    let disposed = false
    let submittedWork = false
    let sawRunning = false

    const maybeExit = (): void => {
      if (disposed || !stdinClosed) return
      // No work submitted: nothing will ever run, exit straight away.
      // Work submitted: wait until a turn has run and the agent is idle.
      if (submittedWork) {
        if (!sawRunning) return
        const agent = ctx.agents.get('main')
        if (agent && agent.status !== 'idle') return // a turn is still running
      }
      // Let any final output flush, then exit.
      setTimeout(() => process.exit(0), 200)
    }

    const disposeStatusListener = ctx.on('agent/status', (subject, status) => {
      if (subject.id !== 'main') return
      if (status === 'running') sawRunning = true
      if (status === 'idle') maybeExit()
    })

    reader.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      const agent = ctx.agents.get('main')
      if (!agent) {
        console.error('agent "main" is not running')
        return
      }
      submittedWork = true
      if (agent.status === 'running') {
        agent.steer([{ type: 'text', text }])
      } else {
        agent.send([{ type: 'text', text }])
      }
    })
    reader.on('close', () => {
      // Fires for BOTH stdin EOF and plugin disposal (reader.close() below);
      // `disposed` guards teardown so HMR/dispose never exits the process.
      stdinClosed = true
      maybeExit()
    })
    process.stdout.write('coding-agent ready. Give it a coding task (bash is its only tool).\n> ')
    return () => {
      disposed = true
      disposeStatusListener()
      reader.close()
    }
  }, 'stdio-chat')
}
