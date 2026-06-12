import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { killGroup, OutputCollector, runBash } from '@deepseek-ai/dsh-bash-local'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-spec-'))

function spec(command: string, overrides: Partial<Parameters<typeof runBash>[0]> = {}) {
  return {
    command,
    cwd: process.cwd(),
    timeoutMs: 0,
    maxOutputBytes: 64_000,
    ...overrides,
  }
}

/** Poll until a pid no longer exists (kill(pid, 0) throws ESRCH). */
async function waitGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`)
}

describe('runBash', () => {
  it('captures stdout on success', async () => {
    const result = await runBash(spec('echo hello')).done
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stdout.text).toBe('hello\n')
    expect(result.stdout.truncated).toBe(false)
    expect(result.stderr.text).toBe('')
  })

  it('captures stderr separately', async () => {
    const result = await runBash(spec('echo oops >&2')).done
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('')
    expect(result.stderr.text).toBe('oops\n')
  })

  it('captures both streams', async () => {
    const result = await runBash(spec('echo out; echo err >&2')).done
    expect(result.stdout.text).toBe('out\n')
    expect(result.stderr.text).toBe('err\n')
  })

  it('reports non-zero exit codes', async () => {
    const result = await runBash(spec('exit 42')).done
    expect(result.exitCode).toBe(42)
    expect(result.signal).toBeNull()
  })

  it('applies model-friendly env overrides', async () => {
    const result = await runBash(spec('echo "$NO_COLOR/$TERM/$PAGER"')).done
    expect(result.stdout.text).toBe('1/dumb/cat\n')
  })

  it('runs in the requested cwd', async () => {
    const result = await runBash(spec('pwd', { cwd: '/tmp' })).done
    expect(result.stdout.text.trim()).toMatch(/\/tmp$/)
  })

  it('kills with SIGTERM on timeout', async () => {
    const start = Date.now()
    const result = await runBash(spec('sleep 60', { timeoutMs: 100 })).done
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGTERM')
    expect(result.exitCode).toBeNull()
  })

  it('escalates to SIGKILL when SIGTERM is trapped', async () => {
    const result = await runBash(
      spec('trap \'\' TERM; sleep 60', { timeoutMs: 100 }),
      { graceMs: 200 },
    ).done
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
  })

  it('kills the whole process group (grandchildren die too)', async () => {
    // The subshell writes the sleep's pid then waits on it; killing the
    // group must take the sleep down with bash.
    const pidFile = join(spillDir, `grandchild-${Date.now()}.pid`)
    const running = runBash(spec(`sleep 60 & echo $! > ${pidFile}; wait`))
    await new Promise(resolve => setTimeout(resolve, 300))
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim())
    expect(grandchild).toBeGreaterThan(0)

    running.kill()
    const result = await running.done
    expect(result.signal).toBe('SIGTERM')
    await waitGone(grandchild)
  })

  it('aborts via AbortSignal mid-run', async () => {
    const controller = new AbortController()
    const running = runBash(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort('user cancelled') }, 50)
    const result = await running.done
    expect(result.aborted).toBe(true)
    expect(result.signal).toBe('SIGTERM')
  })

  it('throws when the signal is already aborted before spawn', () => {
    const controller = new AbortController()
    controller.abort('too late')
    expect(() => runBash(spec('echo hi', { signal: controller.signal })))
      .toThrow(/aborted before spawn: too late/)
  })

  it('rejects with a spawn error for a nonexistent cwd', async () => {
    await expect(runBash(spec('echo hi', { cwd: '/nonexistent-dir-dsh-test' })).done)
      .rejects.toThrow(/ENOENT/)
  })

  it('kill() is idempotent (second call does not restart escalation)', async () => {
    const running = runBash(spec('sleep 60'))
    running.kill()
    running.kill()
    const result = await running.done
    expect(result.signal).toBe('SIGTERM')
  })
})

describe('output truncation and spill', () => {
  it('keeps the tail and spills the full stream to disk', async () => {
    // 200 numbered lines of ~10 bytes; cap at 500 bytes keeps a late tail.
    const result = await runBash(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { maxOutputBytes: 500 }),
      { spillDir },
    ).done
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text.length).toBeLessThanOrEqual(500)
    expect(result.stdout.text).toContain('line-0200')
    expect(result.stdout.text).not.toContain('line-0001')
    expect(result.stdout.spillPath).toBeDefined()
    const full = readFileSync(result.stdout.spillPath!, 'utf8')
    expect(full).toContain('line-0001')
    expect(full).toContain('line-0200')
  })

  it('does not truncate output exactly at the cap', async () => {
    const result = await runBash(
      spec('printf "%.0sx" $(seq 1 500)', { maxOutputBytes: 500 }),
      { spillDir },
    ).done
    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.text.length).toBe(500)
    expect(result.stdout.spillPath).toBeUndefined()
  })
})

describe('OutputCollector', () => {
  it('keeps the tail of a single oversized chunk', () => {
    const collector = new OutputCollector(10, 'test', spillDir)
    collector.push(Buffer.from('0123456789abcdef'))
    const out = collector.finalize()
    expect(out.text).toBe('6789abcdef')
    expect(out.truncated).toBe(true)
    expect(readFileSync(out.spillPath!, 'utf8')).toBe('0123456789abcdef')
  })

  it('readFrom returns increments and flags lossy reads', () => {
    const collector = new OutputCollector(10, 'test', spillDir)
    collector.push(Buffer.from('aaaaa'))
    const first = collector.readFrom(0)
    expect(first.text).toBe('aaaaa')
    expect(first.lossy).toBe(false)
    expect(first.nextOffset).toBe(5)

    collector.push(Buffer.from('bbbbb'))
    const second = collector.readFrom(first.nextOffset)
    expect(second.text).toBe('bbbbb')
    expect(second.lossy).toBe(false)

    // Push enough to slide the window past the last offset.
    collector.push(Buffer.from('c'.repeat(20)))
    const third = collector.readFrom(second.nextOffset)
    expect(third.lossy).toBe(true)
    expect(third.text).toBe('c'.repeat(10))
    expect(third.spillPath).toBeDefined()
  })

  it('tracks totalBytes across drops', () => {
    const collector = new OutputCollector(4, 'test', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbb'))
    expect(collector.totalBytes).toBe(8)
    expect(collector.finalize().text).toBe('bbbb')
  })
})

describe('killGroup', () => {
  it('ignores non-positive pids', () => {
    expect(() => { killGroup(-1, 'SIGTERM') }).not.toThrow()
    expect(() => { killGroup(0, 'SIGTERM') }).not.toThrow()
  })

  it('swallows ESRCH for vanished groups', async () => {
    const running = runBash(spec('true'))
    await running.done
    expect(() => { killGroup(running.pid, 'SIGTERM') }).not.toThrow()
  })
})

describe('abort edge cases', () => {
  it('reports a fallback reason for reason-less pre-aborted signals', () => {
    // Real AbortControllers always set a DOMException reason; signal-like
    // objects from other libraries may not — the fallback covers them.
    const bare = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    expect(() => runBash(spec('echo hi', { signal: bare })))
      .toThrow(/aborted before spawn: aborted/)
  })

  it('reports an externally self-killed command without the timeout marker', async () => {
    const result = await runBash(spec('kill -TERM $$')).done
    expect(result.signal).toBe('SIGTERM')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })
})

describe('review fixes: env scrubbing and spill hardening', () => {
  it('scrubs credential-shaped env vars from child processes', async () => {
    process.env.DSH_TEST_API_KEY = 'super-secret'
    process.env.DSH_TEST_TOKEN = 'also-secret'
    process.env.DSH_TEST_PLAIN = 'visible'
    try {
      const result = await runBash(spec('echo "[${DSH_TEST_API_KEY:-absent}|${DSH_TEST_TOKEN:-absent}|${DSH_TEST_PLAIN:-absent}]"')).done
      expect(result.stdout.text.trim()).toBe('[absent|absent|visible]')
    } finally {
      delete process.env.DSH_TEST_API_KEY
      delete process.env.DSH_TEST_TOKEN
      delete process.env.DSH_TEST_PLAIN
    }
  })

  it('creates spill files with owner-only permissions and random names', async () => {
    const result = await runBash(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { maxOutputBytes: 500 }),
      { spillDir },
    ).done
    const path = result.stdout.spillPath!
    expect(path).toMatch(/dsh-bash-\d+-\d+-[0-9a-f]{12}-stdout\.log$/)
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('defaults spills into a private per-process directory', async () => {
    const result = await runBash(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { maxOutputBytes: 500 }),
    ).done
    const dir = dirname(result.stdout.spillPath!)
    expect(dir).toMatch(/dsh-bash-/)
    const mode = statSync(dir).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it('killGroup never throws, even for EPERM-style failures', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    try {
      expect(() => { killGroup(12345, 'SIGTERM') }).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })

  it('honors AbortSignal on background-style runs (no timeout)', async () => {
    const controller = new AbortController()
    const running = runBash(spec('sleep 60', { timeoutMs: 0, signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 50)
    const result = await running.done
    expect(result.aborted).toBe(true)
    expect(result.signal).toBe('SIGTERM')
  })
})
