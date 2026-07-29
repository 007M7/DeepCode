/**
 * Denies model-driven file mutation inside a dsh staging worktree until the
 * calling session has loaded the required customization skill. Config, git
 * resolution, and satisfaction semantics live in the package README; rationale
 * lives in the source-guard Agent Note.
 * @module @deepseek-ai/dsh-source-guard
 */

import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import z from 'schemastery'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-fs'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'source-guard'

/** The `ctx.fs` provider supplies the git-metadata reads this guard resolves paths with. */
export const inject = ['fs']

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an empty `tools`
 * list, a blank `requiredSkill`, or a relative `protectedCheckout` throws at
 * plugin load, never a silent fall-back).
 */
export interface Config {
  /** Skill whose loaded presence in the session lifts the denial (default `dsh-customize`). */
  requiredSkill?: string
  /** Tool names to gate (default `['write', 'edit']`). */
  tools?: string[]
  /**
   * Absolute path inside the checkout this guard protects. Its worktree
   * supplies BOTH protected identities: the repository (targets in any other
   * repository are ignored) and the exact branch (only that branch's worktree
   * is protected). Defaults to this module's own location, which resolves the
   * checkout the running harness was launched from — the live deployment,
   * whatever its branch is named. Set it explicitly to guard a different
   * checkout, or when the harness runs from an installed copy whose own
   * location is not a checkout at all.
   */
  protectedCheckout?: string
}

export const Config: z<Config> = z.object({
  requiredSkill: z.string().default('dsh-customize'),
  tools: z.array(z.string()).default(['write', 'edit']),
  protectedCheckout: z.string().default(fileURLToPath(import.meta.url)),
})

/**
 * The tool whose successful call satisfies the guard. Fixed, not configurable:
 * this is the harness's own skill-loading tool name, so a deployment that
 * renamed it has no skill to load and nothing for this guard to observe.
 */
const SKILL_TOOL = 'skill'

/**
 * The argument key every gated tool names its target with. `write` and `edit`
 * share it (`dsh-tool-fs`), and gating a tool that does not is a
 * misconfiguration the guard reports rather than silently allowing.
 */
const PATH_ARGUMENT = 'file_path'

/**
 * The absolute `file_path` a gated call targets, or `undefined` when the
 * arguments carry no usable one. Arguments arrive as the loop's parsed model
 * JSON, so this is a model-input boundary: any shape is possible.
 *
 * A relative path resolves against the calling session's workspace, exactly as
 * the filesystem tools resolve it (`dsh-tool-fs`'s `sessionCwd`). Judging only
 * absolute paths would leave `write` with a relative `file_path` as an
 * unguarded path to the same file.
 */
function targetPath(argumentsValue: unknown, sessionCwd: string | undefined): string | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const value = (argumentsValue as Record<string, unknown>)[PATH_ARGUMENT]
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (isAbsolute(value)) return resolve(value)
  // Without a session cwd the tools fall back to a provider-owned default this
  // guard cannot observe, so the target is genuinely unresolvable here.
  return sessionCwd === undefined ? undefined : resolve(sessionCwd, value)
}

/** One resolved worktree's identity: the branch its HEAD names, and the repository it belongs to. */
interface Worktree {
  /** Branch name from `HEAD`, or `undefined` for a detached HEAD. */
  branch: string | undefined
  /**
   * Symlink-resolved absolute path of the shared git directory, identifying the
   * repository across worktrees. Canonical because two paths reaching one
   * repository by different symlink routes must compare equal — on macOS a
   * session cwd under `/var/...` and a configured path under `/private/var/...`
   * name the same directory, and a lexical comparison would fail open.
   */
  commonDir: string
}

/**
 * What one git-metadata path holds: a file's text, the fact that it is a
 * directory, or nothing resolvable. Every caller treats the unresolvable case
 * as "not a worktree" and lets the call proceed, so distinguishing absence
 * from a permission error would change no decision.
 */
type GitEntry =
  | { kind: 'file'; text: string }
  | { kind: 'directory' }
  | { kind: 'absent' }

