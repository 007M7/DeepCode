import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveExampleLaunch, type ExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const POSIX_PTY_DRIVER = String.raw`
import errno, json, os, pty, select, signal, sys, time
node, launch_args_json, launch_env_json, cwd, actions_json, expected_exit, timeout_seconds = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
env.update({"COLUMNS": "100", "LINES": "30"})
# Deterministic banner: a developer shell's COLORTERM=truecolor would switch the
# banner to the per-letter gradient (one SGR per letter), breaking literal
# DEEPSEEK assertions. The gradient path has its own unit and snapshot coverage.
env.pop("COLORTERM", None)
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
  /** Config argument; ignored when {@link configArgs} is set. */
  readonly configPath?: string
  /** Full argument vector for the bin (e.g. `[]` for a bin with a built-in default config). */
  readonly configArgs?: readonly string[]
  readonly tsconfigPath: string
  readonly actions?: readonly TuiPtyAction[]
  readonly env?: Readonly<NodeJS.ProcessEnv>
  readonly expectedExitCode?: number
  readonly timeoutMs?: number
  /** Seed the isolated workspace (`cwd`, with `$DSH_HOME` at `.dsh` and the agents home at `.agents`) before launch. */
  readonly prepare?: (cwd: string) => Promise<void>
  /** Inspect the workspace after a passing run, before the temp dir is removed. */
  readonly inspect?: (cwd: string) => Promise<void>
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

async function runPosixPtySmoke(
  launch: ExampleLaunch,
  cwd: string,
  options: TuiPtySmokeOptions,
  timeoutMs: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('python3', [
      '-c',
      POSIX_PTY_DRIVER,
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
}

async function runWindowsPtySmoke(
  launch: ExampleLaunch,
  cwd: string,
  options: TuiPtySmokeOptions,
  timeoutMs: number,
): Promise<string> {
  const pty = await import('node-pty')
  return await new Promise((resolve, reject) => {
    const actions = options.actions ?? []
    const expectedExitCode = options.expectedExitCode ?? 0
    let output = ''
    let actionIndex = 0
    let timedOut = false
    const terminal = pty.spawn(launch.command, launch.args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: definedEnv({
        ...process.env,
        ...launch.env,
        // Match the POSIX driver: no COLORTERM, so the banner never takes the
        // truecolor gradient path under a developer's shell.
        COLORTERM: undefined,
        COLUMNS: '100',
        LINES: '30',
      }),
    })
    const timer = setTimeout(() => {
      timedOut = true
      terminal.kill()
    }, timeoutMs)
    terminal.onData((chunk) => {
      output += chunk
      while (actionIndex < actions.length && output.includes(actions[actionIndex]!.waitFor)) {
        terminal.write(actions[actionIndex]!.send)
        actionIndex += 1
      }
    })
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${options.label} PTY process did not exit before ${String(timeoutMs)}ms. output:\n${output}`))
      } else if (actionIndex !== actions.length) {
        reject(new Error(`${options.label} completed ${String(actionIndex)}/${String(actions.length)} PTY actions. output:\n${output}`))
      } else if (exitCode !== expectedExitCode) {
        reject(new Error(`${options.label} expected exit ${String(expectedExitCode)}, got ${String(exitCode)} (signal ${String(signal)}). output:\n${output}`))
      } else {
        resolve(output)
      }
    })
  })
}

/**
 * Boot an example in a real pseudo-terminal (ConPTY on Windows), drive
 * marker-gated input, and return captured bytes after the expected process exit.
 * @param options - launch paths, environment, actions, and expected exit code.
 * @returns complete pseudo-terminal output.
 */
export async function runTuiPtySmoke(options: TuiPtySmokeOptions): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), options.tempDirPrefix))
  const timeoutMs = options.timeoutMs ?? 25_000
  try {
    await options.prepare?.(cwd)
    const launch = resolveExampleLaunch({
      srcBin: options.binScript,
      configArgs: options.configArgs !== undefined
        ? [...options.configArgs]
        /* v8 ignore next -- every caller passes configPath or configArgs; the fallback keeps the type total */
        : [options.configPath ?? './cordis.yml'],
      tsconfigPath: options.tsconfigPath,
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        ...options.env,
      },
    })
    const output = process.platform === 'win32'
      ? await runWindowsPtySmoke(launch, cwd, options, timeoutMs)
      : await runPosixPtySmoke(launch, cwd, options, timeoutMs)
    // Inspect the workspace before `finally` removes it (e.g. the session log).
    await options.inspect?.(cwd)
    return output
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
