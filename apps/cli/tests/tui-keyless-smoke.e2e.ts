import { createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { packChunkRuns, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { logPath, toHeaderLine } from '../../../packages/session-persistence/session-persistence-jsonl/src/format.ts'
import { runTuiPtySmoke, type TuiPtySmokeOptions } from './pty-harness.ts'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
// `--config` layers an overlay over the shared base, so the default surface
// needs no config argument at all; these are the overlays under test.
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
    { type: 'user/message', seq: 1, time: 1_700_000_000_002, data: createUserMessage({
      content: [{ type: 'text', text: 'persisted prompt' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'step/start', seq: 2, time: 1_700_000_000_003, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 3, time: 1_700_000_000_004, data: { header: { config: { provider: 'tui-scripted', model: 'tui-scripted-model' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 4, time: 1_700_000_000_005, data: {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'persisted answer' }],
        source: {
          kind: 'model',
          ...{ provider: 'tui-scripted', model: 'tui-scripted-model' },
        },
      }),
    }, surfaceOp: 'append' },
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

/** Model-visible startup context from the first request in the workspace's persisted session log. */
interface LoggedRequestContext {
  /** The system prompt string the launcher sends. */
  system: string
  /** The durable skill-catalog message serialized to text. */
  skillCatalog: string
}

async function readLoggedRequestContext(cwd: string): Promise<LoggedRequestContext> {
  const sessionsDir = join(cwd, '.sessions')
  const entries = await readdir(sessionsDir, { recursive: true })
  // A single keyless run writes one session log; the source section is global, so any log carries it.
  const logRelPath = entries.find(name => name.endsWith('.jsonl'))
  if (logRelPath === undefined) throw new Error(`no session log written under ${sessionsDir}`)
  const lines = (await readFile(join(sessionsDir, logRelPath), 'utf8')).split('\n').filter(Boolean)
  let skillCatalog = ''
  for (const line of lines) {
    const event = JSON.parse(line) as SessionEvent
    if (
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'dsh-tool-skill'
    ) {
      skillCatalog = JSON.stringify(event.data.content)
    }
    if (event.type === 'request/header') {
      return {
        system: event.data.header.system ?? '',
        skillCatalog,
      }
    }
  }
  throw new Error(`session log ${logRelPath} has no request/header event`)
}

/**
 * Shared defaults: the keyless key and the dsh bin. Each case supplies either
 * `configArgs: []` (boot the shipped composition, `base.cordis.yml` +
 * `tui.cordis.yml`, with no flags) or `configPath` (an overlay layered over that
 * same base through `--config`).
 */
function smoke(overrides: Partial<TuiPtySmokeOptions> & { label: string }): Promise<string> {
  return runTuiPtySmoke({
    tempDirPrefix: 'dsh-tui-smoke-',
    binScript: dshBinScript,
    tsconfigPath,
    // Telemetry now mounts in the shared base: keep fixture sessions from
    // POSTing to the production endpoint when run outside CI's workflow env.
    env: { DEEPSEEK_API_KEY: 'keyless-tui-no-call', DSH_TELEMETRY_DISABLED: '1' },
    // Artifact CI builds and smokes concurrently on a contended runner.
    ...(process.env.DSH_EXAMPLE_MODE === 'lib' ? { timeoutMs: 60_000 } : {}),
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

describe('dsh TUI keyless smoke (real Loader tree in a PTY)', () => {
  it('boots pi-tui, sweeps the borderless banner in, enters plan mode, and restores the terminal', async () => {
    // With no configured welcome the borderless banner sweeps in left-to-right;
    // the detail line's session id (`main-session-<uuid>`) renders only once
    // the sweep reaches it, so it marks a settled banner.
    const output = await smoke({
      label: 'dsh boot',
      configArgs: [],
      actions: [
        { waitFor: 'main-session-', send: '/plan' },
        { waitFor: '[off|message] — Enter or leave plan mode', send: '\r' },
        { waitFor: 'Plan mode on. Use /plan off to leave.', send: '/exit\r' },
      ],
    })
    expect(output).toContain('DEEPSEEK')
    expect(output).toContain('HARNESS')
    expect(output).toContain('main-session-')
    expect(output).toContain('[off|message] — Enter or leave plan mode')
    expect(output).toContain('Plan mode on. Use /plan off to leave.')
    // Borderless: no box-drawing frame around the banner.
    expect(output).not.toContain('╭')
    expect(output).not.toContain('╮')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('switches models, streams a response, answers a user-question dialog, and exits cleanly', async () => {
    const output = await smoke({
      label: 'dsh conversation',
      tempDirPrefix: 'dsh-tui-conversation-',
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
        { waitFor: 'Plan mode off.', send: 'Confirm the scripted run left plan mode.\r' },
        { waitFor: 'Default mode confirmed.', send: '/status\r' },
        { waitFor: 'Session status', send: '/exit\r' },
      ],
    })
    expect(output).toContain('I need one decision before I continue.')
    expect(output).toContain('Reasoning effort: Max.')
    expect(output).toContain('Plan mode on. Use /plan off to leave.')
    expect(output).toContain('Plan mode off.')
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
    expect(output).toContain('System prompt')
    expect(output).toContain('You are an AI agent powered by the DeepSeek Harness SDK.')
    expect(output).toContain('Registered tools')
    expect(output).toContain('ask_user_question')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('loads a local skill via /skill: and delivers its body to the model as a user turn', async () => {
    // The whole user-only invocation path in one keyless boot: `ctx.get('skills')`
    // resolves in the shipped tree, the client-side `/skill:` command parses,
    // and the local provider admits a model-disabled skill by the omitted
    // `user-invocable` default. The rendered `<skill name="…">` block reaches
    // the model — proven by the scripted adapter echoing the fixture's body
    // marker only when it arrives.
    const output = await smoke({
      label: 'dsh skill',
      tempDirPrefix: 'dsh-tui-skill-',
      configPath: scriptedConfigPath,
      prepare: seedWorkspace({
        skills: {
          'scripted-skill/SKILL.md': [
            '---',
            'name: scripted-skill',
            'description: Keyless PTY proof that the skill command loads a local skill into the conversation.',
            'disable-model-invocation: true',
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
    expect(output).not.toContain('[instructions]')
    expect(output).toContain('Scripted skill body received.')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('adds a watched local skill to live /skill: autocomplete without restarting', async () => {
    const skill = [
      '---',
      'name: hot-added-skill',
      'description: HOT_ADDED_COMPLETION_MARKER',
      '---',
      '',
      'Hot-added body.',
      '',
    ].join('\n')
    const output = await smoke({
      label: 'tui-agent hot-added skill autocomplete',
      tempDirPrefix: 'tui-agent-hot-skill-',
      configPath: scriptedConfigPath,
      actions: [
        {
          waitFor: 'scripted TUI ready.',
          writeFile: {
            path: '.agents/skills/hot-added-skill/SKILL.md',
            content: skill,
          },
          send: '/skill:hot',
        },
        { waitFor: 'HOT_ADDED_COMPLETION_MARKER', send: '\x03/exit\r' },
      ],
    })
    expect(output).toContain('HOT_ADDED_COMPLETION_MARKER')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it.skipIf(process.env.DSH_EXAMPLE_MODE === 'lib')('fuzzy-completes an @file path without reading or submitting the file', async () => {
    const output = await smoke({
      label: 'dsh file autocomplete',
      tempDirPrefix: 'dsh-tui-file-autocomplete-',
      // Source-plane PTY coverage complements the deterministic package-level
      // autocomplete tests. Artifact CI omits this timing-sensitive terminal
      // rendering assertion; built boot is covered by the neighboring cases.
      configArgs: [],
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

  it('applies the personal overlay: config.yaml patches an overlay-inserted row, the invoking directory\'s .env feeds its !!js, and the home .env stays out of the environment', async () => {
    // The whole personal-config chain in one boot, plus the environment layer
    // it deliberately excludes. config.yaml patches the `tui` row — a row the
    // SURFACE OVERLAY inserted, not one the base declares — proving a later
    // patch list reaches a row an earlier one inserted. The single `!!js`
    // expression prefers the PERSONAL variable, so the welcome can only render
    // the project value while the harness home's .env — the credential store
    // of `dsh-credentials-local` — is NOT hoisted into `process.env`; hoisting
    // it would make every stored key read as a read-only launch override on
    // the next run and hand it to every subprocess the agent starts.
    const output = await smoke({
      label: 'dsh personal overlay',
      tempDirPrefix: 'dsh-personal-overlay-',
      binScript: dshBinScript,
      configArgs: [],
      prepare: seedWorkspace({
        workspace: { '.env': 'DSH_PROJECT_WELCOME=PROJECT OVERLAY READY.\n' },
        personal: {
          '.env': 'DSH_PERSONAL_WELCOME=HOME ENV LEAKED.\n',
          'config.yaml': [
            '- id: workspace-context',
            '  disabled: true',
            '- id: tui',
            '  config:',
            "    sessionId: !!js configuredAgentIdentities?.main?.id ?? 'main'",
            '    welcome: !!js process.env.DSH_PERSONAL_WELCOME ?? process.env.DSH_PROJECT_WELCOME',
            '',
          ].join('\n'),
        },
      }),
      actions: [{ waitFor: 'PROJECT OVERLAY READY.', send: '/exit\r' }],
    })
    expect(output).toContain('PROJECT OVERLAY READY.')
    expect(output).not.toContain('HOME ENV LEAKED.')
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

  it('routes the --resume flag into the launcher session-identity slot, failing loud on a missing id', async () => {
    // The flag path end to end: apps/cli parses `--resume missing-session`,
    // provides it as the launcher-owned identity on the boot context, and the
    // resume fails loud — proving the printed hint reaches the app's resume
    // intake with no config key and no environment variable.
    const output = await smoke({
      label: 'dsh resume flag failure',
      tempDirPrefix: 'dsh-resume-flag-',
      binScript: dshBinScript,
      configArgs: ['--resume', 'missing-session'],
      expectedExitCode: 1,
    })
    expect(output).toContain('ui-tui: session "missing-session" failed to start:')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('prints the launcher-owned resume command on exit, naming the booted config', async () => {
    // The exit line is built by apps/cli from this invocation, so it must carry
    // `--config`: a hint that omitted it would resume into the default tree.
    const output = await smoke({
      label: 'dsh goodbye message',
      tempDirPrefix: 'dsh-goodbye-',
      binScript: dshBinScript,
      configPath: scriptedConfigPath,
      actions: [{ waitFor: 'scripted TUI ready.', send: '/exit\r' }],
    })
    expect(output).toMatch(/To resume this session: dsh --resume=main-session-[0-9a-f-]{36} --config/)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('keeps resume working when the personal overlay replaces the whole agent-loop config', async () => {
    // Loader patches replace a targeted `config` key wholesale, so a personal
    // overlay repointing the model route drops every identity key the shipped
    // row declared. Launcher-owned identity makes that unreachable: agent-loop
    // applies the launcher's id over whatever route survives.
    const output = await smoke({
      label: 'dsh overlay keeps resume',
      tempDirPrefix: 'dsh-overlay-resume-',
      binScript: dshBinScript,
      configArgs: [],
      prepare: seedWorkspace({
        personal: {
          'config.yaml': [
            '- id: workspace-context',
            '  disabled: true',
            '- id: agent-loop',
            '  config:',
            '    agents:',
            '      - id: main',
            '        provider: deepseek-official',
            '        model: deepseek-v4-flash',
            '        cwd: !!js process.cwd()',
            '- id: tui',
            '  config:',
            "    sessionId: !!js configuredAgentIdentities?.main?.id ?? 'main'",
            '    welcome: OVERLAY REPLACED THE CONFIG.',
            '',
          ].join('\n'),
        },
      }),
      actions: [{ waitFor: 'OVERLAY REPLACED THE CONFIG.', send: '/exit\r' }],
    })
    expect(output).toMatch(/To resume this session: dsh --resume=main-session-[0-9a-f-]{36}/)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('reports a failing bash command exactly once, as the terminal card exit pill', async () => {
    // The model-facing result ends in `[exit code: 3]`, which the terminal card
    // consumes into its own `[exit 3]` pill. Rendering both would report the same
    // exit twice, so the marker must not survive into the card body.
    const output = await smoke({
      label: 'dsh bash exit pill',
      tempDirPrefix: 'dsh-bash-exit-pill-',
      configPath: scriptedConfigPath,
      actions: [
        ...SELECT_PRO_MODEL,
        {
          waitFor: 'Model selected: tui-scripted/tui-scripted-model-pro.',
          send: 'Run the failing scripted command.\r',
        },
        { waitFor: 'Scripted bash failure observed.', send: '/exit\r' },
      ],
    })
    // The command really ran: its stdout is in the card body.
    expect(output).toContain('SCRIPTED_BASH_FAILED')
    expect(output).toContain('[exit 3]')
    expect(output).not.toContain('[exit code: 3]')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('tells the model its source path and offers the bundled maintenance skills', async () => {
    // The launcher resolves the checkout root three hops up from apps/cli/{src,lib};
    // this test file sits an equal depth under the same root, so the same hop applies.
    // The source-path line is a system-prompt section; the bundled skills reach the
    // model through a durable user message, so each assertion targets its own field.
    const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url))
    let context: LoggedRequestContext = { system: '', skillCatalog: '' }
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
      inspect: async (cwd) => { context = await readLoggedRequestContext(cwd) },
    })
    expect(context.system).toContain(`Your own source code is the checkout at ${sourceRoot}; you can read it there to learn how dsh works and how to extend it.`)
    expect(context.skillCatalog).toContain("- `dsh-customize`: Customize or maintain any dsh source checkout — the one powering the current DSH process, the installed `dsh` command, or a sibling dsh/deepseek-harness clone. Use before any requested action that alters such a checkout's files or git state. Read-only questions that only inspect the checkout do not trigger this. Do not edit the personal staging checkout directly.")
    expect(context.skillCatalog).toContain('- `dsh-upgrade`: Upgrades a source-installed, personally customized DSH checkout to upstream master while preserving local changes and an unchanged rollback worktree. Use when the user asks to update or upgrade DSH.')
    expect(context.skillCatalog).toContain('- `dsh-upstream-customization`: Classifies personal DSH customizations for upstream contribution and, after explicit per-feature approval, rebuilds one on upstream master and opens a draft pull request. Use when the user asks to contribute, publish, or upstream a local DSH change, or asks whether one is worth proposing.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
