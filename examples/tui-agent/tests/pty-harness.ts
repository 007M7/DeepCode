import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const PTY_DRIVER = String.raw`
import errno, json, os, pty, select, signal, sys, time
node, launch_args_json, launch_env_json, cwd, actions_json, expected_exit, timeout_seconds = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
env.update({"COLUMNS": "100", "LINES": "30"})
actions = json.loads(actions_json)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(launch_args_json)], env)

output = bytearray()
action_index = 0
deadline = time.monotonic() + float(timeout_seconds)
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
    while action_index < len(actions) and actions[action_index]["waitFor"].encode() in output:
        os.write(fd, actions[action_index]["send"].encode())
        action_index += 1
    waited, candidate = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = candidate
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
if action_index != len(actions):
    sys.stderr.write(f"completed {action_index}/{len(actions)} PTY actions before timeout\n")
    sys.exit(124)
actual_exit = os.waitstatus_to_exitcode(status)
if actual_exit != int(expected_exit):
    sys.stderr.write(f"expected exit {expected_exit}, got {actual_exit}\n")
    sys.exit(125)
`

/** One terminal action sent after its marker has rendered. */
interface TuiPtyAction {
  readonly waitFor: string
  readonly send: string
}

/** Inputs for a keyless real-Loader TUI process smoke. */
export interface TuiPtySmokeOptions {
  readonly label: string
  readonly tempDirPrefix: string
  readonly binScript: string
  readonly configPath: string
  readonly tsconfigPath: string
  readonly actions?: readonly TuiPtyAction[]
  readonly env?: Readonly<NodeJS.ProcessEnv>
  readonly expectedExitCode?: number
  readonly timeoutMs?: number
}

/**
 * Boot an example in a real pseudo-terminal, drive marker-gated input, and
 * return the captured terminal bytes after the expected process exit.
 * @param options - launch paths, environment, actions, and expected exit code.
 * @returns complete pseudo-terminal output.
 */
export async function runTuiPtySmoke(options: TuiPtySmokeOptions): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), options.tempDirPrefix))
  const timeoutMs = options.timeoutMs ?? 25_000
  try {
    const launch = resolveExampleLaunch({
      srcBin: options.binScript,
      configArgs: [options.configPath],
      tsconfigPath: options.tsconfigPath,
      exposeInternals: true,
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        ...options.env,
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
        JSON.stringify(options.actions ?? []),
        String(options.expectedExitCode ?? 0),
        String(timeoutMs / 1_000),
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`${options.label} PTY driver did not exit. stdout:\n${stdout}\nstderr:\n${stderr}`))
      }, timeoutMs + 5_000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(new Error(`${options.label} PTY driver exited ${String(code)}. stdout:\n${stdout}\nstderr:\n${stderr}`))
      })
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
