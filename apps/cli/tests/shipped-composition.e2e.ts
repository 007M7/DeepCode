import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { COMPOSITION_REPLY_TEXT } from './fixtures/composition-echo-llm.ts'
import { COMPOSITION_SETTLED_MARKER } from './fixtures/composition-settled.ts'
import { runTuiPtySmoke } from './pty-harness.ts'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
// An overlay over the shipped tree, so the catalog under test is the one
// `base.cordis.yml` + `tui.cordis.yml` assemble; the tail only swaps the model
// and redirects session artifacts.
const keylessTail = fileURLToPath(new URL('./fixtures/composition-keyless-tail.cordis.yml', import.meta.url))

/**
 * The catalog the shipped `dsh` TUI puts in front of the model, as the loop
 * logged it, minus the ripgrep-dependent pair below.
 * The absences are the composition's security decisions, not incidental gaps:
 * the `cordis_*` toolset executes model-written JavaScript that no sandbox row
 * confines, `web_fetch` chooses its own request target, and `mcp_*` servers
 * spawn outside `ctx.bash`. The composition Agent Note owns the rationale and
 * its sources.
 */
const EXPECTED_TUI_TOOLS = [
  'ask_user_question',
  'bash',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'ralph',
  'read',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'session_search',
  'session_trace',
  'skill',
  'str_replace_editor',
  'subagent',
  'subagent_fork',
  'task_kill',
  'task_list',
  'task_output',
  'todo_write',
  'update_goal',
  'web_search',
  'workflow',
  'write',
]

/**
 * `glob` and `grep` come from `dsh-tool-fs-search`, which probes `command -v rg`
 * through the mounted bash executor at load and registers neither tool when
 * ripgrep is absent. That is a host dependency, not a composition decision, so the
 * pair is asserted separately — present together or absent together.
 */
const RIPGREP_TOOLS = ['glob', 'grep']

/** The assembled request header the smoke asserts on. */
interface LoggedHeader {
  /** Assembled tool names, sorted. */
  names: string[]
  /** `bash`'s assembled parameter properties; the escalation pair is present only under a confining executor. */
  bashArguments: Record<string, unknown>
}

/**
 * Read the request header the loop assembled for its first request from the
 * session log the smoke's workspace persisted — the model-visible composition
 * itself, not a registry projection taken beside it.
 * @param cwd - the smoke's temporary workspace.
 * @returns the assembled catalog, system prompt, and `bash` argument shape.
 */
async function loggedHeader(cwd: string): Promise<LoggedHeader> {
  const sessionsDir = join(cwd, '.sessions')
  const entries = await readdir(sessionsDir, { recursive: true })
  // A single keyless run writes one session log.
  const logRelPath = entries.find(name => name.endsWith('.jsonl'))
  if (logRelPath === undefined) throw new Error(`no session log written under ${sessionsDir}`)
  const lines = (await readFile(join(sessionsDir, logRelPath), 'utf8')).split('\n').filter(Boolean)
  for (const line of lines) {
    const event = JSON.parse(line) as SessionEvent
    if (event.type !== 'request/header') continue
    const tools = event.data.header.tools ?? []
    const bash = tools.find(schema => schema.name === 'bash')
    return {
      names: tools.map(schema => schema.name).sort(),
      bashArguments: (bash?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {},
    }
  }
  throw new Error(`session log ${logRelPath} has no request/header event`)
}

describe('shipped dsh composition (real Loader tree in a PTY)', () => {
  it('assembles exactly the shipped TUI catalog', async () => {
    let observed: LoggedHeader | undefined
    const output = await runTuiPtySmoke({
      label: 'dsh shipped composition',
      tempDirPrefix: 'dsh-shipped-tui-',
      binScript: dshBinScript,
      tsconfigPath,
      configPath: keylessTail,
      env: { DEEPSEEK_API_KEY: 'keyless-composition-no-call', DSH_TELEMETRY_DISABLED: '1' },
      // Artifact CI builds and smokes concurrently on a contended runner.
      ...(process.env.DSH_EXAMPLE_MODE === 'lib' ? { timeoutMs: 60_000 } : {}),
      actions: [
        { waitFor: COMPOSITION_SETTLED_MARKER, send: 'Describe the shipped composition.\r' },
        { waitFor: COMPOSITION_REPLY_TEXT, send: '/exit\r' },
      ],
      inspect: async (cwd) => { observed = await loggedHeader(cwd) },
    })
    expect(output).toContain(COMPOSITION_REPLY_TEXT)
    expect(observed?.names.filter(name => !RIPGREP_TOOLS.includes(name))).toEqual(EXPECTED_TUI_TOOLS)
    expect([[], RIPGREP_TOOLS]).toContainEqual(observed?.names.filter(name => RIPGREP_TOOLS.includes(name)))
    // The TUI mounts the unrestricted local executors, so `tool-bash` emits no
    // escalation pair. Pinning its absence keeps a later sandbox change from
    // arriving here unannounced.
    expect(Object.keys(observed?.bashArguments ?? {})).not.toContain('sandbox_permissions')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
