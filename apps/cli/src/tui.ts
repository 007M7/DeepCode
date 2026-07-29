/**
 * `dsh` default surface — the interactive TUI coding agent. Boots the shipped
 * tui-agent config (or the `--config` override) with the personal overlay
 * from the Harness home (`~/.dsh`): its `.env` fills environment gaps (precedence:
 * ambient environment, then the invoking directory's `.env`, then the personal one)
 * and its `config.yaml` patches the booted tree. The workspace is the invoking
 * directory: the session cwd, relative paths, and workspace instructions resolve
 * from it, so `dsh` acts on whatever project it is launched in. Session storage
 * is the exception — it lives under the Harness home so `/resume` reaches every
 * workspace, and an in-place resume enters the selected session's own directory.
 * `dsh meta`
 * ({@link runMeta}) is the one exception — it makes this harness checkout the
 * workspace. `dsh migrate`/`dsh upgrade` ({@link runSkillSession}) are fresh
 * sessions whose first turn auto-invokes a bundled skill. After boot, the
 * agent's system prompt is told the path to this harness checkout so it can
 * find its own source.
 * @module @deepseek-ai/dsh/tui
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addHarnessSourceSection,
  boot,
  installFailLoud,
  loadEnv,
  loadPersonalPatches,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome, resolveSessionsRoot } from '@deepseek-ai/dsh-paths'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from 'cordis'
import { registerLiveSessions } from './register-session.ts'
import {
  INITIAL_SKILL_KEY,
  MAIN_SESSION_ID_KEY,
  SESSIONS_ROOT_KEY,
  TUI_GOODBYE_MESSAGE_KEY,
  type MainSessionIdentity,
  type TuiResumeHost,
} from '@deepseek-ai/dsh-tui'

const NAME = 'dsh'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the shipped default config resolves with
// the same relative hop from either artifact.
const DEFAULT_CONFIG = fileURLToPath(new URL('../../../examples/tui-agent/cordis.yml', import.meta.url))

// The harness checkout root: three hops up from apps/cli/{src,lib}, resolved
// from this bin's location so it holds however `dsh` is launched (a PATH
// symlink, an arbitrary cwd). The agent is told where its own source lives.
const SOURCE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * The value `dsh` provides on the {@link SESSIONS_ROOT_KEY} boot slot: its
 * shared session-store root, `sessions` under the Harness home. Shared-store
 * policy is the launcher's alone — the app bundle treats the slot as opaque and
 * keeps a project-local fallback, so only `dsh` decides that sessions are
 * shared across working directories (making `/resume` and `list-sessions` span
 * every workspace).
 * @returns the absolute session-store root this launcher shares.
 */
export function launcherSessionsRoot(): string {
  return resolveSessionsRoot()
}

/* v8 ignore start -- composition over the unit-tested dsh-app-boot helpers;
   the tui-agent PTY smoke drives this path end to end, personal overlay included */
/**
 * Run the interactive TUI with this harness checkout as the workspace
 * (`dsh meta`), whatever directory it was launched from.
 * @param resumeSessionId - a persisted session id to resume, or `undefined`;
 * see {@link runTui}. Meta-mode sessions live under the checkout, so an id from
 * an ordinary `dsh` run in another directory is not found here.
 */
export async function runMeta(resumeSessionId: string | undefined): Promise<void> {
  return runTui(undefined, resumeSessionId, SOURCE_ROOT)
}

/**
 * Run the interactive TUI as a guided fresh session whose first turn invokes a
 * bundled skill (`dsh migrate` → `dsh-migrate`, `dsh upgrade` → `dsh-upgrade`).
 * Always mints a fresh session in the invoking directory; the skill is seeded
 * only on this first launch, so a later `--resume` of the session is an ordinary
 * TUI session with no re-injection.
 * @param skill - the bundled skill name to auto-invoke as the first turn.
 */
export async function runSkillSession(skill: string): Promise<void> {
  return runTui(undefined, undefined, undefined, skill)
}

/**
 * Run the interactive TUI from the invoking directory.
 * @param config - a config path to boot instead of the shipped default, or
 * `undefined` for the default; already parsed from `--config`.
 * @param resumeSessionId - a persisted session id to resume, or `undefined` to
 * mint a fresh one; already parsed and non-empty-validated from `--resume`.
 * Either way the resulting identity reaches the booted app through
 * {@link MAIN_SESSION_ID_KEY}, so no config key selects the session.
 * @param workspace - a directory to make the workspace instead of the invoking
 * one, or `undefined` to keep the cwd. Only `dsh meta` passes it.
 * @param initialSkill - a bundled skill to auto-invoke as a fresh session's
 * first turn, or `undefined`. Set only by {@link runSkillSession} and ignored
 * on a resume, so it never re-fires; reaches the app through
 * {@link INITIAL_SKILL_KEY}.
 */
