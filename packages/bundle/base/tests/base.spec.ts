/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown> }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.find(row => row.id === 'telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.DSH_TELEMETRY_MODE || 'DISABLED'",
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(1)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(1)
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-subagent-codex': 'workspace:^',
      '@deepseek-ai/dsh-subagent-claude-code': 'workspace:^',
    })
  })

  it('ships the Windows platform layer as the confined pwsh roster over the ACL runner chain', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'windows.cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as {
      id?: string
      disabled?: boolean
      insert?: { id?: string; name?: string }[]
      config?: { policy?: string }
    }[]
    const disables = parsed
      .filter(patch => patch.disabled === true)
      .map(patch => patch.id)
    // Only the POSIX bash stack is disabled: the Windows roster confines the
    // pwsh executor through the ACL runner chain, so the sandbox/policy rows,
    // the permission switcher, fs-sandbox, and the approval service all stay
    // enabled exactly as on POSIX — only the shell is swapped.
    expect(disables).toEqual(['bash-sandbox', 'tool-bash'])
    const inserted = parsed
      .flatMap(patch => patch.insert ?? [])
      .map(row => row.id)
    expect(inserted).toEqual(['pwsh-sandbox', 'tool-pwsh'])
    // The patch no longer touches the permission/approval surface at all.
    expect(parsed.find(patch => patch.id === 'approval')).toBeUndefined()
    expect(parsed.find(patch => patch.id === 'permission')).toBeUndefined()
    expect(parsed.find(patch => patch.id === 'sandbox')).toBeUndefined()
    expect(parsed.find(patch => patch.id === 'sandbox-policy')).toBeUndefined()
    expect(parsed.find(patch => patch.id === 'fs-sandbox')).toBeUndefined()
  })
})
