import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../packages/examples/stdio-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))

const PTY_DRIVER = String.raw`
import errno, os, pty, select, signal, sys, time
node, tsx_loader, bin_script, config_path, tsconfig_path, cwd = sys.argv[1:]
env = os.environ.copy()
env.update({
    "DEEPSEEK_API_KEY": "keyless-tui-no-call",
    "DSH_HOME": os.path.join(cwd, ".dsh"),
    "DSH_AGENTS_HOME": os.path.join(cwd, ".agents"),
    "TSX_TSCONFIG_PATH": tsconfig_path,
})
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, "--expose-internals", "--import", tsx_loader, bin_script, config_path], env)

output = bytearray()
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
    if not sent_exit and b"agent REPL ready." in output:
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
if not sent_exit:
    sys.stderr.write("TUI did not render its welcome marker before timeout\n")
    sys.exit(124)
if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
    sys.stderr.write("TUI child did not exit cleanly\n")
    sys.exit(125)
`

async function runTuiLoaderSmoke(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'coding-tui-smoke-'))
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('python3', [
        '-c',
        PTY_DRIVER,
        process.execPath,
        tsxLoader,
        binScript,
        configPath,
        tsconfigPath,
        cwd,
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

describe('coding-agent TUI keyless smoke (real Loader tree in a PTY)', () => {
  it('boots pi-tui, renders the configured banner, accepts /exit, and restores the terminal', async () => {
    const output = await runTuiLoaderSmoke()
    expect(output).toContain('DEEPSEEK')
    expect(output).toContain('agent REPL ready.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
