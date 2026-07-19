import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../packages/examples/stdio-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const scriptedConfigPath = fileURLToPath(new URL('./fixtures/tui-scripted.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

const PTY_DRIVER = String.raw`
import errno, json, os, pty, select, signal, sys, time
node, launch_args_json, launch_env_json, cwd, resume_session_id, scenario = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
env.update({
    "COLUMNS": "100",
    "LINES": "30",
})
if resume_session_id:
    env["RESUME_SESSION_ID"] = resume_session_id
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(launch_args_json)], env)

output = bytearray()
answered_question = False
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
    if scenario == "conversation" and not sent_prompt and b"scripted TUI ready." in output:
        os.write(fd, b"exercise the TUI\r")
        sent_prompt = True
    if scenario == "conversation" and sent_prompt and not answered_question and b"How should the scripted run proceed?" in output:
        os.write(fd, b"\r")
        answered_question = True
    if scenario == "conversation" and answered_question and not sent_exit and b"Decision received. Scripted TUI run complete." in output:
        os.write(fd, b"/exit\r")
        sent_exit = True
    if scenario == "boot" and not sent_exit and b"TUI agent ready." in output:
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
  scenario?: 'boot' | 'conversation' | 'resume-failure'
}

async function runTuiLoaderSmoke(options: TuiLoaderSmokeOptions = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'tui-agent-smoke-'))
  try {
    const launch = resolveExampleLaunch({
      srcBin: binScript,
      configArgs: [options.config ?? configPath],
      tsconfigPath,
      exposeInternals: true,
      env: {
        DEEPSEEK_API_KEY: 'keyless-tui-no-call',
        DSH_HOME: join(cwd, '.dsh'),
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
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`TUI PTY smoke exited ${String(code)}. stdout:\n${stdout}\nstderr:\n${stderr}`))
      })
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('tui-agent keyless smoke (real Loader tree in a PTY)', () => {
  it('boots pi-tui, renders the configured banner, accepts /exit, and restores the terminal', async () => {
    const output = await runTuiLoaderSmoke()
    expect(output).toContain('DEEPSEEK')
    expect(output).toContain('TUI agent ready.')
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
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('prints a config-resume failure and exits instead of leaving a blank terminal', async () => {
    const output = await runTuiLoaderSmoke({ resumeSessionId: 'missing-session', scenario: 'resume-failure' })
    expect(output).toContain('ui-tui: session "missing-session" failed to start:')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
