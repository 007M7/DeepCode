/**
 * Package-manager strategies for SDK project workspaces and child commands.
 *
 * @module @deepseek-ai/dsh-helper/package-managers/package-manager
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { PackageJsonFile } from '../documents/package-json-file.ts'
import { PnpmWorkspaceFile } from '../documents/pnpm-workspace-file.ts'
import type { ProjectFile } from '../documents/project-file.ts'

/** Supported generated-project package managers. */
export type PackageManagerName = 'npm' | 'pnpm' | 'yarn'

/** Result from one child package-manager process. */
export interface CommandResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

/** Injectable subprocess boundary used by package-manager strategies. */
export interface CommandRunner {
  /** Run one executable without a shell and await process exit. */
  run(command: string, args: readonly string[], cwd: string): Promise<CommandResult>
}

/** Injectable package-manager version probe used by project creation. */
export type PackageManagerVersionProbe = (name: PackageManagerName, cwd: string) => Promise<string>

const execFileAsync = promisify(execFile)

/**
 * Read a manager version without forwarding ambient credentials.
 * @param name - package-manager executable.
 * @param cwd - working directory used for resolution.
 * @returns trimmed version output.
 */
export async function probePackageManagerVersion(name: PackageManagerName, cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(name, ['--version'], {
      cwd,
      env: scrubEnvironment(),
      encoding: 'utf8',
    })
    const version = stdout.trim()
    if (!version) throw new Error('empty version output')
    return version
  } catch (error) {
    throw new Error(`cannot run ${name} --version: ${String(error)}`)
  }
}

/** Remove credential-shaped environment variables from spawned commands. */
export function scrubEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/(?:KEY|SECRET|TOKEN)/i.test(name)))
}

/** Node child-process command runner with inherited stdio and quiescent completion. */
export class NodeCommandRunner implements CommandRunner {
  /** Spawn one child and settle only after its exit. */
  run(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        env: scrubEnvironment(),
        stdio: 'inherit',
        shell: false,
      })
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => { resolve({ exitCode, signal }) })
    })
  }
}

function major(version: string): number {
  const match = /^(\d+)/.exec(version)
  if (!match?.[1]) throw new Error(`invalid package manager version: ${JSON.stringify(version)}`)
  return Number(match[1])
}

/** Behavior owned by one generated-project package manager. */
export abstract class PackageManager {
  /** Manager executable and project identity. */
  abstract readonly name: PackageManagerName

  /** Detected concrete manager version. */
  readonly version: string

  constructor(version: string) {
    this.version = version
  }

  /** Validate the detected version against this SDK's supported floor. */
  abstract validateVersion(): void

  /**
   * Configure root manifest fields and return manager-specific files.
   * @param manifest - generated root manifest to update.
   * @returns manager-specific companion documents.
   */
  abstract configureWorkspace(manifest: PackageJsonFile): ProjectFile[]

  /**
   * Build the NPM dependency spec for a local workspace plugin.
   * @returns manager-specific local NPM dependency spec.
   */
  abstract localPluginSpec(): string

  /**
   * Resolve a repository live-link NPM dependency.
   * @param relativePath - relative path from generated project to package.
   * @returns manager-specific NPM dependency spec.
   */
  abstract linkSpec(relativePath: string): string

  /**
   * Build install command arguments.
   * @returns arguments following the manager executable.
   */
  installCommand(): readonly string[] {
    return ['install']
  }

  /**
   * Build project-build command arguments.
   * @returns arguments following the manager executable.
   */
  buildCommand(): readonly string[] {
    return ['run', 'build']
  }

  /**
   * Run NPM dependency installation and fail on non-zero or signalled exit.
   * @param cwd - generated project directory.
   * @param runner - optional subprocess boundary.
   */
  async install(cwd: string, runner: CommandRunner = new NodeCommandRunner()): Promise<void> {
    await this.runChecked(runner, this.installCommand(), cwd, 'install')
  }

  /**
   * Run the project build and fail on non-zero or signalled exit.
   * @param cwd - generated project directory.
   * @param runner - optional subprocess boundary.
   */
  async build(cwd: string, runner: CommandRunner = new NodeCommandRunner()): Promise<void> {
    await this.runChecked(runner, this.buildCommand(), cwd, 'build')
  }

