/**
 * Pack one release family's whole publish set into a single directory, in
 * publish order, and record that order for the publish step.
 *
 * The pack step is the release boundary: it runs without credentials, produces
 * every tarball from one commit, and hands the publish step exactly those bytes
 * ([rationale](../../.agents/notes/proposed/process/2026-08-10-npm-release-sequences.md)).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { releaseFamily, tarballName, type ReleaseFamily, type ReleaseMember } from './families.ts'

/** Where pack output lands when `--out` is omitted. */
const DEFAULT_OUTPUT = 'dist/npm'

/** Name of the file the publish step reads to learn the upload order. */
export const PUBLISH_ORDER_FILE = 'publish-order.txt'

/**
 * Run a command, inheriting stdio, and fail the process on a non-zero exit.
 * @param command - executable name.
 * @param args - command arguments.
 */
function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

/**
 * List a tarball's members.
 * @param tarball - absolute tarball path.
 * @returns Every path inside the archive.
 */
function tarballFiles(tarball: string): string[] {
  const result = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`tar -tzf ${tarball} exited with ${String(result.status)}:\n${result.stderr}`)
  return result.stdout.split('\n').filter(line => line !== '')
}

/**
 * Pack one member and check what its tarball carries.
 * @param family - the release family being packed.
 * @param member - the member to pack.
 * @param destination - absolute output directory.
 * @returns The tarball filename.
 */
function packMember(family: ReleaseFamily, member: ReleaseMember, destination: string): string {
  run('pnpm', ['--dir', member.directory, 'pack', '--pack-destination', destination])

  const filename = tarballName(member)
  const tarball = join(destination, filename)
  if (!existsSync(tarball)) throw new Error(`${member.name} produced no tarball at ${tarball}`)
  family.validatePayload(member, tarballFiles(tarball))
  return filename
}

/** Pack the family named by `--family` into `--out`. */
function main(): void {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, out: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined) throw new Error('usage: pack.ts --family <dsh|vendor> [--out dist/npm]')

  const family = releaseFamily(values.family)
  const root = process.cwd()
  const destination = resolve(root, values.out ?? DEFAULT_OUTPUT)
  const members = family.publishOrder(family.members(root))
  family.verifyVersions(members)

  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })

  const order: string[] = []
  for (const member of members) order.push(packMember(family, member, destination))
  writeFileSync(join(destination, PUBLISH_ORDER_FILE), `${order.join('\n')}\n`)

  console.log(`release pack: family ${family.id}, ${String(order.length)} tarball(s) in ${values.out ?? DEFAULT_OUTPUT}`)
}

main()
