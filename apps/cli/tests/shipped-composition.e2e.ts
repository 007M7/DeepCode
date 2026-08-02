import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { COMPOSITION_REPLY_TEXT } from './fixtures/composition-echo-llm.ts'
import { COMPOSITION_SETTLED_MARKER } from './fixtures/composition-settled.ts'
import { runTuiPtySmoke } from './pty-harness.ts'
import { acknowledgeTuiFirstRunWelcome } from '../src/tui-onboarding/tui-first-run-welcome.ts'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const PERMISSION_SUMMARY = 'current preset workspace-write (available: read-only, workspace-write, danger-full-access)'
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
  'list_agents',
  'ralph',
  'read',
  'send_message',
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
 * `glob` and `grep` come from `dsh-tool-fs-search`, which spawns the PACKAGED
 * ripgrep binary (`@vscode/ripgrep`) through the subprocess seam, so the pair
 * is always present on every host — asserted as fixed members, not a host
 * dependency.
 */
const RIPGREP_TOOLS = ['glob', 'grep']

/** The assembled request header the smoke asserts on. */
interface LoggedHeader {
  /** Assembled tool names, sorted. */
  names: string[]
  /** `bash`'s assembled parameter properties; the escalation pair is present only under a confining executor. */
  bashArguments: Record<string, unknown>
  /** Initial permission facts pinned by the shipped composition. */
  permissionEvents: Array<[string, unknown]>
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
  const events = (await readFile(join(sessionsDir, logRelPath), 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as SessionEvent)
  const header = events.find(event => event.type === 'request/header')
  if (header === undefined || header.type !== 'request/header') {
    throw new Error(`session log ${logRelPath} has no request/header event`)
  }
  const tools = header.data.header.tools ?? []
  const bash = tools.find(schema => schema.name === 'bash')
  return {
    names: tools.map(schema => schema.name).sort(),
    bashArguments: (bash?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {},
    permissionEvents: events.flatMap(event =>
      event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy'
        ? [[event.type, event.data] as [string, unknown]]
        : []),
  }
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
      prepare: cwd => acknowledgeTuiFirstRunWelcome(join(cwd, '.dsh')),
      // Artifact CI builds and smokes concurrently on a contended runner.
      ...(process.env.DSH_EXAMPLE_MODE === 'lib' ? { timeoutMs: 60_000 } : {}),
      actions: [
        { waitFor: COMPOSITION_SETTLED_MARKER, send: '/permission\r' },
        { waitFor: PERMISSION_SUMMARY, send: 'Describe the shipped composition.\r' },
        { waitFor: COMPOSITION_REPLY_TEXT, send: '/exit\r' },
      ],
      inspect: async (cwd) => { observed = await loggedHeader(cwd) },
    })
    expect(output).toContain(COMPOSITION_REPLY_TEXT)
    expect(output).toContain(PERMISSION_SUMMARY)
    expect(observed?.names.filter(name => !RIPGREP_TOOLS.includes(name))).toEqual(EXPECTED_TUI_TOOLS)
    // The packaged ripgrep binary ships with the dependency, so the pair is a
    // fixed roster member on every host.
    expect(observed?.names.filter(name => RIPGREP_TOOLS.includes(name))).toEqual(RIPGREP_TOOLS)
    expect(observed?.bashArguments).toHaveProperty('sandbox_permissions')
    expect(observed?.bashArguments).toHaveProperty('justification')
    expect(observed?.permissionEvents).toEqual([
      ['permission/preset', { preset: 'workspace-write' }],
      ['sandbox/mode', { mode: 'workspace-write' }],
      ['approval/policy', { policy: 'ask' }],
    ])
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