  private async runChecked(runner: CommandRunner, args: readonly string[], cwd: string, operation: string): Promise<void> {
    const result = await runner.run(this.name, args, cwd)
    if (result.signal !== null) {
      throw new Error(`${this.name} ${operation} was killed by ${result.signal}`)
    }
    if (result.exitCode !== 0) {
      throw new Error(`${this.name} ${operation} exited with code ${String(result.exitCode)}`)
    }
  }
}

/** npm workspace behavior. */
export class NpmPackageManager extends PackageManager {
  override readonly name = 'npm'

  /** npm 10 is the supported floor at the repository's Node floor. */
  override validateVersion(): void {
    if (major(this.version) < 10) throw new Error(`npm >=10 is required, got ${this.version}`)
  }

  /** Configure package.json workspaces; npm needs no companion file. */
  override configureWorkspace(manifest: PackageJsonFile): ProjectFile[] {
    manifest.addWorkspace('plugins/*')
    manifest.setPackageManager(undefined)
    return []
  }

  /** npm resolves workspace packages through its ordinary wildcard. */
  override localPluginSpec(): string {
    return '*'
  }

  /** npm live links use file NPM dependencies. */
  override linkSpec(relativePath: string): string {
    return `file:${relativePath}`
  }
}

/** pnpm workspace behavior. */
export class PnpmPackageManager extends PackageManager {
  override readonly name = 'pnpm'

  /** pnpm 10 is the supported floor for strict NPM dependency-build policy. */
  override validateVersion(): void {
    if (major(this.version) < 10) throw new Error(`pnpm >=10 is required, got ${this.version}`)
  }

  /** Configure packageManager and a structured pnpm workspace file. */
  override configureWorkspace(manifest: PackageJsonFile): ProjectFile[] {
    manifest.setPackageManager(`pnpm@${this.version}`)
    const workspace = PnpmWorkspaceFile.create()
    workspace.addPackage('plugins/*')
    return [workspace]
  }

  /** pnpm uses its explicit workspace protocol. */
  override localPluginSpec(): string {
    return 'workspace:*'
  }

  /** pnpm live links use link NPM dependencies. */
  override linkSpec(relativePath: string): string {
    return `link:${relativePath}`
  }
}

/** Yarn Berry-compatible workspace behavior. */
export class YarnPackageManager extends PackageManager {
  override readonly name = 'yarn'

  /** Yarn classic is excluded because the generated project relies on modern workspaces. */
  override validateVersion(): void {
    if (major(this.version) < 2) throw new Error(`Yarn >=2 is required, got ${this.version}`)
  }

  /** Configure packageManager and package.json workspaces. */
  override configureWorkspace(manifest: PackageJsonFile): ProjectFile[] {
    manifest.addWorkspace('plugins/*')
    manifest.setPackageManager(`yarn@${this.version}`)
    return []
  }

  /** Modern Yarn uses the workspace protocol. */
  override localPluginSpec(): string {
    return 'workspace:*'
  }

  /** Yarn live links use portal NPM dependencies to preserve package identity. */
  override linkSpec(relativePath: string): string {
    return `portal:${relativePath}`
  }

  /** Yarn runs scripts without the `run` token. */
  override buildCommand(): readonly string[] {
    return ['build']
  }
}

/**
 * Construct and validate one package-manager strategy.
 * @param name - selected manager.
 * @param version - detected concrete version.
 * @returns validated strategy.
 */
export function createPackageManager(name: PackageManagerName, version: string): PackageManager {
  let manager: PackageManager
  switch (name) {
    case 'npm': manager = new NpmPackageManager(version); break
    case 'pnpm': manager = new PnpmPackageManager(version); break
    case 'yarn': manager = new YarnPackageManager(version); break
  }
  manager.validateVersion()
  return manager
}

/**
 * Infer a package manager from an explicit choice or npm user-agent value.
 * @param explicit - explicit CLI selection.
 * @param userAgent - npm-compatible user-agent string.
 * @returns selected or inferred manager name.
 */
export function inferPackageManagerName(
  explicit: PackageManagerName | undefined,
  userAgent: string | undefined = process.env.npm_config_user_agent,
): PackageManagerName | undefined {
  if (explicit) return explicit
  const token = userAgent?.split(' ')[0]?.split('/')[0]
  if (token === 'npm' || token === 'pnpm' || token === 'yarn') return token
  return undefined
}
