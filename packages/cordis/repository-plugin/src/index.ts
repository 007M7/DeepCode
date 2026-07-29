/**
 * Restricted repository-plugin runtime for static skills and common MCP definitions.
 * @module @deepseek-ai/dsh-repository-plugin
 */

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-loader'
import * as SkillLocal from '@deepseek-ai/dsh-skill-local'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import {
  REPOSITORY_PLUGIN_BUILTIN,
  parsePreparedPluginConfig,
  type PreparedPluginConfig,
} from './format.ts'
import { parseMcpDocument, resolveMcpServers } from './mcp.ts'

export {
  PREPARED_ASSET_DIRECTORY,
  PREPARED_ENTRY_FILENAME,
  REPOSITORY_PLUGIN_BUILTIN,
  prepareDshPlugin,
  type PreparedPluginManifest,
} from './format.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'repository-plugin'
/** Loader service required to register the fixed prepared-wrapper builtin. */
export const inject = ['loader']

function preparedPath(baseUrl: string, configured: string): string {
  if (isAbsolute(configured)) throw new Error(`prepared DSH plugin path must be relative: ${JSON.stringify(configured)}`)
  const directory = dirname(fileURLToPath(baseUrl))
  const path = resolve(directory, configured)
  const rel = relative(directory, path)
  /* v8 ignore next -- Different-drive Windows relative paths cannot be produced on POSIX coverage hosts. */
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`prepared DSH plugin path escapes its package: ${JSON.stringify(configured)}`)
  }
  return path
}

async function applyPrepared(ctx: Context, value: PreparedPluginConfig): Promise<void> {
  const config = parsePreparedPluginConfig(value)
  const directory = dirname(fileURLToPath(config.baseUrl))
  const skillDirectories = config.manifest.skills.map(path => preparedPath(config.baseUrl, path))
  const mcpConfigs = config.manifest.mcpServers === undefined
    ? []
    : resolveMcpServers(
      parseMcpDocument(await readFile(preparedPath(config.baseUrl, config.manifest.mcpServers), 'utf8')),
      process.env,
      directory,
    ).map(input => McpClient.Config(input as never))

  await ctx.effect(async function* () {
    if (skillDirectories.length > 0) {
      const skills = ctx.plugin(SkillLocal, {
        providerName: `repository:${config.manifest.name}`,
        includeDefaultRoots: false,
        customSkillDirs: skillDirectories,
        watch: false,
      })
      await skills
      yield skills.dispose
    }
    for (const mcpConfig of mcpConfigs) {
      const mcp = ctx.plugin(McpClient, mcpConfig)
      await mcp
      yield mcp.dispose
    }
  }, `repository-plugin(${config.manifest.name})`)
}

const preparedRuntime = {
  name: 'repository-plugin-runtime',
  apply: applyPrepared,
}

/**
 * Register the DSH-owned runtime as the Loader builtin used by fixed prepared wrappers.
 * @param ctx - plugin context carrying the Loader service.
 */
export function apply(ctx: Context): void {
  if (ctx.loader.builtins[REPOSITORY_PLUGIN_BUILTIN] !== undefined) {
    throw new Error(`Loader builtin ${REPOSITORY_PLUGIN_BUILTIN} is already registered`)
  }
  ctx.effect(function* () {
    ctx.loader.builtins[REPOSITORY_PLUGIN_BUILTIN] = preparedRuntime
    yield () => {
      if (ctx.loader.builtins[REPOSITORY_PLUGIN_BUILTIN] === preparedRuntime) {
        Reflect.deleteProperty(ctx.loader.builtins, REPOSITORY_PLUGIN_BUILTIN)
      }
    }
  }, 'repository-plugin Loader builtin')
}
