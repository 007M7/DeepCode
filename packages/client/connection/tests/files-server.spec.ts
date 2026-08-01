/** The workspace-file listener's own failure and publication paths. */
import { describe, expect, it } from 'vitest'
import { FILES_PATH } from '@deepseek-ai/dsh-host-apiproxy/api'
import { injectFilesPort, listenForWorkspaceFiles } from '../src/files-server.ts'

describe('workspace-file listener', () => {
  it('answers 400 and reports the failure when the directory lookup throws', async () => {
    const seen: Error[] = []
    const files = await listenForWorkspaceFiles(
      '127.0.0.1', [],
      { cwdFor: () => Promise.reject(new Error('store unavailable')) },
      (error) => { seen.push(error) },
    )
    try {
      // A lookup failure is the host's problem, not a miss: it must not become
      // an unhandled rejection, and it must not be reported as "not found".
      const response = await fetch(`http://127.0.0.1:${String(files.port)}${FILES_PATH}/s-1/a.txt`)
      expect(response.status).toBe(400)
      expect(seen.map(error => error.message)).toEqual(['store unavailable'])
    } finally {
      await files.close()
    }
  })

  it('closes idempotently and stops answering', async () => {
    const files = await listenForWorkspaceFiles(
      '127.0.0.1', [], { cwdFor: async () => undefined }, () => {},
    )
    const origin = `http://127.0.0.1:${String(files.port)}`
    expect((await fetch(`${origin}${FILES_PATH}/s-1/a.txt`)).status).toBe(404)
    await files.close()
    await files.close()
    await expect(fetch(`${origin}${FILES_PATH}/s-1/a.txt`)).rejects.toThrow()
  })
})

describe('injectFilesPort', () => {
  it('publishes the port as the first script in head', () => {
    const html = injectFilesPort('<html><head><title>x</title></head></html>', 4321)
    expect(html).toContain('<head><script>window.__DSH_FILES_PORT__ = 4321</script>')
    // Ahead of anything the shell might read it from.
    expect(html.indexOf('__DSH_FILES_PORT__')).toBeLessThan(html.indexOf('<title>'))
  })
})
