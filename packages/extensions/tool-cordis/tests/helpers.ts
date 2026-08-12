import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import CordisHostRunner from '@deepseek-ai/dsh-cordis-host-runner'
import type { Config as RunnerConfig } from '@deepseek-ai/dsh-cordis-host-runner'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Shared spec helpers: a real `SystemPrompt` + `ToolRegistry` + timer + the
 * dynamic runner + this toolset (only the model and the browser are absent — the
 * code strings below stand in for what the model would write, and no gateway is
 * composed, so a browser half has nowhere to go).
 *
 * Every dynamic-package tool is session-scoped, so calls carry a stand-in agent.
 */

/** The session every spec call runs as. */
export const AGENT = { id: 'S-spec' as SessionId } as Agent

/** Mount the toolset on a fresh context with a real ToolRegistry, the timer service, and the runner. */
export async function setup(config?: RunnerConfig): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(CordisHostRunner, config)
  await ctx.plugin(tool)
  return ctx
}

/**
 * The same composition plus a stand-in browser: an `apiProxy` whose broadcast
 * answers a run request by walking the runner's own verbs, exactly as the real
 * client half does. Without it a package with a browser half can only ever be
 * refused, so the tool's success reporting for that shape stays untested.
 * @param waitingFor - services the answering page reports its half parked on.
 * @returns the mounted context.
 */
export async function setupWithBrowser(waitingFor?: readonly string[]): Promise<Context> {
  const ctx = await setup()
  const runner = ctx.dynamicCordisRunner
  // The fake browser subscribes the way a real page does — to the forwarded Host
  // event, not to a transport frame — and answers by walking the same verbs.
  ctx.on('cordis/request-run', (request) => {
    const { requestId, pluginId, packageId, mode } = request
    queueMicrotask(() => {
      void (async (): Promise<void> => {
        const half = await runner.runHostHalf(AGENT, pluginId, packageId, mode, requestId, false)
        if (!half.ok) return
        const source = runner.getClientCode(AGENT, pluginId, half.pluginRunId)
        await runner.resolveRequestRun(requestId, {
          ok: true,
          pluginRunId: source.pluginRunId,
          ...waitingFor === undefined ? {} : { waitingFor },
        })
      })()
    })
  })
  return ctx
}

let callCounter = 0

/** Execute a registered tool through the real registry pipeline, as the spec agent. */
export function call(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: AGENT,
  })
}

/** Concatenated text blocks of one tool result. */
export function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Define one host-half package and run it, returning its minted id. */
export async function defineAndRun(ctx: Context, code: string, name = 'spec-package'): Promise<string> {
  const defined = await call(ctx, 'cordis_define', {
    plugin: { kind: 'new', idPrefix: 'spec' },
    name,
    purpose: 'spec fixture',
    code: { host: code },
  })
  if (defined.isError) throw new Error(`define failed: ${text(defined)}`)
  const { pluginId, packageId } = defined.value as { pluginId: string; packageId: string }
  const ran = await call(ctx, 'cordis_run', { pluginId, packageId, mode: 'run' })
  if (ran.isError) throw new Error(`run failed: ${text(ran)}`)
  return pluginId
}

/** Host-half code for a listener plugin: logs on every `tools/change`. */
export const LISTENER_CODE = `
  return {
    name: 'change-logger',
    apply(ctx) {
      ctx.on('tools/change', () => console.log('tools changed'))
    },
  }
`

/** Host-half code for a self-made tool: registers `reverse_text` via the sandbox's harness helpers. */
export const REVERSE_TOOL_CODE = `
  return {
    name: 'reverse-text',
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'reverse_text',
        description: 'Reverse a string.',
        parameters: { text: { type: 'string', required: true } },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args) {
          return args.text.split('').reverse().join('')
        },
      }))
    },
  }
`

/** Host-half code providing a `greeter` service other packages can inject. */
export const PROVIDER_CODE = `
  return {
    name: 'greeter-provider',
    apply(ctx) {
      ctx.provide('greeter', { greet: (name) => 'hi ' + name })
    },
  }
`

/** Host-half code consuming the `greeter` service through inject, exposing it as a tool. */
export const CONSUMER_CODE = `
  return {
    name: 'greeter-consumer',
    inject: ['greeter', 'tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'greet',
        description: 'Greet someone via the greeter service.',
        parameters: { name: { type: 'string', required: true } },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args) {
          return ctx.greeter.greet(args.name)
        },
      }))
    },
  }
`
