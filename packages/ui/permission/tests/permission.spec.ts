import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import PermissionService, { CUSTOM_PRESET, effectivePermissionPreset } from '@deepseek-ai/dsh-permission'
import type { Config } from '@deepseek-ai/dsh-permission'

async function mounted(options: {
  config?: Config
  bashDefault?: SandboxMode | undefined
  approvalDefault?: ApprovalPolicy | undefined
} = {}): Promise<Context> {
  const ctx = new Context()
  ctx.provide('bash', {
    sandboxMode: 'bashDefault' in options ? options.bashDefault : 'workspace-write',
    resolve() { throw new Error('permission tests do not execute bash') },
    run() { throw new Error('permission tests do not execute bash') },
    start() { throw new Error('permission tests do not execute bash') },
  })
  ctx.provide('approval', { config: { policy: 'approvalDefault' in options ? options.approvalDefault : 'ask' } })
  await ctx.plugin(PermissionService, options.config ?? {})
  return ctx
}

function freshSession(id: string): Session {
  return new Session(SessionId(id))
}

describe('effectivePermissionPreset', () => {
  it('folds to the last event, or undefined without one', () => {
    const session = freshSession('sess-fold')
    expect(effectivePermissionPreset(session.events)).toBeUndefined()
    session.append('permission/preset', { preset: 'danger-full-access' })
    session.append('permission/preset', { preset: 'workspace-write' })
    expect(effectivePermissionPreset(session.events)).toBe('workspace-write')
    // The backward scan steps over non-preset events to the latest selection.
    session.append('sandbox/mode', { mode: 'read-only' })
    expect(effectivePermissionPreset(session.events)).toBe('workspace-write')
  })
})

describe('PermissionService', () => {
  it('advertises the preset table in declaration order and resolves bundles', async () => {
    const ctx = await mounted()
    expect(ctx.permission.names).toEqual(['workspace-write', 'danger-full-access'])
    expect(ctx.permission.resolve('danger-full-access')).toMatchObject({ sandbox: 'danger-full-access', approval: 'never' })
    expect(() => ctx.permission.resolve('plan')).toThrow(/unknown preset "plan"/)
  })

  it('current() derives from the effective knobs: composition defaults hit workspace-write, a switch hits its preset', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-current')
    expect(ctx.permission.current(session.events)).toBe('workspace-write')
    ctx.permission.set(session, 'danger-full-access')
    expect(ctx.permission.current(session.events)).toBe('danger-full-access')
  })

  it('a knob state matching no table entry derives custom — a state, not an error', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-custom')
    session.append('sandbox/mode', { mode: 'read-only' })
    expect(ctx.permission.current(session.events)).toBe(CUSTOM_PRESET)
    ctx.permission.set(session, 'danger-full-access')
    expect(ctx.permission.current(session.events)).toBe('danger-full-access')
    expect(() => ctx.permission.resolve(CUSTOM_PRESET)).toThrow(/unknown preset/)
  })

  it('composition defaults outside the table derive custom at zero events', async () => {
    const ctx = await mounted({ approvalDefault: 'never' })
    const session = freshSession('sess-defaults-custom')
    expect(ctx.permission.current(session.events)).toBe(CUSTOM_PRESET)
  })

  it('the fold breaks bundle ties; a stale fold no longer matching falls back to table order', async () => {
    const ctx = await mounted({ config: { presets: {
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      agentish: { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    } } })
    const session = freshSession('sess-tie')
    ctx.permission.set(session, 'agentish')
    expect(ctx.permission.current(session.events)).toBe('agentish')
    session.append('approval/policy', { policy: 'never' })
    session.append('sandbox/mode', { mode: 'danger-full-access' })
    expect(ctx.permission.current(session.events)).toBe('danger-full-access')
  })

  it('set() writes through: one preset event plus both knob events', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-set')
    ctx.permission.set(session, 'danger-full-access')
    expect(session.events.map(e => [e.type, e.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
  })

  it('set() to the current preset is a no-op when the knobs already match (clicks are not switches)', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-noop')
    ctx.permission.set(session, 'workspace-write')
    expect(session.events).toHaveLength(0)
  })

  it('re-asserting a preset from a drifted (custom) state re-records the choice and repairs the knob', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-drift')
    ctx.permission.set(session, 'danger-full-access')
    // Re-selecting from a drifted state records the choice and repairs only
    // the changed knob.
    session.append('sandbox/mode', { mode: 'read-only' })
    ctx.permission.set(session, 'danger-full-access')
    const tail = session.events.slice(4)
    expect(tail.map(e => [e.type, e.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
    ])
  })

  it('rejects composition over a non-confining executor at load', async () => {
    await expect(mounted({ bashDefault: undefined }))
      .rejects.toThrow(/does not confine/)
  })

  it('optionOf() presents shipped labels/descriptions, falls back to the raw key, and fixes custom', async () => {
    const ctx = await mounted()
    expect(ctx.permission.optionOf('danger-full-access')).toEqual({ value: 'danger-full-access', name: 'danger-full-access', description: 'Full file access without approval prompts.' })
    expect(ctx.permission.optionOf('custom')).toEqual({ value: 'custom', name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' })
    const bare = await mounted({ config: { presets: { plain: { sandbox: 'workspace-write', approval: 'ask' } } } })
    expect(bare.permission.optionOf('plain')).toEqual({ value: 'plain', name: 'plain' })
    expect(() => ctx.permission.optionOf('plan')).toThrow(/unknown preset/)
  })

  it('rejects a table entry named custom (reserved for the derived state)', async () => {
    await expect(mounted({ config: { presets: { custom: { sandbox: 'read-only', approval: 'ask' } } } }))
      .rejects.toThrow(/reserved for the derived not-a-preset state/)
  })

  it('reads a schema-less approval stand-in as the ask default', async () => {
    const ctx = await mounted({ approvalDefault: undefined })
    const session = freshSession('sess-standin')
    ctx.permission.set(session, 'workspace-write')
    expect(session.events).toHaveLength(0)
    expect(ctx.permission.current(session.events)).toBe('workspace-write')
  })
})
