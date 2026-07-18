#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repoRoot = resolve(packageRoot, '../../..')
const viteUrl = process.env.DSH_DESKTOP_VITE_URL ?? 'http://127.0.0.1:5174'

const packageBin = resolve(packageRoot, 'node_modules/.bin')

const vite = spawn(resolve(packageBin, 'vite'), [
  '--host',
  '127.0.0.1',
  '--port',
  '5174',
  // Fail fast instead of silently moving ports: Electron loads the URL below,
  // so a relocated Vite would leave the window pointing at a stale instance.
  '--strictPort',
], {
  cwd: packageRoot,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let electronStarted = false
let electron

const startElectron = () => {
  if (electronStarted) return
  electronStarted = true
  electron = spawn(resolve(packageBin, 'electron'), ['src/main.mjs'], {
    cwd: packageRoot,
    env: { ...process.env, VITE_DEV_SERVER_URL: viteUrl },
    stdio: 'inherit',
  })
  electron.on('exit', (code, signal) => {
    vite.kill('SIGTERM')
    process.exit(code ?? (signal === null ? 0 : 1))
  })
}

const pipeVite = (chunk, stream) => {
  const text = chunk.toString()
  stream.write(text)
  if (text.includes('Local:') || text.includes(viteUrl)) startElectron()
}

vite.stdout.on('data', chunk => { pipeVite(chunk, process.stdout) })
vite.stderr.on('data', chunk => { pipeVite(chunk, process.stderr) })
vite.on('exit', (code, signal) => {
  if (!electronStarted) process.exit(code ?? (signal === null ? 0 : 1))
})

process.on('SIGINT', () => {
  electron?.kill('SIGINT')
  vite.kill('SIGINT')
})
process.on('SIGTERM', () => {
  electron?.kill('SIGTERM')
  vite.kill('SIGTERM')
})
