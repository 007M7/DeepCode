{{#if isAcp}}
import { startSDK, type SdkBootContext } from '@deepseek-ai/dsh-scripts'
{{else}}
import { randomUUID } from 'node:crypto'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { startSDK, type SdkBootContext } from '@deepseek-ai/dsh-scripts'
{{/if}}

/** Boot this project's cordis.yml when invoked by dsh-scripts. */
export async function main(boot: SdkBootContext) {
  const ctx = await startSDK(new URL('./cordis.yml', import.meta.url))
{{#if isStdio}}
  const model = boot.args.model
  if (typeof model !== 'string' || model.length === 0) throw new Error('stdio startup requires --model=<name>')
  const resume = boot.args.resume
  if (resume !== undefined && (typeof resume !== 'string' || resume.length === 0)) {
    throw new Error('stdio startup requires --resume=<session-id>')
  }
  if (resume === undefined) {
    await ctx.agents.create({
      agentId: AgentId('main'),
      sessionId: SessionId(`main-session-${randomUUID()}`),
      meta: { cwd: boot.cwd },
      agentOptions: { model },
    })
  } else {
    await ctx.agents.resume({
      agentId: AgentId('main'),
      resumeSessionId: SessionId(resume),
      agentOptions: { model },
    })
  }
{{else}}
{{#if isEmbed}}
  await ctx.agents.create({
    agentId: AgentId('main'),
    sessionId: SessionId(`main-session-${randomUUID()}`),
    meta: { cwd: boot.cwd },
    agentOptions: { model: {{modelLiteral}} },
  })
{{/if}}
{{/if}}
  return ctx
}
