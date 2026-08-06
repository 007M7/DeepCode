/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@cordisjs/plugin-include'

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dsh?: { bundle?: { patch?: string } } }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
  })

  it('ships the Windows platform layer as the documented danger-full-access roster', () => {
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
    // The POSIX-only sandboxed stacks leave the Windows roster as one unit:
    // shell (bash-sandbox/tool-bash), the permission switcher it requires,
    // the fs/sandbox policy stack whose OS runners do not exist on win32,
    // and the approval service — nothing on Windows asks for approval, so
    // the model is never told approval exists or that asks auto-reject.
    expect(disables).toEqual(
      expect.arrayContaining([
        'bash-sandbox',
        'tool-bash',
        'permission',
        'ui-permission',
        'sandbox',
        'sandbox-policy',
        'fs-sandbox',
        'approval',
      ]),
    )
    const inserted = parsed
      .flatMap(patch => patch.insert ?? [])
      .map(row => row.id)
    expect(inserted).toEqual(
      expect.arrayContaining(['pwsh-local', 'tool-pwsh', 'fs-local']),
    )
    // Full danger-full-access degradation: no approval surface at all.
    expect(parsed.find(patch => patch.id === 'approval')?.config).toBeUndefined()
  })
})