/** Probe one git-metadata path, reading its text when it is a regular file. */
async function readGitEntry(ctx: Context, path: string): Promise<GitEntry> {
  try {
    const target = await ctx.fs.resolve(path)
    const info = await ctx.fs.stat(target)
    if (info?.type === 'directory') return { kind: 'directory' }
    if (info?.type !== 'file') return { kind: 'absent' }
    return { kind: 'file', text: await ctx.fs.readText(target) }
  } catch {
    // Any resolve/stat/read failure (absent, denied, unreadable encoding)
    // yields no git identity. Nothing else can reach here: the guard performs
    // no other IO.
    return { kind: 'absent' }
  }
}

/**
 * Branch name from a `HEAD` file's contents. A symbolic ref names a branch; a
 * detached HEAD holds a raw object id and has no branch, which no staging
 * pattern can match.
 */
function branchFromHead(head: string): string | undefined {
  const trimmed = head.trim()
  const ref = 'ref: refs/heads/'
  return trimmed.startsWith(ref) ? trimmed.slice(ref.length) : undefined
}

/**
 * Resolve the git directory a worktree root's `.git` entry designates, plus
 * the shared common directory. A plain clone's `.git` is a directory that is
 * its own common dir; a linked worktree's `.git` is a file pointing into the
 * main repository's `worktrees/<name>`, whose common dir is two levels up.
 * A `gitdir:` pointer may be relative, which git resolves against the worktree
 * directory holding it.
 */
async function resolveGitDir(ctx: Context, root: string): Promise<{ gitDir: string; commonDir: string } | undefined> {
  const dotGit = resolve(root, '.git')
  const entry = await readGitEntry(ctx, dotGit)
  // A plain clone keeps a `.git` DIRECTORY, which is both the git dir and the
  // common dir; a linked worktree keeps a `.git` FILE pointing elsewhere.
  if (entry.kind === 'directory') return { gitDir: dotGit, commonDir: canonicalPath(dotGit) }
  if (entry.kind === 'absent') return undefined
  const prefix = 'gitdir:'
  const trimmed = entry.text.trim()
  if (!trimmed.startsWith(prefix)) return undefined
  const pointer = trimmed.slice(prefix.length).trim()
  if (pointer.length === 0) return undefined
  const gitDir = resolve(root, pointer)
  // `<common>/worktrees/<name>` — the shared repository is two levels up.
  return { gitDir, commonDir: canonicalPath(dirname(dirname(gitDir))) }
}

/**
 * Walk from a path toward the filesystem root and resolve the first enclosing
 * worktree, or `undefined` when the path is inside none.
 */
