/**
 * GitHub repository source validation and prepared-wrapper loading.
 * @module
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context, Fiber, FiberState, Plugin } from 'cordis'
import type { RepositoryCache } from '@cordisjs/plugin-loader/repository'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import { z } from 'zod'
import {
  PREPARED_ENTRY_FILENAME,
  REPOSITORY_PLUGIN_PREPARE_COMMAND,
} from './format.ts'

// Value mirror: Cordis's const enum has no runtime object to import. Keep
// aligned with `packages/self-modification/tool-cordis/src/fiber-state.ts`.
const FIBER_ACTIVE = 2 as FiberState.ACTIVE

/** Directory under the Harness home containing immutable repository generations. */
export const DEFAULT_REPOSITORY_CACHE_DIRECTORY = 'repository-plugins'

/** Temporary host command supplied to repository package lifecycle scripts. */
export interface RepositoryPrepareCommand {
  /** Absolute directory to prepend to the isolated install's executable search path. */
  directory: string
  /** Remove the temporary command directory. */
  dispose(): Promise<void>
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function batchQuote(value: string): string {
  return `"${value.replaceAll('%', '%%')}"`
}

/**
 * Materialize the DSH-owned prepare executable used only while pnpm packs Git source.
 * @returns a command directory and its idempotent cleanup operation.
 */
export async function createRepositoryPrepareCommand(): Promise<RepositoryPrepareCommand> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-repository-plugin-bin-'))
  const target = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
  try {
    await Promise.all([
      writeFile(join(directory, REPOSITORY_PLUGIN_PREPARE_COMMAND), [
        '#!/bin/sh',
        `exec ${shellQuote(process.execPath)} ${shellQuote(target)} "$@"`,
        '',
      ].join('\n'), { mode: 0o700 }),
      writeFile(join(directory, `${REPOSITORY_PLUGIN_PREPARE_COMMAND}.cmd`), [
        '@echo off',
        `${batchQuote(process.execPath)} ${batchQuote(target)} %*`,
        '',
      ].join('\r\n'), { mode: 0o700 }),
    ])
  } catch (cause) {
    /* v8 ignore next -- requires a host filesystem failure after mkdtemp; cleanup semantics are the contract under test. */
    await rm(directory, { recursive: true, force: true })
    /* v8 ignore next -- preserves that unstageable host failure after best-effort cleanup. */
    throw cause
  }
  return {
    directory,
    async dispose() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

// The ref segment excludes `#` so `github:o/r#a#b` fails here — at the config
// parser, with the syntax the error message promises — instead of inside the
// cache's pnpm install ('misconfiguration fails loud at the earliest
// resolvable point').
const GITHUB_SOURCE_PATTERN = /^github:([^/\s#&]+)\/([^/\s#&]+)#([^\s#&]+)(?:&path:(\/[^\s&]+))?$/
const installedPackageSchema = z.looseObject({
  scripts: z.looseObject({
    prepack: z.literal(REPOSITORY_PLUGIN_PREPARE_COMMAND),
  }),
})

function validPluginPath(path: string): boolean {
  const segments = path.split('/').slice(1)
  return segments.length > 0
    && segments.at(-1) === '.dsh-plugin'
    && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

/**
 * Normalize one user-facing GitHub source to the exact pnpm dependency specifier.
 * @param configured - `github:owner/repo#ref` with an optional `&path:/.../.dsh-plugin`.
 * @returns the exact specifier, with the root `.dsh-plugin` subpath added when omitted.
 * @throws when the GitHub owner, repository, explicit ref, or plugin subpath is invalid.
 */
export function resolveRepositorySpecifier(configured: string): string {
  const match = GITHUB_SOURCE_PATTERN.exec(configured)
  if (match === null) {
    throw new Error(`repository source must use github:owner/repo#<ref> with an optional &path:/.../.dsh-plugin: ${JSON.stringify(configured)}`)
  }
  const path = match[4]
  if (path !== undefined && !validPluginPath(path)) {
    throw new Error(`repository source path must be an absolute repository subpath ending in .dsh-plugin without empty, . or .. segments: ${JSON.stringify(path)}`)
  }
  return path === undefined ? `${configured}&path:/.dsh-plugin` : configured
}

/**
 * Resolve the persistent repository cache root.
 * @param configured - explicit cache directory, or undefined for `$DSH_HOME/cache/repository-plugins`.
 * @returns an absolute cache directory.
 */
export function resolveRepositoryCacheDirectory(configured: string | undefined): string {
  return resolve(configured ?? join(resolveDshHome(), 'cache', DEFAULT_REPOSITORY_CACHE_DIRECTORY))
}

async function assertInstalledPackageMetadata(directory: string): Promise<void> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as unknown
  } catch (cause) {
    throw new Error(`failed to read installed DSH plugin package metadata in ${directory}`, { cause })
  }
  const result = installedPackageSchema.safeParse(value)
  if (!result.success) {
    throw new Error(`installed DSH plugin package must declare scripts.prepack as ${JSON.stringify(REPOSITORY_PLUGIN_PREPARE_COMMAND)}:\n${z.prettifyError(result.error)}`)
  }
}

/**
 * Load one exact repository generation's generated wrapper as a child Cordis fiber.
 * @param ctx - repository runtime context that owns the child.
 * @param cache - package-manager-native immutable repository cache.
 * @param specifier - normalized exact pnpm dependency specifier.
 * @returns the settled prepared-wrapper fiber.
 * @throws when installation, wrapper import, manifest validation, or child registration fails.
 */
export async function loadPreparedRepository(
  ctx: Context,
  cache: Pick<RepositoryCache, 'resolve'>,
  specifier: string,
): Promise<Fiber> {
  const directory = await cache.resolve(specifier)
  const filename = join(directory, PREPARED_ENTRY_FILENAME)
  try {
    await assertInstalledPackageMetadata(directory)
    const plugin = await import(/* @vite-ignore */pathToFileURL(filename).href) as Plugin
    const fiber = ctx.plugin(plugin)
    await fiber
    // Awaiting a service-gated fiber returns while it is still PENDING (the
    // generated wrapper injects `skills`/`tools` per its manifest). This
    // runtime commits the repository configuration transactionally, so a
    // composition that never provides a required service must reject the
    // transaction here — not settle ACTIVE with a silently pending child.
    if (fiber.state !== FIBER_ACTIVE) {
      const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
      /* v8 ignore next 2 -- the 'unknown' arm needs a service to appear after the state read; not deterministically stageable. */
      const detail = missing.join(', ') || 'unknown'
      throw new Error(`prepared wrapper did not activate (waiting for services: ${detail})`)
    }
    return await fiber
  } catch (cause) {
    throw new Error(`failed to load prepared repository Plugin ${JSON.stringify(specifier)} from ${filename}`, { cause })
  }
}
