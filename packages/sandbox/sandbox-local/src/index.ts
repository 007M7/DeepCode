/**
 * `LocalSandboxProvider`: the local implementation of the
 * `@deepseek-ai/dsh-sandbox` seam. Wraps a caller's argv in a platform
 * confinement runner selected BY PLATFORM: each platform names its runner
 * chain ({@link PLATFORM_CHAINS}), a chain of one is selected directly (no
 * probe — there is nothing to arbitrate), and a chain of several is probed
 * FUNCTIONALLY in preference order (build and enforce a real profile once,
 * not `--version`), the verdict cached for the provider's lifetime. Linux:
 * `bwrap`, else the `landlock-run` Landlock launcher (kernel confinement
 * that needs no userns/mount privileges; distributed as the npm package
 * family `node-addon-landlock-run` — the decision recorded in
 * docs/rfc/implemented/feature/2026-07-06-sandbox.md); darwin: macOS
 * `sandbox-exec` speaking a Seatbelt (SBPL) profile, unprobed.
 * When the platform has no chain or no candidate passes,
 * {@link LocalSandboxProvider.confine} FAILS CLOSED with the seam's
 * structured `SANDBOX_UNAVAILABLE` error instead of passing the argv
 * through unconfined; an unusable runner selected WITHOUT a probe fails
 * closed at execution time instead (it refuses to run the command), which
 * the wrap's `runnerFailureSignatures` let consumers classify as a sandbox
 * failure rather than a task failure.
 *
 * @module @deepseek-ai/dsh-sandbox-local
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { grantArgs as landlockGrantArgs, LAUNCHER_BIN, launcherPath as landlockLauncherPath, probe as defaultProbeLandlock } from 'node-addon-landlock-run'
import { Context } from 'cordis'
import z from 'schemastery'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, ConfinedSandboxMode, SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * Override the sandbox runner argv (the bwrap-shaped profile arguments are
   * appended). A NON-EMPTY argv is the operator's assertion that this runner
   * exists and FULLY enforces the profile (confinement reports
   * `enforcement: 'full'`, and — the runner's kernel mechanism being unknown
   * — carries both Linux file-denial dialects as its denial signatures) —
   * the runner chain and its probes are skipped,
   * and a broken runner fails loudly at execution time. The operator also
   * supplies {@link runnerFailureSignatures}, which distinguish the runner
   * refusing its profile from the wrapped command failing normally.
   * Absent (or empty — the schema normalizes an omitted array to `[]`): the
   * built-in platform chains — Linux `bwrap` then the Landlock launcher
   * (probed in that order), darwin `sandbox-exec` (the sole candidate,
   * selected without a probe). Used for custom/alternative runners and
   * for deterministic fake runners in keyless test tiers.
   */
  runnerCommand?: string[]
  /**
   * Case-insensitive stderr substrings emitted when a configured
   * {@link runnerCommand} refuses its profile before executing the wrapped
   * command. Required and non-empty with `runnerCommand`; rejected without
   * it. Missing/unexecutable runner errors are added automatically from
   * `runnerCommand[0]`, while these signatures cover an executable runner's
   * own failure dialect.
   */
  runnerFailureSignatures?: string[]
  /**
   * Per-probe timeout in milliseconds for the chain's functional probes
   * (default: 5000; must be a positive finite number — Node treats a 0
   * `spawnSync` timeout as UNBOUNDED, so 0 is rejected at construction). A
   * probe that exceeds it reads as an unusable rung, so a
   * host slow enough to trip the default — cold NFS mounts, heavily loaded
   * CI — would otherwise be misclassified `SANDBOX_UNAVAILABLE` with no
   * config escape. Bounds ONE probe, and the chain walk runs each at most once
   * per provider lifetime.
   */
  probeTimeoutMs?: number
}

