import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { runTuiPtySmoke } from './pty-harness.ts'

const binScript = fileURLToPath(new URL('../../../packages/examples/tui-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const scriptedConfigPath = fileURLToPath(new URL('./fixtures/tui-scripted.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('tui-agent keyless smoke (real Loader tree in a PTY)', () => {
  it('boots pi-tui, renders the configured banner, accepts /exit, and restores the terminal', async () => {
    const output = await runTuiPtySmoke({
      label: 'tui-agent boot',
      tempDirPrefix: 'tui-agent-smoke-',
      binScript,
      configPath,
      tsconfigPath,
      env: { DEEPSEEK_API_KEY: 'keyless-tui-no-call' },
      actions: [{ waitFor: 'TUI agent ready.', send: '/exit\r' }],
    })
    expect(output).toContain('DEEPSEEK')
    expect(output).toContain('TUI agent ready.')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('streams a response, answers a user-question dialog, completes the tool round-trip, and exits cleanly', async () => {
    const output = await runTuiPtySmoke({
      label: 'tui-agent conversation',
      tempDirPrefix: 'tui-agent-conversation-',
      binScript,
      configPath: scriptedConfigPath,
      tsconfigPath,
      actions: [
        { waitFor: 'scripted TUI ready.', send: 'exercise the TUI\r' },
        { waitFor: 'How should the scripted run proceed?', send: '\r' },
        { waitFor: 'Decision received. Scripted TUI run complete.', send: '/exit\r' },
      ],
    })
    expect(output).toContain('I need one decision before I continue.')
    expect(output).toContain(String.raw`\x1b]2;MODEL_CONTROLLED\x07`)
    expect(output).toContain(String.raw`\x1b[999CMODEL_CURSOR`)
    expect(output).toContain(String.raw`\x9b31mMODEL_C1`)
    expect(output).not.toContain('\u001B]2;MODEL_CONTROLLED\u0007')
    expect(output).not.toContain('\u001B[999CMODEL_CURSOR')
    expect(output).not.toContain('\u009B31mMODEL_C1')
    expect(output).toContain('Safe')
    expect(output).toContain('\u001B[?2004l')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('prints a config-resume failure and exits instead of leaving a blank terminal', async () => {
    const output = await runTuiPtySmoke({
      label: 'tui-agent resume failure',
      tempDirPrefix: 'tui-agent-resume-',
      binScript,
      configPath,
      tsconfigPath,
      env: {
        DEEPSEEK_API_KEY: 'keyless-tui-no-call',
        RESUME_SESSION_ID: 'missing-session',
      },
      expectedExitCode: 1,
    })
    expect(output).toContain('ui-tui: session "missing-session" failed to start:')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
