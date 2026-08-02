import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const CORE_WEB_OVERLAY = fileURLToPath(new URL('../../cli/config/core-web.cordis.yml', import.meta.url))

describe('core Web profile', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: CORE_WEB_OVERLAY,
      toolsMode: 'native',
    })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('core-web-profile-smoke'),
      meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'core Web profile smoke teardown failed')
  })

  it('boots and executes both tools through the shipped Web composition', async () => {
    const seedPath = join(scaffold.workspaceCwd, 'profile-smoke.txt')
    await writeFile(seedPath, 'CORE_WEB_EDITOR_OK\n')
    const signal = new AbortController().signal
    const bash = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('core-web-bash-smoke'),
      name: 'bash',
      arguments: { command: "printf 'CORE_WEB_BASH_OK\\n'" },
      agent: agentHandle.agent,
    })
    const editor = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('core-web-editor-smoke'),
      name: 'str_replace_editor',
      arguments: { command: 'view', path: seedPath },
      agent: agentHandle.agent,
    })

    const text = (result: typeof bash): string => result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .replaceAll(scaffold.workspaceCwd, '{{cwd}}')
      .trimEnd()

    expect({
      tools: scaffold.ctx.tools.schemas().map(tool => tool.name),
      bash: text(bash),
      editor: text(editor),
    }).toMatchInlineSnapshot(`
      {
        "bash": "CORE_WEB_BASH_OK",
        "editor": "Here's the content of {{cwd}}/profile-smoke.txt with line numbers (which has a total of 2 lines):
           1  CORE_WEB_EDITOR_OK
           2",
        "tools": [
          "bash",
          "str_replace_editor",
          "list_agents",
        ],
      }
    `)

    const entries = [...scaffold.ctx.loader.entries()]
    expect(entries.find(entry => entry.options.id === 'persistent-bash')?.fiber).toBeDefined()
    expect(entries.find(entry => entry.options.id === 'pty-local')?.fiber).toBeDefined()
    expect(entries.find(entry => entry.options.id === 'str-replace-editor')?.fiber).toBeDefined()
  })
})