export async function runTui(
  config: string | undefined,
  resumeSessionId: string | undefined,
  workspace?: string,
  initialSkill?: string,
): Promise<void> {
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
  // Both .env layers are loaded, so switching the workspace here cannot alter
  // environment precedence. The cwd IS the workspace seam: the shipped config
  // resolves the session cwd and the HMR watch root from it, so one chdir moves
  // both together. Sessions themselves live under the Harness home so `/resume`
  // spans every workspace, and are unaffected by this chdir.
  if (workspace !== undefined) process.chdir(workspace)
  process.env.DSH_BUNDLED_SKILL_DIR = join(SOURCE_ROOT, 'skills')
  // The in-place `/resume` handoff re-execs `dsh` with a normalized `--resume`
  // flag, so the resumed process rehydrates through this same intake. The
  // selected session may belong to another workspace, so the handoff also enters
  // that directory. The host is offered only when Node exposes `process.execve`
  // and knows its own entry.
  const entry = process.argv[1]
  const execve = process.execve?.bind(process)
  const app: { current?: Context } = {}
  // Resuming reproduces THIS invocation with a different id. Meta mode is a
  // subcommand that rejects `--config`, while the default surface carries it, so
  // both the in-place handoff and the printed command derive from one shape.
  // `meta` is only reproducible for a target inside this checkout: it chdirs to
  // SOURCE_ROOT itself, which would override any other workspace, so a
  // cross-workspace resume takes the default surface and the caller supplies the
  // directory instead.
  const resumeArgs = (sessionId: string, targetCwd?: string): string[] =>
    workspace !== undefined && (targetCwd === undefined || targetCwd === workspace)
      ? ['meta', `--resume=${sessionId}`]
      : [`--resume=${sessionId}`, ...config !== undefined ? ['--config', config] : []]
  // Mint the fresh id here rather than in the app bundle: the exit line names
  // the session to resume, so the launcher must know it before the tree boots.
  const identity: MainSessionIdentity = resumeSessionId === undefined
    ? { id: SessionId(`main-session-${randomUUID()}`), resume: false }
    : { id: SessionId(resumeSessionId), resume: true }
  const goodbye = `To resume this session: ${NAME} ${resumeArgs(identity.id).join(' ')}`
  const resumeHost: TuiResumeHost | undefined = entry === undefined || execve === undefined ? undefined : {
    async handoff(sessionId, cwd): Promise<never> {
      const current = app.current
      if (current === undefined) throw new Error(`${NAME}: app boot has not completed`)
      const nextArgv = [
        process.execPath,
        ...process.execArgv,
        entry,
        ...resumeArgs(sessionId, cwd),
      ]
      // `execve` inherits the cwd, and the target session may belong to another
      // workspace. Enter it BEFORE teardown commits: an unreachable directory
      // (deleted, unreadable) must reject while the caller can still restore the
      // terminal, and a chdir after disposal would have no owner to report to.
      try {
        process.chdir(cwd)
      } catch (error) {
        throw new Error(`${NAME}: cannot resume in "${cwd}": ${String(error)}`)
      }
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
      // The launcher owns session identity and the exit line: a config-mounted
      // app bundle reads both from these slots, so no cordis.yml key can drop
      // resume.
      hostCtx.provide(MAIN_SESSION_ID_KEY, identity)
      hostCtx.provide(TUI_GOODBYE_MESSAGE_KEY, goodbye)
      // Shared-store policy is the launcher's: sessions live in one root under
      // the Harness home across every cwd, so /resume and list-sessions see
      // every workspace. The bundle treats the slot as opaque.
      hostCtx.provide(SESSIONS_ROOT_KEY, launcherSessionsRoot())
      if (resumeHost !== undefined) hostCtx.provide('tuiResumeHost', resumeHost)
      // Seed the first turn only for a fresh session, so resuming never
      // re-invokes the skill.
      if (initialSkill !== undefined && resumeSessionId === undefined) {
        hostCtx.provide(INITIAL_SKILL_KEY, initialSkill)
      }
    },
  )
  app.current = ctx
  addHarnessSourceSection(ctx, SOURCE_ROOT)
  // Publication follows the store; meta mode already chdir'd, so each session
  // reports its own cwd.
  await registerLiveSessions(ctx)
}
/* v8 ignore stop */
