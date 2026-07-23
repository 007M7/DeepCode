/**
 * The globally named `send_message` tool: a thin model-facing adapter over
 * `ctx.subagentControl.sendMessage()`. It performs no lifecycle routing of its
 * own — steer-or-resume orchestration belongs to the control service — and it
 * lives apart from the provider-bound `@deepseek-ai/dsh-tool-subagent`
 * instances so multiple delegation tools share one control tool.
 * @module @deepseek-ai/dsh-tool-subagent-control
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent-control'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagentControl']

/**
 * Register the `send_message` tool.
 * @param ctx - context carrying the tool registry and the control service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'send_message',
    description:
      'Send a follow-up message to a background subagent by its subagent id. If it is still working, the '
      + 'message joins its current task; if it has finished, this starts a new task that continues the same '
      + 'subagent conversation. Either way the response arrives through the returned task id — collect it '
      + 'with `task_output`. A failure means the message was NOT delivered.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The subagent id returned when the background subagent was started.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the subagent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          route: {
            type: 'string',
            required: true,
            enum: ['steered', 'started'],
          },
          taskId: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.route === 'steered'
          ? `message delivered to running task ${value.taskId}`
          : `message started task ${value.taskId} continuing subagent ${args.subagent_id}`,
      }],
    },
    execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Non-agent callers have no session to authorize Task access with.
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const result = ctx.subagentControl.sendMessage(parent, SessionId(args.subagent_id), message)
      return Promise.resolve(result)
    },
  }))
}
