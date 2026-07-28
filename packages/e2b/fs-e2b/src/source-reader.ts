/** Dependency-free stable-handle bounded reader installed inside E2B. */
export const BOUNDED_READER_SOURCE = String.raw`
/* dsh-e2b-bounded-reader */
const fs = require('node:fs')
const target = process.argv[1]
const maxBytes = Number(process.argv[2])
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
let directory
let descriptor
let response

const openChild = (parent, component, flags) => fs.openSync('/proc/self/fd/' + parent + '/' + component, flags)
const invalidComponent = component => component === '' || component === '.' || component === '..'

try {
  if (typeof target !== 'string' || !target.startsWith('/') || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('bounded reader requires an absolute target and positive byte limit')
  }
  const components = target === '/' ? [] : target.slice(1).split('/')
  if (components.length === 0 || components.some(invalidComponent)) {
    throw new Error('bounded reader received a non-canonical file path')
  }

  directory = fs.openSync('/', directoryFlags)
  for (const component of components.slice(0, -1)) {
    const child = openChild(directory, component, directoryFlags)
    fs.closeSync(directory)
    directory = child
  }
  descriptor = openChild(directory, components.at(-1), fileFlags)

  const info = fs.fstatSync(descriptor)
  if (!info.isFile()) response = { kind: 'not-file' }
  else if (info.size > maxBytes) response = { kind: 'oversize', size: info.size }
  else {
    const chunks = []
    let total = 0
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes - total + 1))
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
    }
    response = total > maxBytes
      ? { kind: 'grew' }
      : { kind: 'ok', data: Buffer.concat(chunks, total).toString('base64') }
  }
} catch (error) {
  response = { kind: 'open-error', message: error instanceof Error ? error.message : String(error) }
} finally {
  for (const openDescriptor of [descriptor, directory]) {
    if (openDescriptor === undefined) continue
    try {
      fs.closeSync(openDescriptor)
    } catch (error) {
      response = { kind: 'open-error', message: error instanceof Error ? error.message : String(error) }
    }
  }
}
process.stdout.write(JSON.stringify(response))
`
