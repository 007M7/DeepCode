/**
 * `dsh` default surface — the interactive TUI coding agent. Boots the shipped
 * tui-agent config (or the `--config` override) with the personal overlay
 * from the Harness home (`~/.dsh`): its `.env` fills environment gaps (precedence:
 * ambient environment, then the invoking directory's `.env`, then the personal one)
 * and its `config.yaml` patches the booted tree. The workspace is the invoking
 * directory: sessions, relative paths, and workspace instructions resolve from
 * the cwd, so `dsh` acts on whatever project it is launched in. After boot, the
 * agent's system prompt is told the path to this harness checkout so it can find
 * its own source.
 * @module @deepseek-ai/dsh/tui
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addHarnessSourceSection,
  boot,
  installFailLoud,
  loadEnv,
  loadPersonalPatches,
  RESUME_SESSION_ID_KEY,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import type { Context } from 'cordis'
import type { TuiResumeHost } from '@deepseek-ai/dsh-tui'

const NAME = 'dsh'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the shipped default config resolves with
// the same relative hop from either artifact.
const DEFAULT_CONFIG = fileURLToPath(new URL('../../../examples/tui-agent/cordis.yml', import.meta.url))

// The harness checkout root: three hops up from apps/cli/{src,lib}, resolved
// from this bin's location so it holds however `dsh` is launched (a PATH
// symlink, an arbitrary cwd). The agent is told where its own source lives.
const SOURCE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/* v8 ignore start -- composition over the unit-tested dsh-app-boot helpers;
   the tui-agent PTY smoke drives this path end to end, personal overlay included */
/**
 * Run the interactive TUI from the invoking directory.
 * @param config - a config path to boot instead of the shipped default, or
 * `undefined` for the default; already parsed from `--config`.
 * @param resumeSessionId - a persisted session id to resume, or `undefined`;
 * already parsed and non-empty-validated from `--resume`. It is provided on the
 * boot context under {@link RESUME_SESSION_ID_KEY}, which the shipped config
 * reads through `!!js` to rehydrate that session.
 */
export async function runTui(config: string | undefined, resumeSessionId: string | undefined): Promise<void> {
  // Refuse pipes BEFORE booting: a compose-time throw inside the Loader tree
  // is logged per-entry rather than rethrown, so a piped launch would
  // otherwise settle into an idle UI-less process instead of exiting nonzero.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      `${NAME}: the TUI requires stdin and stdout to be interactive TTYs; use \`${NAME} -p "task"\` for pipes and automation\n`,
    )
    process.exit(1)
  }
  installFailLoud(NAME)
  // The bin already loaded the invoking directory's .env; the personal .env
  // only fills what is still unset (process.loadEnvFile never overrides).
  loadEnv(NAME, resolveDshHome())
  process.env.DSH_BUNDLED_SKILL_DIR = join(SOURCE_ROOT, 'skills')
  // The in-place `/resume` handoff re-execs `dsh` with a normalized `--resume`
  // flag, so the resumed process rehydrates through this same intake. The host
  // is offered only when Node exposes `process.execve` and knows its own entry.
  const entry = process.argv[1]
  const execve = process.execve?.bind(process)
  const app: { current?: Context } = {}
  const resumeHost: TuiResumeHost | undefined = entry === undefined || execve === undefined ? undefined : {
    async handoff(sessionId): Promise<never> {
      const current = app.current
      if (current === undefined) throw new Error(`${NAME}: app boot has not completed`)
      // Rebuild argv from the parsed config plus the selected id: TUI mode's
      // only arguments are `--config <path>` and `--resume <id>`.
      const nextArgv = [
        process.execPath,
        ...process.execArgv,
        entry,
        `--resume=${sessionId}`,
        ...config !== undefined ? ['--config', config] : [],
      ]
      try {
        await current.fiber.dispose()
        execve(process.execPath, nextArgv, process.env)
        throw new Error('process replacement returned unexpectedly')
      } catch (error) {
        process.stderr.write(`${NAME}: resume handoff failed after terminal release: ${String(error)}\n`)
        process.exit(1)
      }
    },
  }
  const ctx = await boot(
    NAME,
    resolveConfigPath(config ?? DEFAULT_CONFIG, undefined),
    loadPersonalPatches(NAME),
    (hostCtx) => {
      // Inject the resume id (or undefined) so the shipped config's `!!js`
      // reads it as a bare identifier; then offer the in-place handoff host.
      hostCtx.provide(RESUME_SESSION_ID_KEY, resumeSessionId)
      if (resumeHost !== undefined) hostCtx.provide('tuiResumeHost', resumeHost)
    },
  )
  app.current = ctx
  addHarnessSourceSection(ctx, SOURCE_ROOT)
}
/* v8 ignore stop */
