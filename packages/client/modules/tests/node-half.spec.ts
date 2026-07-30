/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { HttpServerService } from '@deepseek-ai/dsh-host-webserver'
import { ClientModuleHostService } from '../src/index.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable dshClient package whose client export points at the returned path. */
function writePackage(packageName: string): string {
  root ??= mkdtempSync(join(tmpdir(), 'dsh-client-modules-'))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    dshClient: { platform: 'web' },
  }))
  return clientPath
}

/** Construct the node-half service over the enabled fixture entries. */
function construct(packageNames: string[]): ClientModuleHostService {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      for (const packageName of packageNames) {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      }
    },
  })
  const httpServer: Pick<HttpServerService, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: () => () => {},
    tapIndex: () => () => {},
  }
  ctx.provide('httpServer', httpServer as HttpServerService)
  return new ClientModuleHostService(ctx)
}

describe('client bundle activation', () => {
  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client packages requiring a build before source launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('requiring a build before source launch')
  })
})
