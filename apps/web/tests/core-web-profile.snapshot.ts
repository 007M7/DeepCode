import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const CORE_WEB_OVERLAY = fileURLToPath(new URL('../../cli/config/core-web.cordis.yml', import.meta.url))

describe('core Web profile', () => {
  let scaffold: WebScaffold

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: CORE_WEB_OVERLAY,
      toolsMode: 'native',
    })
  })

  afterAll(async () => {
    await scaffold?.close()
  })

  it('boots the shipped Web composition with only persistent Bash and the string-replace editor', () => {
    expect(scaffold.ctx.tools.schemas().map(tool => tool.name)).toMatchInlineSnapshot(`
      [
        "bash",
        "str_replace_editor",
      ]
    `)

    const entries = [...scaffold.ctx.loader.entries()]
    expect(entries.find(entry => entry.options.id === 'persistent-bash')?.fiber).toBeDefined()
    expect(entries.find(entry => entry.options.id === 'pty-local')?.fiber).toBeDefined()
    expect(entries.find(entry => entry.options.id === 'str-replace-editor')?.fiber).toBeDefined()
  })
})
