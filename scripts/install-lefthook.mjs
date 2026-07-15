#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const git = spawnSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
if (git.status !== 0) process.exit(0)

const isWindows = process.platform === 'win32'
const lefthook = join(process.cwd(), 'node_modules', '.bin', isWindows ? 'lefthook.cmd' : 'lefthook')
if (!existsSync(lefthook)) process.exit(0)

// On Windows the bin shim is a `.cmd` file, and recent Node (CVE-2024-27980)
// refuses to launch `.cmd`/`.bat` via spawn without `shell: true` — it returns
// `EINVAL` with a null status, which would otherwise fail postinstall. Quote
// the path because a shell re-parses the command line and the path may contain
// spaces. POSIX needs no shell: the extensionless shim is directly executable.
const result = isWindows
  ? spawnSync(`"${lefthook}"`, ['install', '--force'], { stdio: 'inherit', shell: true })
  : spawnSync(lefthook, ['install', '--force'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
