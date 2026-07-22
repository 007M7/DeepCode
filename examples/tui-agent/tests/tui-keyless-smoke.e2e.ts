import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../packages/examples/tui-demo/src/bin.ts', import.meta.url))
const dshBinScript = fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const codeModeConfigPath = fileURLToPath(new URL('../code-mode.cordis.yml', import.meta.url))
const scriptedConfigPath = fileURLToPath(new URL('./fixtures/tui-scripted.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

const PTY_DRIVER = String.raw`
import errno, json, os, pty, select, signal, sys, time
node, launch_args_json, launch_env_json, cwd, resume_session_id, scenario, boot_marker = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
env.update({
    "COLUMNS": "100",
    "LINES": "30",
})
# Deterministic banner: a developer shell's COLORTERM=truecolor would switch the
# banner to the per-letter gradient (one SGR per letter), breaking the literal
# DEEPSEEK assertions. The gradient path has its own unit and snapshot coverage.
env.pop("COLORTERM", None)
if resume_session_id:
    env["RESUME_SESSION_ID"] = resume_session_id
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(launch_args_json)], env)

output = bytearray()
answered_question = False
opened_selector = False
selected_model = False
sent_prompt = False
sent_exit = False
deadline = time.monotonic() + 25
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            output.extend(chunk)
    if scenario == "conversation" and not opened_selector and b"scripted TUI ready." in output:
        os.write(fd, b"/model\r")
        opened_selector = True
    if scenario == "conversation" and opened_selector and not selected_model and b"Select model" in output:
        os.write(fd, b"\x1b[B\r")
        selected_model = True
    if scenario == "conversation" and selected_model and not sent_prompt and b"Model selected: tui-scripted/tui-scripted-model-pro." in output:
        os.write(fd, b"exercise the TUI\r")
        sent_prompt = True
    if scenario == "conversation" and sent_prompt and not answered_question and b"How should the scripted run proceed?" in output:
        os.write(fd, b"\r")
        answered_question = True
    if scenario == "conversation" and answered_question and not sent_exit and b"Decision received. Scripted TUI run complete." in output:
        os.write(fd, b"/exit\r")
        sent_exit = True
    if scenario == "skill" and not selected_model and b"scripted TUI ready." in output:
        os.write(fd, b"/model tui-scripted/tui-scripted-model-pro\r")
        selected_model = True
    if scenario == "skill" and selected_model and not sent_prompt and b"Model selected: tui-scripted/tui-scripted-model-pro." in output:
        os.write(fd, b"/skill:scripted-skill\r")
        sent_prompt = True
    if scenario == "skill" and sent_prompt and not sent_exit and b"Scripted skill body received." in output:
        os.write(fd, b"/exit\r")
        sent_exit = True
    if scenario == "boot" and not sent_exit and boot_marker.encode() in output:
        os.write(fd, b"/exit\r")
        sent_exit = True
    waited, candidate = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = candidate
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
if scenario == "resume-failure":
    if b'ui-tui: session "missing-session" failed to start:' not in output:
        sys.stderr.write("TUI did not render the startup failure before timeout\n")
        sys.exit(126)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 1:
        sys.stderr.write("TUI startup failure did not exit with status 1\n")
        sys.exit(127)
elif scenario == "conversation":
    if not sent_prompt:
        sys.stderr.write("TUI did not render the scripted welcome marker before timeout\n")
        sys.exit(128)
    if not answered_question:
        sys.stderr.write("TUI did not render the user-question dialog before timeout\n")
        sys.exit(129)
    if not sent_exit:
        sys.stderr.write("TUI did not finish the scripted tool round-trip before timeout\n")
        sys.exit(130)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        sys.stderr.write("TUI scripted conversation did not exit cleanly\n")
        sys.exit(131)
elif scenario == "skill":
    if not sent_prompt:
        sys.stderr.write("TUI did not render the scripted welcome marker before typing /skill:\n")
        sys.exit(132)
    if b"Scripted skill body received." not in output:
        sys.stderr.write("TUI did not deliver the loaded skill body to the model before timeout\n")
        sys.exit(133)
    if not sent_exit:
        sys.stderr.write("TUI did not reach idle to accept /exit after the skill turn\n")
        sys.exit(134)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        sys.stderr.write("TUI skill scenario did not exit cleanly\n")
        sys.exit(135)
else:
    if not sent_exit:
        sys.stderr.write("TUI did not render its welcome marker before timeout\n")
        sys.exit(124)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        sys.stderr.write("TUI child did not exit cleanly\n")
        sys.exit(125)
`

interface TuiLoaderSmokeOptions {
  config?: string
  resumeSessionId?: string
  scenario?: 'boot' | 'conversation' | 'resume-failure' | 'skill'
  /** Welcome text the boot scenario waits for before sending `/exit`. */
  bootMarker?: string
  /** Bin to boot; defaults to the tui-demo bin (the dsh CLI tests override). */
  srcBin?: string
  /** Argument vector for the bin; defaults to `[config]`. */
  configArgs?: string[]
  /** Files written into the isolated Harness home (`$DSH_HOME`) before launch. */
  personalFiles?: Record<string, string>
  /** Skill bundles written under the isolated agents home (`.agents/skills/`) before launch, keyed by path below that root. */
  skillFiles?: Record<string, string>
  /** Runs against the workspace `cwd` after a clean exit, before it is removed. */
  inspect?: (cwd: string) => Promise<void>
}

async function runTuiLoaderSmoke(options: TuiLoaderSmokeOptions = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'tui-agent-smoke-'))
  try {
    // Personal config is always isolated from the developer's real ~/.dsh;
    // a test opts into an overlay by supplying files under the Harness home.
    const dshHome = join(cwd, '.dsh')
    for (const [name, content] of Object.entries(options.personalFiles ?? {})) {
      await mkdir(dshHome, { recursive: true })
      await writeFile(join(dshHome, name), content)
    }
    // The child chdirs to this cwd and the scripted config roots fs-local here,
    // so a skill dropped under DSH_AGENTS_HOME's `skills/` root is discoverable
    // and its body readable through the same tree the model-facing stack uses.
    const skillsRoot = join(cwd, '.agents', 'skills')
    for (const [name, content] of Object.entries(options.skillFiles ?? {})) {
      const file = join(skillsRoot, name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
    }
    const launch = resolveExampleLaunch({
      srcBin: options.srcBin ?? binScript,
      configArgs: options.configArgs ?? [options.config ?? configPath],
      tsconfigPath,
      exposeInternals: true,
      env: {
        DEEPSEEK_API_KEY: 'keyless-tui-no-call',
        DSH_HOME: dshHome,
        DSH_AGENTS_HOME: join(cwd, '.agents'),
      },
    })
    return await new Promise((resolve, reject) => {
      const child = spawn('python3', [
        '-c',
        PTY_DRIVER,
        launch.command,
        JSON.stringify(launch.args),
        JSON.stringify(launch.env),
        cwd,
        options.resumeSessionId ?? '',
        options.scenario ?? 'boot',
        // With no configured welcome the borderless banner sweeps in; its
        // detail line's session id (`main-session-<uuid>`) renders only once
        // the sweep reaches it, so it marks a settled banner.
        options.bootMarker ?? 'main-session-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`TUI PTY smoke exited ${String(code)}. stdout:\n${stdout}\nstderr:\n${stderr}`))
          return
        }
        // Inspect the workspace before `finally` removes it (e.g. the session log).
        void (options.inspect?.(cwd) ?? Promise.resolve()).then(() => { resolve(stdout) }, reject)
      })
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
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

describe('tui-agent keyless smoke (real Loader tree in a PTY)', () => {
  it('boots pi-tui, sweeps the borderless banner in, accepts /exit, and restores the terminal', async () => {
    const output = await runTuiLoaderSmoke()
    // With no configured welcome the borderless banner sweeps in left-to-right;
    // the boot scenario waits for the detail line's session id, which renders
    // only once the sweep reaches it.
    expect(output).toContain('DEEPSEEK')
    expect(output).toContain('HARNESS')
    expect(output).toContain('main-session-')
    // Borderless: no box-drawing frame around the banner.
    expect(output).not.toContain('╭')
    expect(output).not.toContain('╮')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('streams a response, answers a user-question dialog, completes the tool round-trip, and exits cleanly', async () => {
    const output = await runTuiLoaderSmoke({ config: scriptedConfigPath, scenario: 'conversation' })
    expect(output).toContain('I need one decision before I continue.')
    expect(output).toContain(String.raw`\x1b]2;MODEL_CONTROLLED\x07`)
    expect(output).toContain(String.raw`\x1b[999CMODEL_CURSOR`)
    expect(output).toContain(String.raw`\x9b31mMODEL_C1`)
    expect(output).not.toContain('\u001B]2;MODEL_CONTROLLED\u0007')
    expect(output).not.toContain('\u001B[999CMODEL_CURSOR')
    expect(output).not.toContain('\u009B31mMODEL_C1')
    expect(output).toContain('How should the scripted run proceed?')
    expect(output).toContain('Safe')
    expect(output).toContain('Decision received. Scripted TUI run complete.')
    // Auto-title: the first user message drives a tool-less title call that the
    // scripted adapter answers, and the TUI sets it via OSC 0.
    expect(output).toContain('\u001B]0;scripted session title\u0007')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('loads a local skill via /skill: and delivers its body to the model as a user turn', async () => {
    // The whole manual-invocation path in one keyless boot: `ctx.get('skills')`
    // resolves in the shipped tree, the client-side `/skill:` command parses,
    // the local provider loads `scripted-skill` from the agents home, and the
    // rendered `<skill name="…">` block reaches the model — proven by the
    // scripted adapter echoing the fixture's body marker only when it arrives.
    const output = await runTuiLoaderSmoke({
      config: scriptedConfigPath,
      scenario: 'skill',
      skillFiles: {
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
    })
    expect(output).toContain('Scripted skill body received.')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('boots the Code Mode overlay tree, renders its banner, and exits cleanly', async () => {
    // The overlay's only keyless composition proof: the include+patch tree,
    // worker code runtime, and one-tool registry all mount before the banner.
    const output = await runTuiLoaderSmoke({
      config: codeModeConfigPath,
      bootMarker: 'TUI Code Mode ready.',
    })
    expect(output).toContain('TUI Code Mode ready.')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('prints a config-resume failure and exits instead of leaving a blank terminal', async () => {
    const output = await runTuiLoaderSmoke({ resumeSessionId: 'missing-session', scenario: 'resume-failure' })
    expect(output).toContain('ui-tui: session "missing-session" failed to start:')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

describe('dsh CLI keyless smoke (apps/cli through the same PTY)', () => {
  it('boots the shipped default config with no arguments and no personal overlay', async () => {
    const output = await runTuiLoaderSmoke({ srcBin: dshBinScript, configArgs: [] })
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
    const output = await runTuiLoaderSmoke({
      srcBin: dshBinScript,
      configArgs: [],
      bootMarker: 'PERSONAL OVERLAY READY.',
      personalFiles: {
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
    })
    expect(output).toContain('PERSONAL OVERLAY READY.')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('fails loud instead of booting when the personal config.yaml is invalid', async () => {
    await expect(runTuiLoaderSmoke({
      srcBin: dshBinScript,
      configArgs: [],
      personalFiles: { 'config.yaml': 'id: not-a-list\n' },
    })).rejects.toThrow('must be a top-level YAML array of loader patch entries')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('routes the --resume flag into the config resume intake, failing loud on a missing id', async () => {
    // The flag path end to end: apps/cli parses `--resume missing-session` and
    // sets RESUME_SESSION_ID (the PTY driver does NOT here), the shipped
    // config's `!!js` reads it, and the resume fails loud — proving the printed
    // `dsh --resume <id>` hint reaches the same intake as the env var.
    const output = await runTuiLoaderSmoke({
      srcBin: dshBinScript,
      configArgs: ['--resume', 'missing-session'],
      scenario: 'resume-failure',
    })
    expect(output).toContain('ui-tui: session "missing-session" failed to start:')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('tells the model where its own source lives, in the system prompt it sends', async () => {
    // The launcher resolves the checkout root three hops up from apps/cli/{src,lib};
    // this test file sits an equal depth under the same root, so the same hop applies.
    const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url))
    let loggedSystem = ''
    await runTuiLoaderSmoke({
      srcBin: dshBinScript,
      configArgs: [scriptedConfigPath],
      scenario: 'conversation',
      inspect: async (cwd) => { loggedSystem = await readLoggedSystemPrompt(cwd) },
    })
    expect(loggedSystem).toContain(`Your own source code is the checkout at ${sourceRoot}; you can read it there to learn how dsh works and how to extend it.`)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