/**
 * The `bwrap` profile arguments for one policy. The whole host tree is bound
 * read-only; a fresh `/dev` keeps `>/dev/null` redirects working and a fresh
 * `/proc` keeps process-inspecting tools working. `workspace-write`
 * additionally mounts an ephemeral writable `/tmp` and rebinds the workspace
 * root read-write (bind order matters: later binds overlay earlier ones).
 * Deliberately NO `--unshare-pid` (it would break the process-group kill
 * semantics shell consumers rely on) and NO network unsharing (the seam's
 * mode vocabulary promises file effects only).
 * @param policy - the file-effect policy to express as bwrap arguments.
 * @returns the bwrap profile arguments (before the trailing `--` + argv).
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * The `landlock-run` grant arguments for one policy — the bwrap
 * profile's file-effect semantics expressed as a Landlock allow-list
 * (Landlock cannot mount, so there are no fresh/ephemeral filesystems). The
 * whole tree is readable and executable; of `/dev`, ONLY `/dev/null` is
 * writable — a whole-`/dev` grant would expose real host paths beneath it
 * (`/dev/shm`, a shared tmpfs) to persistent writes, which `read-only`
 * promises never happen. bwrap can hand out a fresh ephemeral `/dev`; on the
 * host's own `/dev` the write grant must be node-by-node, and `>/dev/null`
 * is the one redirects need. `workspace-write` adds the HOST `/tmp` (shared
 * and persistent, where bwrap's is ephemeral — the honest difference,
 * recorded in the sandbox RFC's runner notes) plus the workspace
 * root read-write. The flag spelling belongs to `node-addon-landlock-run`'s
 * `grantArgs`; this function owns only the policy → grants mapping.
 * @param policy - the file-effect policy to express as launcher grants.
 * @returns the launcher grant arguments (before `--` + argv).
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/**
 * Resolve a granted root to the path the kernel actually sees. Seatbelt path
 * filters match the CANONICAL path (symlinks resolved), and the roots this
 * profile grants are symlinked on every macOS: `/tmp` is `/private/tmp` and
 * the user temp dir lives under `/var` → `/private/var` — an as-spelled
 * grant would match nothing.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // realpathSync failed: the path (or a prefix) is missing or unreadable.
    // Grant the spelling as-is — an unresolvable root matches nothing until
    // it exists, which is the conservative outcome, and inventing a fallback
    // resolution here would grant a path the caller never named.
    return path
  }
}

/** Quote one path as an SBPL string literal (backslashes and double quotes escaped). */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * The `sandbox-exec` arguments for one policy: `-p` plus a Seatbelt (SBPL)
 * profile with the same file-effect semantics as the other dialects, built
 * as allow-default → `(deny file-write*)` → write allow-list (later rules
 * win), so exactly the mode's promised file effects are governed — network
 * and process visibility stay unrestricted, which is all the seam's mode
 * vocabulary claims. Of `/dev`, ONLY the `/dev/null` literal is writable
 * (the same node-not-directory reasoning as the Landlock grant).
 * `workspace-write` adds the workspace root, the host `/tmp`, and the
 * per-user darwin temp dir (`os.tmpdir()`, launchd's `TMPDIR`, inherited by
 * the confined child) — on darwin that directory IS the platform's `/tmp`
 * for every mkstemp-family tool, so omitting it would deny the mode's
 * promised temp area. All granted roots are canonicalized because Seatbelt
 * matches resolved paths ({@link canonicalPath}); duplicates after
 * resolution collapse.
 * @param policy - the file-effect policy to express as an SBPL profile.
 * @returns the `sandbox-exec` arguments (`-p` + profile, before `--` + argv).
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  if (policy.mode === 'workspace-write') {
    const roots = [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}

/**
 * Functional `bwrap` probe: can it actually build the read-only profile on
 * this host? (`--version` alone would miss a disabled unprivileged user
 * namespace.) Synchronous by design — it runs once, lazily, before the first
 * confined wrap, and the chain's verdict is cached for the provider's
 * lifetime. `timeoutMs` bounds the probe (the `probeTimeoutMs` config).
 * The Landlock rung needs no such helper: resolution (`launcherPath`) and
 * the functional probe (`probe`) come from `node-addon-landlock-run`, the
 * package family that ships the launcher binary itself, so the probe-report
 * parsing can never drift against the binary.
 */
function defaultProbeBwrap(timeoutMs: number): boolean {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--', 'true'], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/**
 * Functional Seatbelt probe: apply the real `read-only` profile through
 * `sandbox-exec -p` and run `true` under it — exit 0 means the kernel
 * accepted and enforced the profile (`sandbox-exec` exits non-zero when
 * `sandbox_init` refuses it). A missing `sandbox-exec` (every non-macOS
 * host) fails the spawn and probes `unusable`, exactly like the other
 * rungs' absent binaries. Apple marks the CLI deprecated but ships it on
 * every macOS; if it ever disappears, this probe is what fails closed.
 */
function defaultProbeSeatbelt(seatbeltExec: string, timeoutMs: number): boolean {
  const probe = spawnSync(seatbeltExec, [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/** Test seam: inject probe verdicts / a fake launcher / a platform without real runners. */
export interface SandboxInternals {
  /** Replaces `process.platform` for chain selection (exercise any platform's chain from any host). */
  platform?: string
  /** Replaces the platform's chain wholesale (walk mechanics — e.g. probing a rung the product chains only reach unprobed). */
  chain?: readonly SelectedRunner['runner'][]
  /** Replaces the functional `bwrap` probe (the Linux chain's first rung). */
  probeBwrap?: () => boolean
  /** Replaces the functional Landlock launcher probe (the Linux chain's second rung). */
  probeLandlock?: (launcher: string) => SandboxEnforcement | 'unusable'
  /** Replaces the functional Seatbelt probe (the darwin chain's sole rung — only consulted if that chain ever grows). */
  probeSeatbelt?: (seatbeltExec: string) => boolean
  /** Replaces the resolved `landlock-run` launcher path (a fake launcher script). */
  landlockLauncher?: string
  /** Replaces the `sandbox-exec` executable the probe and wraps invoke (a fake script). */
  seatbeltExec?: string
}

/** The chain's verdict: which runner confines, and how completely it enforces. */
type SelectedRunner = { runner: 'bwrap' | 'landlock' | 'seatbelt'; enforcement: SandboxEnforcement }

/**
 * The runner chain per platform — selection is BY PLATFORM first, probes
 * second: a platform's chain is probed in preference order only when it has
 * MORE than one candidate (probing arbitrates; it does not re-validate a
 * choice that has no alternative). A platform with no chain fails closed at
 * `confine()`. Linux prefers `bwrap` (its mount profile is closest to the
 * mode vocabulary) over the Landlock launcher; darwin has exactly one
 * candidate, selected without any probe.
 */
const PLATFORM_CHAINS: Record<string, readonly SelectedRunner['runner'][]> = {
  linux: ['bwrap', 'landlock'],
  darwin: ['seatbelt'],
  // Reserved slot, deliberately empty: Windows support fills it with a
  // confinement runner (AppContainer / restricted-token family, shipped from
  // its own repository on the landlock-run template) plus a
  // SelectedRunner['runner'] union member — the switches' assertNever guards
  // then walk the implementer to every site. An empty chain fails closed at
  // confine(), identical to an unlisted platform: reserving the slot never
  // weakens the fail-closed end.
  win32: [],
}

/**
 * Enforcement completeness a rung claims when selected WITHOUT a probe (a
 * chain of one). `bwrap` and Seatbelt govern every promised file effect by
 * construction, so the claim is a profile fact; `landlock` is listed for the
 * table's totality but is unreachable unprobed today (the Linux chain has
 * two rungs, so it is only ever selected through its probe, whose report is
 * what distinguishes full from per-ABI-partial — and the launcher additionally
 * self-reports partial enforcement on stderr at every confined run).
 */
const STATIC_ENFORCEMENT: Record<SelectedRunner['runner'], SandboxEnforcement> = {
  bwrap: 'full',
  landlock: 'full',
  seatbelt: 'full',
}

/**
 * A probe bound must be a positive finite number: Node treats
 * `spawnSync({ timeout: 0 })` as NO timeout, so an unvalidated 0 would
 * silently mean "unbounded" — the opposite of what the field promises.
 */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`sandbox-local: ${name} must be a positive finite number`)
  }
}

/**
 * The denial dialect each runner's kernel speaks — the case-insensitive
 * stderr substrings a denied file effect produces under it, carried on every
 * wrap (the seam's `ConfinedArgv.denialSignatures`). Kernel facts, not
 * tunables: bwrap denies through its read-only bind mounts (EROFS), Landlock
 * refuses with EACCES, Seatbelt with EPERM — whose text is also what
 * non-file EPERM boundaries print, the residual imprecision the consumer's
 * conservative classifier documents. An operator-configured `runnerCommand`
 * has an unknown kernel mechanism, so its wraps carry both Linux file-denial
 * dialects; bare EPERM stays excluded there (it names non-file boundaries
 * the mode vocabulary does not govern).
 */
const DENIAL_SIGNATURES = {
  bwrap: ['read-only file system'],
  landlock: ['permission denied'],
  seatbelt: ['operation not permitted'],
  runnerCommand: ['read-only file system', 'permission denied'],
} as const satisfies Record<SelectedRunner['runner'] | 'runnerCommand', readonly string[]>

/**
 * How each runner's OWN failure identifies itself on stderr (the seam's
 * `ConfinedArgv.runnerFailureSignatures`): every runner prefixes its error
 * lines with its program name, and the shell's runner-not-found message
 * carries the same `name: ` shape (`bash: bwrap: command not found`,
 * `bash: …/bin/landlock-run: No such file or directory`) — so one substring
 * per runner covers both "runner broke" and "runner missing". Consumers
 * match these BEFORE the denial dialect: a runner's error text can contain
 * denial words (an unopenable grant root reports `Permission denied`), and
 * a runner failure means the command never ran at all.
 */
const RUNNER_FAILURE_SIGNATURES = {
  bwrap: ['bwrap: '],
  landlock: [`${LAUNCHER_BIN}: `],
  seatbelt: ['sandbox-exec: '],
} as const satisfies Record<SelectedRunner['runner'], readonly string[]>

/**
 * Local process-sandbox provider. Registers as `ctx.sandbox`. Stateless
 * apart from the cached chain verdict — it spawns nothing but the one-time
 * probes, so there is no disposal work beyond cordis' own.
 */
export class LocalSandboxProvider extends SandboxProvider {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    runnerCommand: z.array(z.string()).default([]),
    runnerFailureSignatures: z.array(z.string()).default([]),
    probeTimeoutMs: z.natural().default(5_000),
  })

  /** Test seam (mirrors the bash executors' `internals`). */
  internals: SandboxInternals = {}

  private readonly runnerCommand: string[] | undefined
  private readonly configuredRunnerFailureSignatures: string[]
  private readonly probeTimeoutMs: number
  /** Cached chain verdict; undefined until the first confined wrap needs it. */
  private selectedRunner: SelectedRunner | 'unavailable' | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // The schema (static Config) defaults every field — the casts record
    // those runtime facts. An empty runnerCommand means "not configured":
    // use the platform chain.
    const runner = config.runnerCommand as string[]
    const runnerFailureSignatures = config.runnerFailureSignatures as string[]
    if (runner.length === 0 && runnerFailureSignatures.length > 0) {
      throw new Error('sandbox-local: runnerFailureSignatures requires runnerCommand')
    }
    if (runner.length > 0 && runnerFailureSignatures.length === 0) {
      throw new Error('sandbox-local: runnerCommand requires at least one runnerFailureSignatures entry')
    }
    if (runnerFailureSignatures.some(signature => signature.trim().length === 0)) {
      throw new Error('sandbox-local: runnerFailureSignatures entries must be non-empty')
    }
    this.runnerCommand = runner.length > 0 ? runner : undefined
    this.configuredRunnerFailureSignatures = runnerFailureSignatures
    this.probeTimeoutMs = config.probeTimeoutMs as number
    assertPositiveFinite('probeTimeoutMs', this.probeTimeoutMs)
  }

  /**
   * Wrap `argv` in the selected runner's invocation for `policy` — the
   * configured `runnerCommand` when present (the operator's assertion, no
   * probe), else the platform chain's runner speaking its own profile
   * dialect. Every wrap carries the runner's enforcement completeness, its
   * denial dialect, and its runner-failure signatures.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @returns the wrapped argv plus the selected backend's enforcement
   *   completeness, denial signatures, and runner-failure signatures;
   *   throws the fail-closed `SANDBOX_UNAVAILABLE` error when the platform
   *   has no usable runner.
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    if (this.runnerCommand !== undefined) {
      const argv0 = this.runnerCommand[0] as string
      return {
        argv: [...this.runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv],
        enforcement: 'full',
        denialSignatures: DENIAL_SIGNATURES.runnerCommand,
        // The operator names the configured runner's OWN pre-exec refusal
        // dialect; the consumer additionally re-joins the wrap through an
        // outer `bash -c 'exec …'`, so we can add the missing/unexecutable
        // outer-shell shapes ourselves. Scoping every automatic shape to
        // argv0 keeps in-command errors out (a bare `exec:`/`Permission
        // denied` prefix would claim tool output; `exec: <argv0>: not found`
        // cannot). The residual text-collision trade is documented by the
        // seam's conservative classifier contract.
        runnerFailureSignatures: [
          ...this.configuredRunnerFailureSignatures,
          `exec: ${argv0}: not found`,
          `${argv0}: No such file or directory`,
          `${argv0}: Permission denied`,
        ],
      }
    }
    const selected = this.selectRunner(policy.mode)
    return {
      argv: [...this.runnerArgv(selected.runner, policy), '--', ...argv],
      enforcement: selected.enforcement,
      denialSignatures: DENIAL_SIGNATURES[selected.runner],
      runnerFailureSignatures: RUNNER_FAILURE_SIGNATURES[selected.runner],
    }
  }

  /** The selected rung's runner invocation (program + profile arguments) for one policy. */
  private runnerArgv(runner: SelectedRunner['runner'], policy: SandboxPolicy): string[] {
    switch (runner) {
      case 'bwrap': return ['bwrap', ...bwrapProfileArgs(policy)]
      case 'landlock': return [this.landlockLauncher(), ...landlockProfileArgs(policy)]
      case 'seatbelt': return [this.seatbeltExec(), ...seatbeltProfileArgs(policy)]
      default: return assertNever(runner)
    }
  }

  /**
   * Resolve which runner confines commands, once, for the provider's
   * lifetime: this platform's chain ({@link PLATFORM_CHAINS}), its sole
   * candidate selected directly, multiple candidates arbitrated by
   * functional probes in chain order. Fail closed when the platform has no
   * chain or no candidate passes — the command never runs.
   */
  private selectRunner(mode: ConfinedSandboxMode): SelectedRunner {
    this.selectedRunner ??= this.chainVerdict()
    if (this.selectedRunner === 'unavailable') throw new SandboxUnavailableError(mode)
    return this.selectedRunner
  }

  /** Walk this platform's chain: sole candidate unprobed, several probed in order, none usable → unavailable. */
  private chainVerdict(): SelectedRunner | 'unavailable' {
    const chain = this.internals.chain ?? PLATFORM_CHAINS[this.internals.platform ?? process.platform] ?? []
    const [first, ...rest] = chain
    if (first === undefined) return 'unavailable'
    // One candidate = nothing to arbitrate: select it without probing. Its
    // runner fails closed at EXECUTION time if unusable (refuses to run the
    // command), and the wrap's runnerFailureSignatures let the consumer
    // classify that as a sandbox failure — never a silent unconfined run,
    // never a plain task failure.
    if (rest.length === 0) return { runner: first, enforcement: STATIC_ENFORCEMENT[first] }
    for (const runner of chain) {
      const enforcement = this.probeRunner(runner)
      if (enforcement !== 'unusable') return { runner, enforcement }
    }
    return 'unavailable'
  }

  /** One rung's functional probe (each at most once, via the chain walk). */
  private probeRunner(runner: SelectedRunner['runner']): SandboxEnforcement | 'unusable' {
    // bwrap's mount profile and Seatbelt's deny-file-write* profile govern
    // every promised file effect by construction, so their passing probes
    // are always full enforcement; only the Landlock launcher's probe report
    // distinguishes full from per-ABI-partial.
    switch (runner) {
      case 'bwrap': {
        const probe = this.internals.probeBwrap ?? (() => defaultProbeBwrap(this.probeTimeoutMs))
        return probe() ? 'full' : 'unusable'
      }
      case 'landlock': {
        const probe = this.internals.probeLandlock ?? (launcher => defaultProbeLandlock(launcher, { timeoutMs: this.probeTimeoutMs }))
        return probe(this.landlockLauncher())
      }
      case 'seatbelt': {
        const probe = this.internals.probeSeatbelt ?? (exec => defaultProbeSeatbelt(exec, this.probeTimeoutMs))
        return probe(this.seatbeltExec()) ? 'full' : 'unusable'
      }
      default: return assertNever(runner)
    }
  }

  /** The Landlock launcher to probe and exec (test seam over the resolved one). */
  private landlockLauncher(): string {
    return this.internals.landlockLauncher ?? landlockLauncherPath()
  }

  /** The `sandbox-exec` executable to probe and exec (test seam over the system one). */
  private seatbeltExec(): string {
    return this.internals.seatbeltExec ?? 'sandbox-exec'
  }
}

export default LocalSandboxProvider
