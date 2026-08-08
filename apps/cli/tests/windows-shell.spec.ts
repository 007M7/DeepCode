import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProfileLayer } from '@deepseek-ai/dsh-app-boot'
import { composeEntries, initProfile, loadProfile, PROFILES_DIR } from '@deepseek-ai/dsh-app-boot'
import {
  BASE_BUNDLE,
  resolveWindowsShellLayer,
  WINDOWS_SHELL_PATCH_FILENAME,
} from '../src/windows-shell.ts'

const WINDOWS_PATCH = `- id: bash-sandbox
  disabled: true
- insert:
    - id: pwsh-sandbox
      name: '@deepseek-ai/dsh-pwsh-sandbox'
`

/** One fake bundle layer rooted in a temp directory. */
function fakeLayer(packageName: string, dir: string): ProfileLayer {
  return { packageName, packageDir: dir, patchPath: join(dir, 'cordis.patch.yml'), patches: [] }
}

/** A base bundle layer whose package carries the Windows shell patch. */
function baseLayerWithPatch(dir: string): ProfileLayer {
  writeFileSync(join(dir, WINDOWS_SHELL_PATCH_FILENAME), WINDOWS_PATCH)
  return fakeLayer(BASE_BUNDLE, dir)
}

describe('resolveWindowsShellLayer', () => {
  let base: string
  afterEach(() => { if (base !== undefined) rmSync(base, { recursive: true, force: true }) })
  const tempBase = (): string => {
    base = mkdtempSync(join(tmpdir(), 'dsh-windows-shell-'))
    return base
  }

  it('never applies on POSIX hosts', () => {
    expect(resolveWindowsShellLayer('linux', [baseLayerWithPatch(tempBase())], 'dsh')).toBeUndefined()
    expect(resolveWindowsShellLayer('darwin', [baseLayerWithPatch(tempBase())], 'dsh')).toBeUndefined()
  })

  it('defaults Windows hosts to the pwsh platform layer', () => {
    const layer = resolveWindowsShellLayer('win32', [baseLayerWithPatch(tempBase())], 'dsh')
    expect(layer).toBeDefined()
    expect(layer?.label.endsWith(WINDOWS_SHELL_PATCH_FILENAME)).toBe(true)
    expect(layer?.patches).toEqual([
      { id: 'bash-sandbox', disabled: true },
      { insert: [{ id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox' }] },
    ])
  })

  it('skips custom profiles without a base bundle', () => {
    const other = fakeLayer('@deepseek-ai/dsh-custom', tempBase())
    expect(resolveWindowsShellLayer('win32', [other], 'dsh')).toBeUndefined()
  })

  it('fails loud when the base bundle ships no Windows shell patch', () => {
    const base = tempBase()
    mkdirSync(base, { recursive: true })
    expect(() => resolveWindowsShellLayer('win32', [fakeLayer(BASE_BUNDLE, base)], 'dsh'))
      .toThrow(/@deepseek-ai\/dsh-base ships no windows\.cordis\.patch\.yml/)
  })
})

describe('the shipped Windows composition (real bundle layers)', () => {
  let home: string
  afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }) })
  // The app installation anchor, mirroring profile-boot.ts: the bundle layers
  // resolve from the REAL dsh-base/dsh-web-app packages through it, so this
  // suite composes the shipped patch files, not test fixtures.
  const anchor = fileURLToPath(new URL('../package.json', import.meta.url))

  it('composes the win32 confined roster through the real patch layers', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-windows-home-'))
    initProfile(join(home, PROFILES_DIR, 'web'), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const profile = loadProfile('dsh', 'web', anchor, home)
    const warnings: string[] = []
    const win32 = resolveWindowsShellLayer('win32', profile.layers, 'dsh')
    expect(win32).toBeDefined()
    const rows = composeEntries(
      [...profile.layers.map(layer => layer.patches), win32!.patches],
      message => warnings.push(message),
    )
    const byId = new Map(rows.map(row => [row.id, row]))
    // Only the POSIX bash stack leaves the roster: the permission surface
    // (sandbox/sandbox-policy/fs-sandbox, permission, approval) stays enabled
    // exactly as on POSIX — the confined pwsh executor is what changes.
    for (const id of ['bash-sandbox', 'tool-bash']) {
      expect(byId.get(id)?.disabled, `row ${id}`).toBe(true)
    }
    for (const id of ['permission', 'ui-permission', 'sandbox', 'sandbox-policy', 'fs-sandbox', 'approval']) {
      expect(byId.get(id)?.disabled, `row ${id}`).not.toBe(true)
    }
    for (const id of ['pwsh-sandbox', 'tool-pwsh']) {
      expect(byId.has(id), `inserted row ${id}`).toBe(true)
    }
    // The launcher's cold-start module fallback BFS-links the apps/cli
    // dependency closure into the profile's node_modules (the pwsh-local
    // precedent), so every inserted bare plugin must resolve from there.
    const cliManifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies?: Record<string, string> }
    for (const name of ['@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-tool-pwsh']) {
      expect(cliManifest.dependencies?.[name], `cold-start closure must reach ${name}`).toBeDefined()
    }
    // The patch touches only base-owned rows plus inserts, so the full web
    // profile composes without any no-match warning.
    expect(warnings).toEqual([])
  })

  it('leaves POSIX untouched and base-only profiles compose without warnings', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-windows-home-'))
    initProfile(join(home, PROFILES_DIR, 'web'), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const profile = loadProfile('dsh', 'web', anchor, home)
    // POSIX: no platform layer, the bash stack stays enabled.
    const posixRows = composeEntries(profile.layers.map(layer => layer.patches))
    const posixById = new Map(posixRows.map(row => [row.id, row]))
    expect(posixById.get('bash-sandbox')?.disabled).not.toBe(true)
    expect(posixById.has('pwsh-local')).toBe(false)
    expect(posixById.has('pwsh-sandbox')).toBe(false)

    // A base-only custom profile (the DEFAULT_PROFILE_BUNDLES template): the
    // patch touches only base-owned rows (bash-sandbox/tool-bash) plus its
    // inserts, so the composition produces no no-match warning.
    initProfile(join(home, PROFILES_DIR, 'base-only'), ['@deepseek-ai/dsh-base'])
    const baseOnly = loadProfile('dsh', 'base-only', anchor, home)
    const baseWarnings: string[] = []
    const win32 = resolveWindowsShellLayer('win32', baseOnly.layers, 'dsh')
    expect(win32).toBeDefined()
    composeEntries(
      [...baseOnly.layers.map(layer => layer.patches), win32!.patches],
      message => baseWarnings.push(message),
    )
    expect(baseWarnings).toEqual([])
  })
})
