#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const git = spawnSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
if (git.status !== 0) process.exit(0)

const lefthook = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'lefthook.cmd' : 'lefthook')
if (!existsSync(lefthook)) process.exit(0)

const result = spawnSync(lefthook, ['install', '--force'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
