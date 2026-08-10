import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import InvariantService from '@deepseek-ai/dsh-invariants'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes'
import type { ApiRemoteForwardedEvent } from '@deepseek-ai/dsh-api-remotes'
import * as ApiRemotesInvariant from '@deepseek-ai/dsh-api-remotes/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantService)
  await ctx.plugin(ApiRemotesInvariant)
  return ctx
}

/**
 * One legal emission per allowlisted event. `Events` types each emit by name,
 * so the three arities (0, 2, 1) cannot share a single loop body; keying the
 * table by {@link ApiRemoteForwardedEvent} makes the compiler reject it as soon
 * as the allowlist grows, which keeps "every listed event is exercised" true
 * without a single argument-list assertion.
 */
const legalEmission: Record<ApiRemoteForwardedEvent, (ctx: Context) => void> = {
  'commands/change': ctx => { ctx.emit('commands/change') },
  'credentials/updated': ctx => { ctx.emit('credentials/updated', credentialRef('DEMO_TOKEN')) },
  'settings/document-updated': ctx => {
    ctx.emit('settings/document-updated', settingsNamespace('demo'), 1)
  },
}

describe('forwarded host event invariants', () => {
  it('accepts an unscoped one-way dispatch of every allowlisted event', async () => {
    const ctx = await setup()
    for (const event of API_REMOTE_FORWARDED_EVENTS) {
      expect(() => { legalEmission[event](ctx) }).not.toThrow()
    }
  })

  it('ignores an owner package event the allowlist does not select', async () => {
    const ctx = await setup()
    // `settings/updated` is the resolved-value event, deliberately left out of
    // the allowlist while its sibling `settings/document-updated` is in it, so
    // this pins that the check discriminates by name rather than by owner.
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('demo'), { a: 1 }, { a: 2 }, 'update')
    }).not.toThrow()
    // The carrier that fails an allowlisted event must pass unremarked here.
    expect(() => {
      ctx.emit({}, 'settings/updated', settingsNamespace('demo'), { a: 1 }, { a: 2 }, 'update')
    }).not.toThrow()
  })

  it('rejects an allowlisted event dispatched with a Scope carrier', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit({}, 'commands/change') })
      .toThrow(/"commands\/change" was dispatched with a Scope carrier/)
  })

  it('rejects an allowlisted event dispatched as anything but one-way', async () => {
    const ctx = await setup()
    expect(() => { ctx.bail('commands/change') })
      .toThrow(/"commands\/change" was dispatched as "bail"/)
  })
})
