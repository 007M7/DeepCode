/**
 * Real-load-path guard for @deepseek-ai/dsh-tool-fs-search. `tool-fs-search` is
 * a NAMESPACE plugin with `inject` — so a stray `export default apply` would
 * make the cordis Loader's `unwrapExports` (`exports.default ?? exports`)
 * collapse the module to the bare `apply` function, DROPPING `inject`. The
 * plugin would then read `ctx.bash` without having injected it and throw
 * `cannot get property … without inject` the moment it loads (postmortem 0001).
 *
 * A hand-built `ctx.plugin({ apply, inject })` mount CANNOT catch that — it
 * bypasses `unwrapExports`. So this test unwraps the module through the REAL
 * `Loader.prototype.unwrapExports` and mounts the result over a bash executor,
 * exercising the exact path the Loader uses. Prove the guard bites: add
 * `export default apply` to `src/index.ts`, watch this go red, revert.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { BashExecutor } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from '@deepseek-ai/dsh-bash'
import * as toolFsSearch from '@deepseek-ai/dsh-tool-fs-search'

const RG_PROBE_COMMAND = 'command -v rg >/dev/null 2>&1'

/**
 * Deterministic bash service for this Loader guard: the test wants to exercise
 * the real unwrap/inject path, not depend on whether the host image has rg.
 */
class ProbeSuccessBashExecutor extends BashExecutor {
  override resolve(request: BashExecRequest): BashExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/work',
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      signal: request.signal,
      sandboxMode: request.sandboxMode,
    }
  }

  override run(spec: BashExecSpec): Promise<BashRunResult> {
    if (spec.command !== RG_PROBE_COMMAND) {
      throw new Error(`unexpected command in load-path guard: ${spec.command}`)
    }
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    })
  }

  override start(): BashProcess {
    throw new Error('load-path guard must not start background processes')
  }
}

describe('dsh-tool-fs-search real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolFsSearch).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolFsSearch) as Record<string, unknown>
    expect(unwrapped).toBe(toolFsSearch)
    expect(unwrapped.name).toBe('tool-fs-search')
    expect(unwrapped.inject).toEqual(['tools', 'systemPrompt', 'bash'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.bash through the unwrapped module without an inject error', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(ProbeSuccessBashExecutor)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolFsSearch) as Parameters<Context['plugin']>[0]
    // A collapsed export shape (dropped inject) would throw "without inject" here.
    const fiber = await ctx.plugin(unwrapped)
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(expect.arrayContaining(['glob', 'grep']))
    await fiber.dispose()
  })
})
