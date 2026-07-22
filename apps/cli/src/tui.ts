/**
 * `dsh` default surface — the interactive TUI coding agent. Boots the shipped
 * tui-agent config (or an explicit config argument) with the personal overlay
 * from the Harness home (`~/.dsh`): its `.env` fills environment gaps (precedence:
 * ambient environment, then the invoking directory's `.env`, then the personal one)
 * and its `config.yaml` patches the booted tree. The workspace is the invoking
 * directory: sessions, relative paths, and workspace instructions resolve from
 * the cwd, so `dsh` acts on whatever project it is launched in. After boot, the
 * agent's system prompt is told the path to this harness checkout so it can find
 * its own source.
 * @module @deepseek-ai/dsh/tui
 */

import { fileURLToPath } from 'node:url'
import {
  addHarnessSourceSection,
  boot,
  installFailLoud,
  loadEnv,
  loadPersonalPatches,
  parseResumeArg,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'

const NAME = 'dsh'

// The env var the shipped tui-agent config reads (`resumeSessionId: !!js
// process.env.RESUME_SESSION_ID`) to rehydrate a persisted session. The
// `--resume <id>` flag is CLI sugar that sets it before boot, so the printed
// `dsh --resume <id>` exit hint runs back through this same intake.
const RESUME_SESSION_ID_ENV = 'RESUME_SESSION_ID'

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
 * @param argv - arguments after the subcommand dispatch; a `--resume <id>` flag
 * resumes that persisted session, and the first non-flag argument may name a
 * config to boot instead of the shipped default.
 */
export async function runTui(argv: string[]): Promise<void> {
  // Refuse pipes BEFORE booting: a compose-time throw inside the Loader tree
  // is logged per-entry rather than rethrown, so a piped launch would
  // otherwise settle into an idle UI-less process instead of exiting nonzero.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${NAME}: the TUI requires stdin and stdout to be interactive TTYs\n`)
    process.exit(1)
  }
  installFailLoud(NAME)
  // The bin already loaded the invoking directory's .env; the personal .env
  // only fills what is still unset (process.loadEnvFile never overrides).
  loadEnv(NAME, resolveDshHome())
  // An explicit `--resume` flag beats any ambient RESUME_SESSION_ID, so set it
  // after loadEnv and before boot reads it through the config's `!!js`.
  const { resumeSessionId, rest } = parseResumeArg(argv)
  if (resumeSessionId !== undefined) process.env[RESUME_SESSION_ID_ENV] = resumeSessionId
  const ctx = await boot(NAME, resolveConfigPath(rest[0] ?? DEFAULT_CONFIG, undefined), loadPersonalPatches(NAME))
  addHarnessSourceSection(ctx, SOURCE_ROOT)
}
/* v8 ignore stop */
