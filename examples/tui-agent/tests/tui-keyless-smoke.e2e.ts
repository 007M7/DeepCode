import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { packChunkRuns, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { logPath, toHeaderLine } from '../../../packages/session-persistence/session-persistence-jsonl/src/format.ts'
import { runTuiPtySmoke, type TuiPtySmokeOptions } from './pty-harness.ts'

const dshBinScript = fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const codeModeConfigPath = fileURLToPath(new URL('../code-mode.cordis.yml', import.meta.url))
const scriptedConfigPath = fileURLToPath(new URL('./fixtures/tui-scripted.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/**
 * Seed the isolated process workspace: ordinary files land in `cwd`, personal
 * files in the Harness home (`.dsh`), and skill bundles under the agents
 * home's `skills/` root — the same trees `$DSH_HOME` /
 * `$DSH_AGENTS_HOME` point the child at.
 */
function seedWorkspace(
  files: {
    workspace?: Record<string, string>
    personal?: Record<string, string>
    skills?: Record<string, string>
  },
): (cwd: string) => Promise<void> {
  return async (cwd) => {
    for (const [name, content] of Object.entries(files.workspace ?? {})) {
      const file = join(cwd, name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
    }
    for (const [name, content] of Object.entries(files.personal ?? {})) {
      const file = join(cwd, '.dsh', name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
    }
    for (const [name, content] of Object.entries(files.skills ?? {})) {
      const file = join(cwd, '.agents', 'skills', name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
    }
  }
}

/** Seed one real plaintext JSONL session for the `/resume` selector and host handoff smoke. */
async function seedResumeSession(cwd: string): Promise<void> {
  const sessionCwd = realpathSync.native(cwd)
  const id = SessionId('resume-target')
  const meta: SessionHeader = { version: 0, id, createdAt: 1_700_000_000_000, cwd: sessionCwd }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1_700_000_000_001, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'user/message', seq: 1, time: 1_700_000_000_002, data: { content: [{ type: 'text', text: 'persisted prompt' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'step/start', seq: 2, time: 1_700_000_000_003, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 3, time: 1_700_000_000_004, data: { header: { config: { provider: 'tui-scripted', model: 'tui-scripted-model' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 4, time: 1_700_000_000_005, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'persisted answer' }], provenance: { provider: 'tui-scripted', model: 'tui-scripted-model' } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 5, time: 1_700_000_000_006, data: { turn: 1, step: 1 } },
    { type: 'session/title', seq: 6, time: 1_700_000_000_007, data: { title: 'Resume selector design', messageSeqs: [1], source: { kind: 'fallback' } } },
    { type: 'todo/write', seq: 7, time: 1_700_000_000_008, data: { todos: [{ content: 'Preserve restored state', status: 'in_progress' }] } },
    { type: 'turn/end', seq: 8, time: 1_700_000_000_009, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const file = logPath(join(cwd, '.sessions'), sessionCwd, id, 'none')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    JSON.stringify(toHeaderLine(meta)),
    ...packChunkRuns(events).map(record => JSON.stringify(record)),
    '',
  ].join('\n'))
}

/** The rendered system prompt from the first `request/header` in the workspace's persisted session log. */
async function readLoggedSystemPrompt(cwd: string): Promise<string> {
  const sessionsDir = join(cwd, '.sessions')
  const entries = await readdir(sessionsDir, { recursive: true })
  // A single keyless run writes one session log; the source section is global, so any log carries it.
  const logRelPath = entries.find(name => name.endsWith('.jsonl'))
  if (logRelPath === undefined) throw new Error(`no session log written under ${sessionsDir}`)
  const lines = (await readFile(join(sessionsDir, logRelPath), 'utf8')).split('\n').filter(Boolean)
  for (const line of lines) {
    const event = JSON.parse(line) as { type: string; data: { header?: { system?: string } } }
    if (event.type === 'request/header') return event.data.header?.system ?? ''
  }
  throw new Error(`session log ${logRelPath} has no request/header event`)
}

/** Shared defaults: the keyless key, the dsh bin, and the live cordis.yml (passed as the positional config). */
function smoke(overrides: Partial<TuiPtySmokeOptions> & { label: string }): Promise<string> {
  return runTuiPtySmoke({
    tempDirPrefix: 'tui-agent-smoke-',
    binScript: dshBinScript,
    configPath,
    tsconfigPath,
    env: { DEEPSEEK_API_KEY: 'keyless-tui-no-call' },
    ...overrides,
  })
}

// The scripted conversation switches to the pro model first: the scripted
// adapter proves routing + prompt variables by rejecting tool-ful calls on any
// other route (see fixtures/tui-scripted-llm.ts).
const SELECT_PRO_MODEL = [
  { waitFor: 'scripted TUI ready.', send: '/model\r' },
  { waitFor: 'Select model', send: '\x1b[B\x1b[Z\r' },
] as const

describe('tui-agent keyless smoke (real Loader tree in a PTY)', () => {
  it('boots pi-tui, sweeps the borderless banner in, enters plan mode, and restores the terminal', async () => {
    // With no configured welcome the borderless banner sweeps in left-to-right;
    // the detail line's session id (`main-session-<uuid>`) renders only once
    // the sweep reaches it, so it marks a settled banner.
    const output = await smoke({
      label: 'tui-agent boot',
      actions: [
        { waitFor: 'main-session-', send: '/plan' },
        { waitFor: '[off|message] — Enter or leave plan mode', send: '\r' },
        { waitFor: 'Entering plan mode (applies from the next step). Use /plan off to leave.', send: '/exit\r' },
      ],
    })
    expect(output).toContain('DEEPSEEK')
    expect(output).toContain('HARNESS')
    expect(output).toContain('main-session-')
    expect(output).toContain('[off|message] — Enter or leave plan mode')
    expect(output).toContain('Entering plan mode (applies from the next step). Use /plan off to leave.')
    // Borderless: no box-drawing frame around the banner.
    expect(output).not.toContain('╭')
    expect(output).not.toContain('╮')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('switches models, streams a response, answers a user-question dialog, and exits cleanly', async () => {
    const output = await smoke({
      label: 'tui-agent conversation',
      tempDirPrefix: 'tui-agent-conversation-',
      configPath: scriptedConfigPath,
      actions: [
        ...SELECT_PRO_MODEL,
        { waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.', send: '/plan exercise the TUI\r' },
        // The question text first appears in the streamed tool-call card. Wait
        // for the dialog's input legend so Enter cannot arrive before it owns
        // terminal input when pre-dispatch policy yields.
        { waitFor: 'Tab custom answer • ↑/↓ navigate • Enter submit • Esc interrupt', send: '\r' },
        { waitFor: 'Decision received. Scripted TUI run complete.', send: '' },
        // Session title: the first user message drives the first-message-llm
        // provider's tool-less title call; the scripted adapter answers it, the
        // accepted title lands in the log, and the TUI renders the terminal
        // window title as `<session title> — <configured title>` via OSC 0.
        // Gating /status on it keeps the assertion race-free; the diagnostics
        // card is then exercised through the same real Loader/PTY composition.
        { waitFor: 'scripted session title — DeepSeek Harness', send: '/plan off\r' },
        { waitFor: 'Leaving plan mode (applies from the next step).', send: 'Confirm the scripted run left plan mode.\r' },
        { waitFor: 'Default mode confirmed.', send: '/status\r' },
        { waitFor: 'Session status', send: '/exit\r' },
      ],
    })
    expect(output).toContain('I need one decision before I continue.')
    expect(output).toContain('Reasoning effort: Max.')
    expect(output).toContain('Entering plan mode (applies from the next step). Use /plan off to leave.')
    expect(output).toContain('Leaving plan mode (applies from the next step).')
    expect(output).toContain('Default mode confirmed.')
    expect(output).toContain(String.raw`\x1b]2;MODEL_CONTROLLED\x07`)
    expect(output).toContain(String.raw`\x1b[999CMODEL_CURSOR`)
    expect(output).toContain(String.raw`\x9b31mMODEL_C1`)
    expect(output).not.toContain('\u001B]2;MODEL_CONTROLLED\u0007')
    expect(output).not.toContain('\u001B[999CMODEL_CURSOR')
    expect(output).not.toContain('\u009B31mMODEL_C1')
    expect(output).toContain('Safe')
    expect(output).toContain('\u001B]0;scripted session title — DeepSeek Harness\u0007')
    expect(output).toContain('Session status')
    expect(output).toContain('Title')
    expect(output).toContain('scripted session title')
    expect(output).toContain('Model')
    expect(output).toContain('tui-scripted/tui-scripted-model-pro')
    expect(output).toContain('KV cache')
    expect(output).toContain('Context')
    expect(output).toContain('128,000')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('loads a local skill via /skill: and delivers its body to the model as a user turn', async () => {
    // The whole manual-invocation path in one keyless boot: `ctx.get('skills')`
    // resolves in the shipped tree, the client-side `/skill:` command parses,
    // the local provider loads `scripted-skill` from the agents home, and the
    // rendered `<skill name="…">` block reaches the model — proven by the
    // scripted adapter echoing the fixture's body marker only when it arrives.
    const output = await smoke({
      label: 'tui-agent skill',
      tempDirPrefix: 'tui-agent-skill-',
      configPath: scriptedConfigPath,
      prepare: seedWorkspace({
        skills: {
          'scripted-skill/SKILL.md': [
            '---',
            'name: scripted-skill',
            'description: Keyless PTY proof that the skill command loads a local skill into the conversation.',
            '---',
            '',
            'SCRIPTED SKILL BODY MARKER',
            '',
          ].join('\n'),
        },
      }),
      actions: [
        ...SELECT_PRO_MODEL,
        { waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.', send: '/skill:scripted-skill\r' },
        { waitFor: 'Scripted skill body received.', send: '/exit\r' },
      ],
    })
    expect(output).toContain('Scripted skill body received.')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('fuzzy-completes an @file path without reading or submitting the file', async () => {
    const output = await smoke({
      label: 'tui-agent file autocomplete',
      tempDirPrefix: 'tui-agent-file-autocomplete-',
      prepare: seedWorkspace({
        workspace: {
          'src/terminal-special-case.ts': 'export const marker = true\n',
          'src/other.ts': 'export const other = true\n',
        },
      }),
      actions: [
        { waitFor: 'main-session-', send: '@tsc' },
        { waitFor: 'File · terminal-special-case.t', send: '\t' },
        { waitFor: '@src/terminal-special-case.ts', send: '\x03/exit\r' },
      ],
    })
    expect(output).toContain('File · terminal-special-case.t')
    expect(output).toContain('@src/terminal-special-case.ts')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('boots the Code Mode overlay tree, renders its banner, and exits cleanly', async () => {
    // The overlay's only keyless composition proof: the include+patch tree,
    // worker code runtime, and one-tool registry all mount before the banner.
    const output = await smoke({
      label: 'tui-agent code mode',
      tempDirPrefix: 'tui-agent-code-mode-',
      configPath: codeModeConfigPath,
      actions: [{ waitFor: 'TUI Code Mode ready.', send: '/exit\r' }],
    })
    expect(output).toContain('TUI Code Mode ready.')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

})

describe('dsh CLI keyless smoke (apps/cli through the same PTY)', () => {
  it('exec-replaces the TUI for /resume and restores the same session state', async () => {
    const output = await smoke({
      label: 'dsh in-place resume',
      tempDirPrefix: 'dsh-in-place-resume-',
      binScript: dshBinScript,
      configPath: scriptedConfigPath,
      prepare: seedResumeSession,
      actions: [
        { waitFor: 'scripted TUI ready.', send: '/resume\r' },
        { waitFor: 'Resume selector design', send: 'Resume selector design' },
        { waitFor: '⌕ Resume selector design', send: '\r' },
        { waitFor: 'Preserve restored state', send: '/exit\r' },
      ],
    })
    const released = output.indexOf('\u001B[?2004l')
    const restored = output.indexOf('Resume selector design — DeepSeek Harness')
    expect(released).toBeGreaterThanOrEqual(0)
    expect(restored).toBeGreaterThan(released)
    expect(output).toContain('Preserve restored state')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('boots the shipped default config with no arguments and no personal overlay', async () => {
    const output = await smoke({
      label: 'dsh default boot',
      tempDirPrefix: 'dsh-default-boot-',
      binScript: dshBinScript,
      configArgs: [],
      actions: [{ waitFor: 'main-session-', send: '/exit\r' }],
    })
    expect(output).toContain('DEEPSEEK')
    expect(output).toContain('main-session-')
    expect(output).not.toContain('╭')
    expect(output).not.toContain('╮')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('applies the personal overlay: config.yaml patches the tree and .env feeds its !!js', async () => {
    // The whole personal-config chain in one boot: the personal .env supplies
    // the variable, config.yaml patches the tui-agent entry with a `!!js`
    // reference to it, and the banner renders the patched welcome verbatim.
    const output = await smoke({
      label: 'dsh personal overlay',
      tempDirPrefix: 'dsh-personal-overlay-',
      binScript: dshBinScript,
      configArgs: [],
      prepare: seedWorkspace({
        personal: {
          '.env': 'DSH_PERSONAL_WELCOME=PERSONAL OVERLAY READY.\n',
          'config.yaml': [
            '- id: tui-agent',
            "  name: '@deepseek-ai/dsh-tui-demo'",
            '  config:',
            '    provider: deepseek',
            '    model: deepseek-v4-flash',
            '    workspaceContext: false',
            '    welcome: !!js process.env.DSH_PERSONAL_WELCOME',
            '',
          ].join('\n'),
        },
      }),
      actions: [{ waitFor: 'PERSONAL OVERLAY READY.', send: '/exit\r' }],
    })
    expect(output).toContain('PERSONAL OVERLAY READY.')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('fails loud instead of booting when the personal config.yaml is invalid', async () => {
    const output = await smoke({
      label: 'dsh invalid personal config',
      tempDirPrefix: 'dsh-invalid-personal-',
      binScript: dshBinScript,
      configArgs: [],
      prepare: seedWorkspace({ personal: { 'config.yaml': 'id: not-a-list\n' } }),
      expectedExitCode: 1,
    })
    expect(output).toContain('must be a top-level YAML array of loader patch entries')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('routes the --resume flag into the config resume intake, failing loud on a missing id', async () => {
    // The flag path end to end: apps/cli parses `--resume missing-session` and
    // provides the id on the boot context, the shipped config's `!!js` reads it
    // as a bare identifier, and the resume fails loud — proving the printed
    // `dsh --resume <id>` hint reaches the config resume intake with no env var.
    const output = await smoke({
      label: 'dsh resume flag failure',
      tempDirPrefix: 'dsh-resume-flag-',
      binScript: dshBinScript,
      configArgs: ['--resume', 'missing-session'],
      expectedExitCode: 1,
    })
    expect(output).toContain('ui-tui: session "missing-session" failed to start:')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('tells the model where its own source lives, in the system prompt it sends', async () => {
    // The launcher resolves the checkout root three hops up from apps/cli/{src,lib};
    // this test file sits an equal depth under the same root, so the same hop applies.
    const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url))
    let loggedSystem = ''
    await smoke({
      label: 'dsh source-path prompt',
      tempDirPrefix: 'dsh-source-path-',
      binScript: dshBinScript,
      configPath: scriptedConfigPath,
      actions: [
        ...SELECT_PRO_MODEL,
        { waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.', send: 'exercise the TUI\r' },
        { waitFor: 'How should the scripted run proceed?', send: '\r' },
        { waitFor: 'Decision received. Scripted TUI run complete.', send: '/exit\r' },
      ],
      inspect: async (cwd) => { loggedSystem = await readLoggedSystemPrompt(cwd) },
    })
    expect(loggedSystem).toContain(`Your own source code is the checkout at ${sourceRoot}; you can read it there to learn how dsh works and how to extend it.`)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
