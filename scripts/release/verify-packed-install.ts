/**
 * Install a packed release family into a throwaway consumer outside the
 * repository and drive its installed executable with plain Node.
 *
 * Everything the packed tarballs need comes from the tarballs themselves: the
 * consumer declares every member as a `file:` dependency, so the only registry
 * traffic is for external dependencies. What this proves is that `files`
 * selected a complete payload and that the published dependency ranges resolve
 * — a workspace link or a stale `lib/` in the checkout cannot stand in for a
 * missing file here
 * ([rationale](../../.agents/notes/proposed/process/2026-08-10-npm-release-sequences.md)).
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { releaseFamily, tarballName, type ReleaseMember } from './families.ts'

/**
 * Environment for the installed artifact: no host Node hooks, no host DeepSeek
 * Harness home, and no ambient npm user agent that would confuse npm.
 * @param consumerRoot - the throwaway consumer directory.
 * @returns The child environment.
 */
function consumerEnvironment(consumerRoot: string): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.npm_config_user_agent
  delete environment.NPM_CONFIG_USER_AGENT
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  environment.DSH_HOME = resolve(consumerRoot, '.dsh')
  environment.DSH_AGENTS_HOME = resolve(consumerRoot, '.agents')
  environment.DSH_TELEMETRY_DISABLED = '1'
  return environment
}

/**
 * Run a command in the consumer and fail the process on a non-zero exit.
 * @param command - executable name.
 * @param args - command arguments.
 * @param cwd - working directory.
 * @param env - child environment.
 * @returns The captured stdout, trimmed.
 */
function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, [...args], { cwd, env, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

/** Install the family named by `--family` from `--from` and drive its entry. */
function main(): void {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, from: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined || values.from === undefined) {
    throw new Error('usage: verify-packed-install.ts --family <dsh|vendor> --from <packed directory>')
  }

  const family = releaseFamily(values.family)
  const entry = family.installedEntry
  const root = process.cwd()
  const packed = resolve(root, values.from)
  const members: ReleaseMember[] = family.members(root)

  if (entry === undefined) {
    console.log(`release verify-packed-install: family ${family.id} publishes no executable, nothing to drive`)
    return
  }

  const consumerRoot = mkdtempSync(join(tmpdir(), `dsh-packed-${family.id}-`))
  try {
    const dependencies = Object.fromEntries(members.map(member =>
      [member.name, pathToFileURL(join(packed, tarballName(member))).href]))
    writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
      name: `dsh-packed-install-${family.id}`,
      version: '0.0.0',
      private: true,
      dependencies,
    }, null, 2)}\n`)

    const environment = consumerEnvironment(consumerRoot)
    console.log(`release verify-packed-install: installing ${String(members.length)} tarball(s) into ${consumerRoot}`)
    run('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false'], consumerRoot, environment)

    const bin = join(consumerRoot, 'node_modules', ...entry.packageName.split('/'), entry.binPath)
    const version = run(process.execPath, [bin, '--version'], consumerRoot, environment)
    const expected = members.find(member => member.name === entry.packageName)?.version
    if (version !== expected) {
      throw new Error(`installed ${entry.packageName} --version reported ${JSON.stringify(version)}, expected ${String(expected)}`)
    }
    console.log(`release verify-packed-install: installed ${entry.packageName} reports ${version}`)
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true })
  }
}

main()
