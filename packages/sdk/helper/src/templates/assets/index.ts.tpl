{{#if isAcp}}
import { startSDK, type SdkBootContext } from '@deepseek-ai/dsh-scripts'
{{else}}
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { startSDK, type SdkBootContext } from '@deepseek-ai/dsh-scripts'
{{/if}}

/** Boot this project's cordis.yml when invoked by dsh-scripts. */
export async function main(boot: SdkBootContext) {
{{#if isStdio}}
  const model = boot.args.model
  if (typeof model !== 'string' || model.length === 0) throw new Error('stdio startup requires --model=<name>')
  const resume = boot.args.resume
  if (resume !== undefined && (typeof resume !== 'string' || resume.length === 0)) {
    throw new Error('stdio startup requires --resume=<session-id>')
  }
  const sessionId = SessionId(resume ?? `main-session-${randomUUID()}`)
  process.env.DSH_SDK_SESSION_ID = sessionId
{{/if}}
  const ctx = await startSDK(new URL('./cordis.yml', import.meta.url))
{{#if isStdio}}
  try {
    if (resume === undefined) {
      await ctx.agents.create({
        sessionId,
        meta: { cwd: boot.cwd },
        agentOptions: { model },
      })
    } else {
      await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { model },
      })
    }
  } catch (error) {
    try {
      await ctx.fiber.dispose()
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'stdio startup and cleanup failed')
    }
    throw error
  }
{{else}}
{{#if isEmbed}}
  await ctx.agents.create({
    sessionId: SessionId(`main-session-${randomUUID()}`),
    meta: { cwd: boot.cwd },
    agentOptions: { model: {{modelLiteral}} },
  })
{{/if}}
{{/if}}
  return ctx
}