async function findWorktree(ctx: Context, from: string): Promise<Worktree | undefined> {
  let current = from
  for (;;) {
    const dirs = await resolveGitDir(ctx, current)
    if (dirs !== undefined) {
      const head = await readGitEntry(ctx, resolve(dirs.gitDir, 'HEAD'))
      return {
        branch: head.kind === 'file' ? branchFromHead(head.text) : undefined,
        commonDir: dirs.commonDir,
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * The skill name a `skill` call's raw argument JSON requested, or `undefined`
 * when the JSON is malformed or carries no string `name`. The log stores the
 * model's unparsed argument string, so this is a model-JSON boundary.
 */
function skillNameOf(rawArguments: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    // The model produced argument text that is not JSON; the call cannot have
    // named a skill. Nothing else in this try can throw.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = (parsed as Record<string, unknown>).name
  return typeof value === 'string' ? value : undefined
}

/**
 * Whether the session's durable log records a successful load of
 * `requiredSkill`. Replayed from `tool/call` + `tool/result` pairs, so
 * satisfaction survives a session resume: the log is the only state.
 */
function skillLoaded(session: Session, requiredSkill: string): boolean {
  const requested = new Map<CallId, string>()
  for (const event of session.events) {
    if (event.type === 'tool/call') {
      if (event.data.name === SKILL_TOOL) requested.set(event.data.callId, event.data.arguments)
      continue
    }
    const block = event.type === 'tool/result' ? event.data.message.content[0] : undefined
    if (block === undefined || block.isError === true) continue
    const rawArguments = requested.get(block.toolCallId)
    if (rawArguments !== undefined && skillNameOf(rawArguments) === requiredSkill) return true
  }
  return false
}

/** The denial text a blocked call reports to the model. */
function denialReason(path: string, branch: string, requiredSkill: string): string {
  return `Editing "${path}" directly is not allowed: it is inside the dsh checkout this session is running from, on branch ${branch}. `
    + `Load the ${requiredSkill} skill first and follow it — implement in a task worktree, then integrate under the staging lock.`
}

/**
 * Install the guard's listener.
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 * @param config - validated {@link Config}; re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const requiredSkill = config.requiredSkill as string
  const tools = config.tools as string[]
  if (tools.length === 0) {
    throw new Error('source-guard: `tools` must not be empty')
  }
  if (requiredSkill.trim().length === 0) {
    throw new Error('source-guard: `requiredSkill` must not be blank')
  }
  const gated = new Set(tools)

  const protectedCheckout = config.protectedCheckout as string
  if (!isAbsolute(protectedCheckout)) {
    throw new Error(`source-guard: \`protectedCheckout\` must be an absolute path, got "${protectedCheckout}"`)
  }
  // Resolved once per plugin lifetime: the worktree this guard arms for, which
  // supplies both the protected repository and the protected branch. A harness
  // running from an installed copy resolves a different repository (or none)
  // and therefore guards nothing, which is correct — the rule is meaningless
  // outside a source checkout.
  let protectedRepository: Promise<Worktree | undefined> | undefined

  /** The repository containing {@link Config.protectedCheckout}. */
  function repository(): Promise<Worktree | undefined> {
    protectedRepository ??= findWorktree(ctx, dirname(protectedCheckout))
    return protectedRepository
  }

  // Worktree identity per directory, cached for the plugin's lifetime: a
  // directory's repository and branch are stable in practice, and re-reading
  // git metadata on every write would repeat identical IO. A mid-session
  // branch switch is therefore not observed (see the README).
  const worktrees = new Map<string, Promise<Worktree | undefined>>()

  /** Resolve (and memoize) the worktree enclosing a target path's directory. */
  function worktreeOf(path: string): Promise<Worktree | undefined> {
    const directory = dirname(path)
    let pending = worktrees.get(directory)
    if (pending === undefined) {
      pending = findWorktree(ctx, directory)
      worktrees.set(directory, pending)
    }
    return pending
  }

  /**
   * The target path and the staging branch protecting it, or `undefined` when
   * the call may proceed. Fails open on every unresolvable case: a path outside
   * any worktree, a detached HEAD, a different repository, or unreadable git
   * metadata leaves the call to the rest of the chain, because a guard that
   * blocked writes whenever git identity was unavailable would be worse than
   * the violation it prevents.
   */
  async function protectedTarget(exec: ToolExecution, session: Session): Promise<{ path: string; branch: string } | undefined> {
    if (!gated.has(exec.name)) return undefined
    const path = targetPath(exec.arguments, session.header.cwd)
    if (path === undefined) return undefined
    const launcher = await repository()
    // A detached launcher checkout names no branch to protect, so nothing is.
    if (launcher?.branch === undefined) return undefined
    // Resolution walks OUTWARD from the target, so it reports the INNERMOST
    // enclosing worktree: a task worktree nested under the protected tree
    // answers with its own task branch, which is not the launcher's. That is
    // what keeps the prescribed workflow unblocked.
    const worktree = await worktreeOf(path)
    if (worktree === undefined || worktree.commonDir !== launcher.commonDir) return undefined
    // Only the branch the launcher itself runs from is protected: a stale
    // sibling checkout of the same repository is not the live deployment.
    if (worktree.branch !== launcher.branch) return undefined
    return { path, branch: launcher.branch }
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    // A direct `ctx.tools.execute()` caller has no session to replay and no
    // model to correct; only agent-loop calls are gated.
    if (exec.agent === undefined) return next()
    const { session } = exec.agent
    const target = await protectedTarget(exec, session)
    if (target === undefined) return next()
    if (skillLoaded(session, requiredSkill)) return next()
    return { kind: 'deny', reason: denialReason(target.path, target.branch, requiredSkill) }
  })
}
