/** Bare Vite must fail before it can present a bootless shell as a working GUI. */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('Web development entry', () => {
  it('rejects the package dev alias with the full-host correction', async () => {
    const result = await execa('pnpm', ['run', 'dev'], { cwd: WEB_ROOT, reject: false })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('apps/web is build-only')
    expect(result.stderr).toContain('dsh web')
  })

  it('rejects the standalone Vite server with the full-host correction', async () => {
    const result = await execa(join(WEB_ROOT, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', '0'], {
      cwd: WEB_ROOT,
      reject: false,
      timeout: 2_000,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('apps/web is not a standalone application')
    expect(result.stderr).toContain('dsh web')
    expect(result.stderr).toContain('window.__DSH_BOOT__')
  })
})
