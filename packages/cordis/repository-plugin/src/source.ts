/**
 * GitHub repository source validation and prepared-wrapper loading.
 * @module
 */

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber, Plugin } from 'cordis'
import type { RepositoryCache } from '@cordisjs/plugin-loader/repository'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import { PREPARED_ENTRY_FILENAME } from './format.ts'

/** Directory under the Harness home containing immutable repository generations. */
export const DEFAULT_REPOSITORY_CACHE_DIRECTORY = 'repository-plugins'

const GITHUB_SOURCE_PATTERN = /^github:([^/\s#&]+)\/([^/\s#&]+)#([^\s&]+)(?:&path:(\/[^\s&]+))?$/

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
    const plugin = await import(/* @vite-ignore */pathToFileURL(filename).href) as Plugin
    const fiber = ctx.plugin(plugin)
    return await fiber
  } catch (cause) {
    throw new Error(`failed to load prepared repository Plugin ${JSON.stringify(specifier)} from ${filename}`, { cause })
  }
}
