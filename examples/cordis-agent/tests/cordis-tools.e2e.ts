import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { cordisHarness, waitForIdle } from './harness.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * With-key smoke for the self-referential cordis tools: a REAL model drives
 * cordis_mount/cordis_unmount against the live context the test observes.
 * World-verified, not self-reported: the mounted listener must actually WRITE
 * its tagged console line, the self-made tool must actually EXIST in the
 * registry and appear as a real `tool/call`, the cross-mount service must
 * actually LAND in the reflect store. Key-gated (see vitest.e2e.config.ts).
 */

let ctx: Context | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  // Always dispose the harness, even on failure/retry/timeout: agent-loop
  // teardown stops the loop, and disposing the tree unwinds every dynamic
  // mount the model left behind.
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** The tagged write-through lines (`[cordis:dyn-n] …`) captured by a console spy. */
function taggedCalls(log: { mock: { calls: unknown[][] } }): unknown[][] {
  return log.mock.calls.filter(call => typeof call[0] === 'string' && /^\[cordis:dyn-\d+\]$/.test(call[0]))
}

/** Model-facing text of one tool result, concatenated. */
function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('cordis tools: a real model modifies its own runtime', () => {
  it('mounts a status listener whose tagged output actually fires, then unmounts it', async () => {
    ctx = await cordisHarness()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const agent = ctx.agentLoop.create(SessionId('cordis-e2e-listener'), { provider: 'deepseek', model: 'deepseek-v4-flash' })

    agent.send([{
      type: 'text',
      text: 'Use cordis_mount to mount a plugin that listens to the \'agent/status\' '
        + 'cordis event and logs every change with console.log. Reply "mounted" once done.',
    }])
    await waitForIdle(ctx, agent)

    // The WORLD check: the turn's own running→idle transition must have driven
    // the mounted listener through the tagged sandbox console.
    expect(taggedCalls(log).length).toBeGreaterThan(0)
    const mid = await ctx.tools.execute({
      callId: CallId('verify-mounted'), name: 'cordis_inspect', arguments: { what: 'dynamic' },
    })
    expect(resultText(mid)).toContain('dyn-')

    agent.send([{ type: 'text', text: 'Now unmount the plugin you just mounted.' }])
    await waitForIdle(ctx, agent)

    const after = await ctx.tools.execute({
      callId: CallId('verify-unmounted'), name: 'cordis_inspect', arguments: { what: 'dynamic' },
    })
    expect(resultText(after)).toContain('(no dynamic plugins mounted)')
  }, 120_000)

  it('builds itself a reverse_text tool and actually calls it', async () => {
    ctx = await cordisHarness()
    const agent = ctx.agentLoop.create(SessionId('cordis-e2e-selftool'), { provider: 'deepseek', model: 'deepseek-v4-flash' })

    agent.send([{
      type: 'text',
      text: 'Give yourself a new tool: use cordis_mount to mount a plugin with '
        + 'inject ["tools"] that calls harness.registerTool(ctx, harness.defineTool({...})) '
        + 'to register a tool named reverse_text with one required string parameter '
        + '"text", returning the text reversed. Then CALL reverse_text with the '
        + 'exact text "harness" and report its exact output.',
    }])
    await waitForIdle(ctx, agent)

    // World checks: the tool exists in the registry, was invoked as a real tool call, and its
    // RESULT (the self-made execute actually running) is the reversed string. Model prose is only
    // self-report and is deliberately not asserted.
    expect(ctx.tools.get('reverse_text')).toBeDefined()
    const events = [...agent.session.events]
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.some(event => event.data.name === 'cordis_mount')).toBe(true)
    const reverseCalls = calls.filter(event => event.data.name === 'reverse_text')
    expect(reverseCalls.length).toBeGreaterThan(0)
    const reverseResults = events
      .filter(event => event.type === 'tool/result')
      .filter(event => reverseCalls.some(call => call.data.callId === event.data.callId))
      .flatMap(event => event.data.content.filter(block => block.type === 'text').map(block => block.text))
    // On failure, surface what the model actually mounted and what the tool
    // returned — an e2e failing at a distance is undebuggable without it.
    const mountCode = calls
      .filter(event => event.data.name === 'cordis_mount')
      .map(event => event.data.arguments)
      .join('\n---\n')
    const trace = events.map((event) => {
      switch (event.type) {
        case 'tool/call': return `tool/call:${event.data.name}`
        case 'tool/result': return `tool/result:${event.data.isError ? 'ERR:' + JSON.stringify(event.data.content).slice(0, 200) : 'ok'}`
        case 'turn/end': return `turn/end:${JSON.stringify(event.data.reason)}`
        default: return event.type
      }
    }).join('\n')
    expect(
      reverseResults.some(text => text.includes('ssenrah')),
      `no reversed output in reverse_text results.\nresults: ${JSON.stringify(reverseResults)}\nmount code: ${mountCode}\ntrace:\n${trace}`,
    ).toBe(true)
  }, 120_000)

  it('composes two mounts through provide/inject, and unmounting the provider parks the consumer', async () => {
    ctx = await cordisHarness()
    const agent = ctx.agentLoop.create(SessionId('cordis-e2e-compose'), { provider: 'deepseek', model: 'deepseek-v4-flash' })

    agent.send([{
      type: 'text',
      text: 'Mount TWO separate plugins with cordis_mount. First a provider: apply calls '
        + 'ctx.provide(\'shouter\', { shout: (s) => s.toUpperCase() }). Second a consumer with '
        + 'inject ["shouter", "tools"] that registers (via harness.registerTool + harness.defineTool) '
        + 'a tool named shout_text with one required string parameter "text" whose execute returns '
        + 'ctx.shouter.shout(args.text) as a text content block. Then CALL shout_text with "quiet" '
        + 'and report the exact output.',
    }])
    await waitForIdle(ctx, agent)

    // World checks: the service is really in the store, the tool really ran.
    expect(ctx.get('shouter')).toBeDefined()
    expect(ctx.tools.get('shout_text')).toBeDefined()
    const events = [...agent.session.events]
    const shoutCalls = events
      .filter(event => event.type === 'tool/call')
      .filter(event => event.data.name === 'shout_text')
    expect(shoutCalls.length).toBeGreaterThan(0)
    const shoutResults = events
      .filter(event => event.type === 'tool/result')
      .filter(event => shoutCalls.some(call => call.data.callId === event.data.callId))
      .flatMap(event => event.data.content.filter(block => block.type === 'text').map(block => block.text))
    expect(shoutResults.some(text => text.includes('QUIET'))).toBe(true)

    agent.send([{ type: 'text', text: 'Now unmount ONLY the provider plugin (the one that provided shouter).' }])
    await waitForIdle(ctx, agent)

    // The consumer must have been parked by cordis itself: service gone,
    // dependent tool unregistered, dynamic table naming the missing service.
    expect(ctx.get('shouter')).toBeUndefined()
    expect(ctx.tools.get('shout_text')).toBeUndefined()
    const after = await ctx.tools.execute({
      callId: CallId('verify-parked'), name: 'cordis_inspect', arguments: { what: 'dynamic' },
    })
    expect(resultText(after)).toContain('waiting for: shouter')
  }, 120_000)
})
