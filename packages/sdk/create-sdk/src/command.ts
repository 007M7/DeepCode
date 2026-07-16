/**
 * Internal create-sdk command composition used by the package bin.
 *
 * @module @deepseek-ai/create-sdk/command
 */

import { readFile } from 'node:fs/promises'
import {
  ClackPromptPort,
  PromptCancelledError,
  type PackageManagerVersionProbe,
  type PromptPort,
} from '@deepseek-ai/dsh-helper'
import { parseCreateArgs } from './args.ts'
import { CreateWizard, type ResolvedCreateRequest } from './create-wizard.ts'
import { scaffoldProject, type ScaffoldResult } from './project-scaffolder.ts'
import { CREATE_TEMPLATES, packageManagerTemplateModel } from './templates/create-templates.ts'

/** Process and terminal slice used by the initializer. */
export interface CreateCommandContext {
  cwd: string
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
  releaseVersion?: string
  versionProbe?: PackageManagerVersionProbe
  port?: PromptPort
  setup?: (request: ResolvedCreateRequest) => Promise<void>
}

/** Read this initializer package's release version in source and built layouts. */
export async function readCreateSdkVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  /* v8 ignore next -- this package's checked-in manifest always carries its version */
  if (typeof manifest.version !== 'string') throw new Error('create-sdk package version is missing')
  return manifest.version
}

/** Resolve, write, optionally install, and build one new project. */
export async function createProject(
  argv: readonly string[],
  context: CreateCommandContext,
): Promise<ScaffoldResult | undefined> {
  const args = parseCreateArgs(argv)
  if (args.help) {
    context.stdout.write(CREATE_TEMPLATES.usage.render({}))
    return undefined
  }
  if (!context.port && (!context.stdin.isTTY || !context.stdout.isTTY)) {
    throw new Error('create-sdk requires an interactive TTY')
  }
  const wizard = new CreateWizard({
    args,
    /* v8 ignore next -- production TTY wiring is exercised by the built-bin smoke */
    port: context.port ?? new ClackPromptPort(context.stdin, context.stdout),
    cwd: context.cwd,
    releaseVersion: context.releaseVersion ?? await readCreateSdkVersion(),
    ...context.versionProbe ? { versionProbe: context.versionProbe } : {},
  })
  const resolved = await wizard.run()
  const result = await scaffoldProject(resolved.directory, resolved.request)
  context.stdout.write(CREATE_TEMPLATES.created.render({
    name: resolved.request.name,
    directory: resolved.directory,
  }))
  if (resolved.install) {
    try {
      if (context.setup) await context.setup(resolved)
      else {
        await resolved.request.packageManager.install(resolved.directory)
        await resolved.request.packageManager.build(resolved.directory)
      }
    } catch (error) {
      context.stderr.write(CREATE_TEMPLATES.setupFailure.render({
        directory: resolved.directory,
        error: String(error),
        ...packageManagerTemplateModel(resolved.request.packageManager),
      }))
      throw error
    }
  }
  context.stdout.write(CREATE_TEMPLATES.nextSteps.render({
    directory: resolved.directory,
    setupRequired: !resolved.install,
    ...packageManagerTemplateModel(resolved.request.packageManager),
  }))
  return result
}

/** Run the create command with process defaults and convert cancellation to a clean exit. */
export async function runCreateCommand(
  argv: readonly string[] = process.argv.slice(2),
  context: CreateCommandContext = {
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  try {
    await createProject(argv, context)
    return 0
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      context.stderr.write('create-sdk: cancelled\n')
      return 1
    }
    context.stderr.write(`create-sdk: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
