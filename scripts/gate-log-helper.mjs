#!/usr/bin/env node
/** Pin the repository and each log-path component before creating or operating on private logs. */

import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'

const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const LOG_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.log$/

function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

async function readRequest() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_REQUEST_BYTES) throw new Error('request exceeds the gate-log helper limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function assertInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`)
  }
}

function assertLogName(name) {
  if (typeof name !== 'string' || !LOG_NAME.test(name)) {
    throw new Error(`invalid gate-log filename ${JSON.stringify(name)}`)
  }
}

function assertRequest(request) {
  if (typeof request !== 'object' || request === null) throw new Error('gate-log request must be an object')
  switch (request.operation) {
    case 'write':
      assertLogName(request.filename)
      assertInteger(request.retention, 'retention', 1)
      if (typeof request.content !== 'string') throw new Error('gate-log content must be a string')
      return
    case 'prune':
      assertInteger(request.retain, 'retain', 0)
      return
    case 'clean':
      return
    default:
      throw new Error(`unsupported gate-log operation ${JSON.stringify(request.operation)}`)
  }
}

function assertIdentity(value, label) {
  if (
    typeof value !== 'object'
    || value === null
    || typeof value.dev !== 'string'
    || typeof value.ino !== 'string'
  ) {
    throw new Error(`missing expected ${label} identity`)
  }
}

function identityOf(metadata) {
  return { dev: String(metadata.dev), ino: String(metadata.ino) }
}

function sameIdentity(metadata, expected) {
  return String(metadata.dev) === expected.dev && String(metadata.ino) === expected.ino
}

async function assertPinnedRepository(repository) {
  if (
    typeof repository !== 'object'
    || repository === null
    || typeof repository.root !== 'string'
    || !isAbsolute(repository.root)
    || typeof repository.relative !== 'string'
    || repository.relative === ''
    || repository.relative === '..'
    || repository.relative.startsWith(`..${sep}`)
    || isAbsolute(repository.relative)
  ) {
    throw new Error('invalid repository-relative gate-log path')
  }
  assertIdentity(repository.identity, 'repository')
  const names = repository.relative.split(sep)
  if (!Array.isArray(repository.components) || repository.components.length !== names.length) {
    throw new Error('invalid gate-log path-component plan')
  }
  for (let index = 0; index < names.length; index += 1) {
    const component = repository.components[index]
    if (
      typeof component !== 'object'
      || component === null
      || component.name !== names[index]
      || !('identity' in component)
    ) {
      throw new Error('invalid gate-log path-component plan')
    }
    if (component.identity !== null) assertIdentity(component.identity, `path component ${component.name}`)
  }
  const pinnedMetadata = await stat('.', { bigint: true })
  if (!pinnedMetadata.isDirectory() || !sameIdentity(pinnedMetadata, repository.identity)) {
    throw new Error('gate-log repository identity changed before the helper started')
  }
  const rootMetadata = await lstat(repository.root, { bigint: true })
  if (
    !rootMetadata.isDirectory()
    || rootMetadata.isSymbolicLink()
    || !sameIdentity(rootMetadata, repository.identity)
  ) {
    throw new Error('gate-log repository root is not a real directory')
  }
  return repository.components
}

async function enterLogDirectory(components, create) {
  const traversed = []
  for (const component of components) {
    if (component.name === '' || component.name === '.' || component.name === '..') {
      throw new Error(`invalid gate-log path component ${JSON.stringify(component.name)}`)
    }
    traversed.push(component.name)
    let componentMetadata
    let created = false
    try {
      componentMetadata = await lstat(component.name, { bigint: true })
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      if (component.identity !== null) {
        throw new Error(`gate-log path component disappeared after validation: ${traversed.join('/')}`)
      }
      if (!create) return undefined
      try {
        await mkdir(component.name, { mode: 0o700 })
      } catch (mkdirError) {
        if (errorCode(mkdirError) === 'EEXIST') {
          throw new Error(`gate-log path component appeared after validation: ${traversed.join('/')}`)
        }
        throw mkdirError
      }
      componentMetadata = await lstat(component.name, { bigint: true })
      created = true
    }
    if (component.identity === null && !created) {
      throw new Error(`gate-log path component appeared after validation: ${traversed.join('/')}`)
    }
    if (component.identity !== null && !sameIdentity(componentMetadata, component.identity)) {
      throw new Error(`gate-log path component identity changed after validation: ${traversed.join('/')}`)
    }
    const shown = traversed.join('/')
    if (!componentMetadata.isDirectory() || componentMetadata.isSymbolicLink()) {
      throw new Error(`gate-log path component is not a real directory: ${shown}`)
    }
    const expected = component.identity ?? identityOf(componentMetadata)
    process.chdir(component.name)
    const pinnedMetadata = await stat('.', { bigint: true })
    if (!pinnedMetadata.isDirectory() || !sameIdentity(pinnedMetadata, expected)) {
      throw new Error(`gate-log path component identity changed before pinning: ${shown}`)
    }
  }
  await chmod('.', 0o700)
  return identityOf(await stat('.', { bigint: true }))
}

async function removeOldLogs(retain, newest) {
  assertInteger(retain, 'retain', 0)
  const entries = await readdir('.', { withFileTypes: true })
  const logs = []
  for (const entry of entries) {
    if (!entry.isFile() || !LOG_NAME.test(entry.name)) continue
    let metadata
    try {
      metadata = await lstat(entry.name, { bigint: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue
    logs.push({ name: entry.name, mtimeNs: metadata.mtimeNs })
  }
  logs.sort((left, right) => {
    if (left.name === newest) return 1
    if (right.name === newest) return -1
    if (left.mtimeNs < right.mtimeNs) return -1
    if (left.mtimeNs > right.mtimeNs) return 1
    return left.name.localeCompare(right.name)
  })
  const removed = []
  for (const entry of logs.slice(0, Math.max(0, logs.length - retain))) {
    try {
      await unlink(entry.name)
      removed.push(entry.name)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
  return removed
}

async function writeLog(request) {
  assertLogName(request.filename)
  assertInteger(request.retention, 'retention', 1)
  if (typeof request.content !== 'string') throw new Error('gate-log content must be a string')
  const handle = await open(
    request.filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(request.content, 'utf8')
    await handle.chmod(0o600)
  } finally {
    await handle.close()
  }
  const removed = await removeOldLogs(request.retention, request.filename)
  return { filename: request.filename, removed }
}

async function main() {
  const request = await readRequest()
  assertRequest(request)
  const components = await assertPinnedRepository(request.repository)
  const directory = await enterLogDirectory(components, request.operation === 'write')
  if (directory === undefined) return { removed: [] }
  switch (request.operation) {
    case 'write': {
      const result = await writeLog(request)
      return { ...result, directory }
    }
    case 'prune':
      return { directory, removed: await removeOldLogs(request.retain) }
    case 'clean':
      return { directory, removed: await removeOldLogs(0) }
    default:
      throw new Error(`unsupported gate-log operation ${JSON.stringify(request.operation)}`)
  }
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`)
} catch (error) {
  process.stderr.write(`gate-log-helper: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
