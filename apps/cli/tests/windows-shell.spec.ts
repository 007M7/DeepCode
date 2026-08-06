import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileLayer } from '@deepseek-ai/dsh-app-boot'
import {
  BASE_BUNDLE,
  resolveWindowsShellLayer,
  WINDOWS_SHELL_PATCH_FILENAME,
} from '../src/windows-shell.ts'

const WINDOWS_PATCH = `- id: bash-sandbox
  disabled: true
- insert:
    - id: pwsh-local
      name: '@deepseek-ai/dsh-pwsh-local'
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
      { insert: [{ id: 'pwsh-local', name: '@deepseek-ai/dsh-pwsh-local' }] },
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
