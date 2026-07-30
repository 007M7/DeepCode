/**
 * Tests for the sandbox-policy home: the deployment default (mode +
 * workspaceRoot) the service exposes, and the per-session `sandbox/mode`
 * override kit (fold + write path) both enforcing families read.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService, { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'

async function mounted(config: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot?: string } = {}) {
  const ctx = new Context()
  await ctx.plugin(SandboxPolicyService, config)
  return ctx
}

function session(id: string, cwd?: string): Session {
  const sessionId = SessionId(id)
  return new Session(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: 0,
    ...cwd === undefined ? {} : { cwd },
  })
}

function agentFor(activeSession: Session): Agent {
  return { session: activeSession } as unknown as Agent
}

async function policyContext(ctx: Context, activeSession: Session): Promise<string | undefined> {
  return (await ctx.systemPrompt.assemble({ agent: agentFor(activeSession) }))
    .contexts.find(context => context.name === 'sandbox:policy')?.text
}

describe('SandboxPolicyService', () => {
  it('defaults to read-only under the process cwd', async () => {
    const ctx = await mounted()
    expect(ctx.sandboxPolicy.defaultMode).toBe('read-only')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(resolve(process.cwd()))
    const dispose = ctx.sandboxPolicy.registerEscalatableFamily('bash')
    expect(() =>{  dispose() }).not.toThrow()
  })

  it('carries a configured mode and resolves the workspace root absolute', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/ws/../ws/./sub' })
    expect(ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(resolve('/ws/../ws/./sub'))
  })

  it('resolves the deployment policy for an agentless call', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'workspace-write',
      workspaceRoot: resolve('/fallback'),
    })
  })

  it('resolves each session mode and cwd together without changing the fallback', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })
    const first = session('sess-first', '/projects/first')
    const second = session('sess-second', '/projects/second')
    setSandboxMode(second, 'read-only')

    expect(ctx.sandboxPolicy.resolve({ session: first })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: resolve('/projects/first'),
    })
    expect(ctx.sandboxPolicy.resolve({ session: second })).toEqual({
      mode: 'read-only',
      workspaceRoot: resolve('/projects/second'),
    })
    expect(ctx.sandboxPolicy.overrideOf(first)).toBeUndefined()
    expect(ctx.sandboxPolicy.overrideOf(second)).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'workspace-write',
      workspaceRoot: resolve('/fallback'),
    })
  })

  it.skipIf(process.platform === 'win32')('resolves a symlink-sensitive session cwd with POSIX component semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-policy-cwd-'))
    try {
      const lexical = join(root, 'lexical')
      const physical = join(root, 'physical')
      const child = join(physical, 'child')
      mkdirSync(lexical)
      mkdirSync(child, { recursive: true })
      const link = join(lexical, 'link')
      symlinkSync(child, link, 'dir')
      const cwd = `${link}${sep}..`
      const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })

      expect(ctx.sandboxPolicy.resolve({ session: session('sess-symlink-parent', cwd) })).toEqual({
        mode: 'workspace-write',
        workspaceRoot: realpathSync.native(physical),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets an approved mode outrank the session mode while retaining its root', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback' })
    const active = session('sess-approved', '/projects/approved')
    setSandboxMode(active, 'read-only')
    expect(ctx.sandboxPolicy.resolve({ session: active, mode: 'danger-full-access' })).toEqual({
      mode: 'danger-full-access',
      workspaceRoot: resolve('/projects/approved'),
    })
  })

  it('uses the configured root when a session has no cwd', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback' })
    expect(ctx.sandboxPolicy.resolve({ session: session('sess-no-cwd') }).workspaceRoot).toBe(resolve('/fallback'))
  })

  it('rejects a mode outside the closed vocabulary at load', async () => {
    const ctx = new Context()
    // schemastery rejects the union violation when the plugin loads.
    await expect(ctx.plugin(SandboxPolicyService, { mode: 'yolo' as never })).rejects.toThrow()
  })

  it('unregisters cleanly from a child fiber (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const fiber = await ctx.plugin(SandboxPolicyService, {})
    ctx.sandboxPolicy.registerEnforcedFamily('filesystem')
    expect(ctx.sandboxPolicy).toBeDefined()
    expect(await policyContext(ctx, session('sess-hmr'))).toContain('read-only')
    await fiber.dispose()
    expect(ctx.get('sandboxPolicy')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')).toBeUndefined()
  })
})

describe('sandbox:policy request context', () => {
  async function promptMounted(config: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot?: string } = {}): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SandboxPolicyService, config)
    return ctx
  }

  it('omits policy prose when no enforcing family is registered', async () => {
    const ctx = await promptMounted()
    expect(await policyContext(ctx, session('sess-no-family'))).toBe('')
  })

  it.each([
    [['filesystem'], 'Current DSH file policy: read-only. The write and edit tools cannot modify files in the standing mode.'],
    [['bash'], 'Current DSH file policy: read-only. One-shot bash commands cannot modify files in the standing mode.'],
    [['terminal'], 'Current DSH file policy: read-only. Terminal sessions cannot modify files in the standing mode.'],
    [['filesystem', 'bash'], 'Current DSH file policy: read-only. The write and edit tools and one-shot bash commands cannot modify files in the standing mode.'],
    [['filesystem', 'terminal'], 'Current DSH file policy: read-only. The write and edit tools and terminal sessions cannot modify files in the standing mode.'],
    [['bash', 'terminal'], 'Current DSH file policy: read-only. One-shot bash commands and terminal sessions cannot modify files in the standing mode.'],
    [['filesystem', 'bash', 'terminal'], 'Current DSH file policy: read-only. The write and edit tools, one-shot bash commands, and terminal sessions cannot modify files in the standing mode.'],
  ] as const)('states read-only consequences for %j', async (families, expected) => {
    const ctx = await promptMounted()
    for (const family of [...families].reverse()) ctx.sandboxPolicy.registerEnforcedFamily(family)
    expect(await policyContext(ctx, session(`sess-read-only-${families.join('-')}`))).toBe(expected)
  })

  it('states the portable workspace guarantee without enumerating host temp paths', async () => {
    const ctx = await promptMounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })
    ctx.sandboxPolicy.registerEnforcedFamily('filesystem')
    ctx.sandboxPolicy.registerEnforcedFamily('bash')
    ctx.sandboxPolicy.registerEnforcedFamily('terminal')
    const active = session('sess-workspace-write', '/projects/../projects/current')
    expect(await policyContext(ctx, active)).toBe('Current DSH file policy: workspace-write. The write and edit tools, one-shot bash commands, and terminal sessions may modify files under the session workspace: "/projects/current". Some platform temporary areas may also be writable.')
  })

  it('adds anti-refusal guidance only for enforced families with a real escalation path', async () => {
    const ctx = await promptMounted()
    ctx.sandboxPolicy.registerEnforcedFamily('filesystem')
    ctx.sandboxPolicy.registerEnforcedFamily('bash')
    ctx.sandboxPolicy.registerEnforcedFamily('terminal')
    ctx.sandboxPolicy.registerEscalatableFamily('filesystem')
    const disposeBash = ctx.sandboxPolicy.registerEscalatableFamily('bash')
    ctx.sandboxPolicy.registerEscalatableFamily('terminal')
    const isolated = await promptMounted()
    isolated.sandboxPolicy.registerEnforcedFamily('filesystem')
    isolated.sandboxPolicy.registerEscalatableFamily('terminal')
    expect(await policyContext(isolated, session('sess-unenforced-escalation'))).not.toContain('do not refuse')

    const active = session('sess-escalatable-families')
    expect(await policyContext(ctx, active)).toContain('For the write and edit tools, one-shot bash commands, and terminal sessions, do not refuse')
    disposeBash()
    expect(await policyContext(ctx, active)).toContain('For the write and edit tools and terminal sessions, do not refuse')
  })

  it('states the exact families bypassed by danger-full-access', async () => {
    const ctx = await promptMounted({ mode: 'danger-full-access' })
    ctx.sandboxPolicy.registerEnforcedFamily('filesystem')
    ctx.sandboxPolicy.registerEnforcedFamily('terminal')
    expect(await policyContext(ctx, session('sess-danger', '/projects/current'))).toBe('Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict the write and edit tools or terminal sessions.')
  })

  it('renders family contributions independently across mount and repeated disposal', async () => {
    const ctx = await promptMounted()
    const active = session('sess-family-lifecycle')
    const filesystemFiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sandboxPolicy.registerEnforcedFamily('filesystem')
    }, { inject: ['sandboxPolicy'] }))
    expect(await policyContext(ctx, active)).toContain('The write and edit tools cannot modify files')

    let disposeBashFirst!: () => void
    const bashFirstFiber = await ctx.plugin(Object.assign((inner: Context) => {
      disposeBashFirst = inner.sandboxPolicy.registerEnforcedFamily('bash')
    }, { inject: ['sandboxPolicy'] }))
    const bashSecondFiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sandboxPolicy.registerEnforcedFamily('bash')
    }, { inject: ['sandboxPolicy'] }))
    expect(await policyContext(ctx, active)).toContain('The write and edit tools and one-shot bash commands')
    disposeBashFirst()
    disposeBashFirst()
    expect(await policyContext(ctx, active)).toContain('The write and edit tools and one-shot bash commands')
    await bashSecondFiber.dispose()
    expect(await policyContext(ctx, active)).toContain('The write and edit tools cannot modify files')
    await bashFirstFiber.dispose()
    await filesystemFiber.dispose()
    expect(await policyContext(ctx, active)).toBe('')
  })

  it('keeps the complete rendered prompt byte-stable across TMPDIR changes', async () => {
    const ctx = await promptMounted({ mode: 'workspace-write' })
    ctx.sandboxPolicy.registerEnforcedFamily('filesystem')
    const active = session('sess-tmpdir-stability', '/projects/current')
    const previous = process.env.TMPDIR
    try {
      process.env.TMPDIR = '/tmp/first-host-temp'
      const firstAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      const firstPrompt = renderPrompt(firstAssembly)
      const firstContext = renderContextSnapshot(firstAssembly)
      process.env.TMPDIR = '/tmp/second-host-temp'
      const secondAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      expect(renderPrompt(secondAssembly)).toBe(firstPrompt)
      expect(renderContextSnapshot(secondAssembly)).toBe(firstContext)
      expect(firstContext).not.toContain('host-temp')
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  it('reflects the latest durable switch on the next assembly and stays byte-stable otherwise', async () => {
    const ctx = await promptMounted()
    ctx.sandboxPolicy.registerEnforcedFamily('filesystem')
    const active = session('sess-switch', '/projects/current')
    const first = await policyContext(ctx, active)
    expect(await policyContext(ctx, active)).toBe(first)

    setSandboxMode(active, 'danger-full-access')
    const danger = await policyContext(ctx, active)
    expect(danger).toContain('does not restrict the write and edit tools')
    expect(await policyContext(ctx, active)).toBe(danger)

    setSandboxMode(active, 'workspace-write')
    expect(await policyContext(ctx, active)).toContain(JSON.stringify(resolve('/projects/current')))
  })

  it('reconstructs resumed policy from the session log and omits diagnostics without an agent', async () => {
    const active = session('sess-resume', '/projects/current')
    setSandboxMode(active, 'workspace-write')
    const resumed = new Session(active.id, active.events, active.header)
    const ctx = await promptMounted({ mode: 'read-only' })
    ctx.sandboxPolicy.registerEnforcedFamily('filesystem')

    expect(await policyContext(ctx, resumed)).toContain('workspace-write')
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')?.text).toBe('')
  })
})

describe('the sandbox/mode session kit', () => {
  it('SANDBOX_MODES lists every mode for advertisement and validation', () => {
    expect(SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('effectiveSandboxMode folds to the last switch, or undefined without one', () => {
    const session = new Session(SessionId('sess-fold'))
    expect(effectiveSandboxMode(session.events)).toBeUndefined()
    setSandboxMode(session, 'workspace-write')
    setSandboxMode(session, 'read-only')
    expect(effectiveSandboxMode(session.events)).toBe('read-only')
  })

  it('setSandboxMode appends exactly one sandbox/mode event per switch', () => {
    const session = new Session(SessionId('sess-write'))
    setSandboxMode(session, 'danger-full-access')
    const modeEvents = session.events.filter(e => e.type === 'sandbox/mode')
    expect(modeEvents).toHaveLength(1)
    expect(modeEvents[0]?.data).toEqual({ mode: 'danger-full-access' })
  })
})
