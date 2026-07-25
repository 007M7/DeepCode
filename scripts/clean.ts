import { lstat, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const knownOrphanEntries = new Set(['node_modules', 'lib', '.typecheck'])

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function childDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => join(path, entry.name))
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

class RepositoryCleaner {
  constructor(private readonly root: string) {}

  /**
   * Remove generated build state and package directories containing only known residue.
   * @returns Repository-relative paths that were removed.
   */
  async clean(): Promise<string[]> {
    const targets = await this.plan()
    for (const target of targets) await rm(target, { recursive: true, force: true })
    return targets.map(target => repositoryPath(this.root, target))
  }

  private async plan(): Promise<string[]> {
    const targets = new Set<string>()
    const unsafeOrphans: string[] = []

    await this.addIfPresent(targets, join(this.root, '.typecheck'))
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) targets.add(join(this.root, entry.name))
    }

    for (const vendorDirectory of await childDirectories(join(this.root, 'vendor'))) {
      await this.addIfPresent(targets, join(vendorDirectory, 'lib'))
    }
    await this.addIfPresent(targets, join(this.root, 'apps', 'cli', 'lib'))

    for (const groupDirectory of await childDirectories(join(this.root, 'packages'))) {
      for (const packageDirectory of await childDirectories(groupDirectory)) {
        if (await exists(join(packageDirectory, 'package.json'))) {
          await this.addIfPresent(targets, join(packageDirectory, 'lib'))
          continue
        }

        const entries = await readdir(packageDirectory)
        const unknown = entries.filter(entry => !knownOrphanEntries.has(entry) && !entry.endsWith('.tsbuildinfo'))
        if (unknown.length > 0) {
          unsafeOrphans.push(...unknown.map(entry => repositoryPath(this.root, join(packageDirectory, entry))))
        } else {
          targets.add(packageDirectory)
        }
      }
    }

    if (unsafeOrphans.length > 0) {
      throw new Error([
        'clean: refusing to remove package directories without package.json; unknown entries remain:',
        ...unsafeOrphans.sort().map(path => `  ${path}`),
      ].join('\n'))
    }

    return [...targets].sort()
  }

  private async addIfPresent(targets: Set<string>, path: string): Promise<void> {
    if (await exists(path)) targets.add(path)
  }
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    const removed = await new RepositoryCleaner(resolve(dirname(scriptPath), '..')).clean()
    if (removed.length === 0) {
      console.log('clean: already clean')
    } else {
      console.log(`clean: removed ${removed.length} paths`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
