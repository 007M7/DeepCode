import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import PtyService from '@deepseek-ai/dsh-pty'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as ptyLocal from '@deepseek-ai/dsh-pty-local'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class PassthroughSandbox extends SandboxProvider {
  calls: { argv: readonly string[]; policy: SandboxPolicy }[] = []

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    this.calls.push({ argv, policy })
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureSignatures: [] }
  }
}

function stubAgent(ctx: Context, rawId: string): Agent {
  const id = SessionId(rawId)
  const scope = ctx.plugin(() => {})
  return {
    id, options: {}, session: new Session(id), status: 'idle', ctx: scope.ctx,
    send() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
  }
}

async function harness(mode: 'danger-full-access' | 'workspace-write') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pty-local-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(PtyService)
  await ctx.plugin(PassthroughSandbox)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: root })
  const fiber = await ctx.plugin(ptyLocal, {
    pollIntervalMs: 10,
    exactProbeAfterMs: 20,
    idleSilenceMs: 250,
    timeoutMs: 2000,
    disposeGraceMs: 500,
    scrollbackLines: 100,
    scrollbackMaxBytes: 32_768,
    maxReadBytes: 16_384,
  })
  const agent = stubAgent(ctx, `agent-${mode}`)
  ctx.agents.register(agent)
  return { ctx, root, agent, fiber, sandbox: ctx.sandbox as PassthroughSandbox }
}

describe('pty-local real shell', () => {
  it('persists cwd and environment across sends, scrubs secrets, and closes', async () => {
    const previous = process.env.DSH_TEST_SECRET
    process.env.DSH_TEST_SECRET = 'must-not-leak'
    try {
      const { ctx, root, agent } = await harness('danger-full-access')
      const created = await ctx.pty.spawn(agent, { type: 'shell', name: 'main', cwd: root })
      expect(created.motd).toContain('dsh> ')

      const first = ctx.pty.startSend(agent, created.sessionId, { text: 'export KEEP=ok; cd /', submit: true })
      expect((await first.done).waitReason).toBe('stdin_read')
      const second = ctx.pty.startSend(agent, created.sessionId, { text: 'printf "cwd=%s keep=%s secret=%s\\n" "$PWD" "$KEEP" "${DSH_TEST_SECRET-unset}"', submit: true })
      expect((await second.done).viewport).toContain('cwd=/ keep=ok secret=unset')

      expect(ctx.pty.read(agent, created.sessionId, { offset: 0, count: 20 }).text).toContain('cwd=/ keep=ok secret=unset')
      expect(await ctx.pty.kill(agent, created.sessionId)).toBe(true)
      expect(ctx.pty.list(agent)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_TEST_SECRET
      else process.env.DSH_TEST_SECRET = previous
    }
  }, 10_000)

  it('wraps the exact shell argv under confined policy and unregisters on reload', async () => {
    const { ctx, root, agent, fiber, sandbox } = await harness('workspace-write')
    const created = await ctx.pty.spawn(agent, { type: 'shell' })
    expect(sandbox.calls).toEqual([{
      argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
      policy: { mode: 'workspace-write', workspaceRoot: realpathSync.native(root) },
    }])
    await fiber.dispose()
    expect(ctx.pty.listBackends()).toEqual([])
    expect(ctx.pty.list(agent)).toHaveLength(1)
    await ctx.pty.kill(agent, created.sessionId)
  }, 10_000)

  it('signals a foreground command and kills a TERM-ignoring background descendant', async () => {
    const { ctx, agent } = await harness('danger-full-access')
    const created = await ctx.pty.spawn(agent, { type: 'shell' })

    const foreground = ctx.pty.startSend(agent, created.sessionId, { text: 'sleep 60', submit: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await ctx.pty.signal(agent, created.sessionId, 'SIGINT')).delivered).toBe(true)
    expect((await foreground.done).waitReason).toBe('stdin_read')

    const background = ctx.pty.startSend(agent, created.sessionId, {
      text: 'sh -c \'trap "" TERM; sleep 60\' & echo CHILD=$!',
      submit: true,
    })
    const output = (await background.done).viewport
    const child = /CHILD=(\d+)/.exec(output)?.[1]
    expect(child).toBeDefined()
    const pid = Number(child)
    expect(() => process.kill(pid, 0)).not.toThrow()
    await ctx.pty.kill(agent, created.sessionId)
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)
})
