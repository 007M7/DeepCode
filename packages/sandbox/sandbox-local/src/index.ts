/**
 * Local sandbox backend. It selects the platform runner chain (Linux bwrap then
 * Landlock; macOS Seatbelt; Windows the ACL restricted-token runner), functionally probes
 * competing candidates once, and reports each wrap's enforcement and stderr
 * classification facts. Missing or unusable confinement fails closed rather
 * than returning the original argv.
 *
 * The windows-acl rung additionally owns the write grants: the write SID is
 * the per-WORKSPACE identity derived from the canonical workspace path
 * (`workspaceWriteSid`), and one private temp subdirectory per session
 * (durable record in the session log — see `./acl-session.ts`). The
 * workspace-root ACE materializes once per workspace per server lifetime
 * and STANDS (the cross-session reuse cache — the exact-ACE skip makes
 * every later provision O(1) instead of re-propagating the tree per
 * session); the private-temp ACEs are revoked on dispose. The runner
 * receives `--write-sid` (the derived identity; its presence marks the
 * seam-managed contract) and stops managing DACLs itself.
 * @module @deepseek-ai/dsh-sandbox-local
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  LAUNCHER_BIN,
  LAUNCHER_FAILURE_EXIT,
  launcherPath as landlockLauncherPath,
  probe as defaultProbeLandlock,
} from '@deepseek-ai/node-addon-landlock-run'
import { Context } from 'cordis'
import z from 'schemastery'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, ConfinedSandboxMode, RunnerFailureRule, SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AclWriteGrant, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { provisionAclSession, sessionAclRecord } from './acl-session.ts'
import type { AclSessionRecord } from './acl-session.ts'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from './profiles.ts'

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * Override the runner argv; bwrap-shaped profile arguments are appended. A
   * non-empty override asserts full enforcement and skips built-in selection and
   * probing. A runner that starts but refuses its profile must be identifiable by
   * {@link runnerFailureSignatures}. Consumers classify spawn rejection; only
   * attributable `ENOENT` or `EACCES` with runner argv[0] provenance becomes an
   * infrastructure failure.
   */
  runnerCommand?: string[]
  /**
   * Case-insensitive stderr substrings emitted when a configured
   * {@link runnerCommand} refuses its profile before executing the wrapped
   * command. Required and non-empty with `runnerCommand`; rejected without
   * it. Each entry is a non-empty, single-line, case-insensitive substring
   * covering the executable runner's own failure dialect.
   */
  runnerFailureSignatures?: string[]
  /** Positive timeout for each functional probe; zero would mean unbounded to Node. */
  probeTimeoutMs?: number
}

/** Probe whether `bwrap` can create the profile; the provider caches the bounded result. */
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

/**
 * Functional windows-acl probe: run the runner in read-only mode (zero grants,
 * no ACL mutation) around `cmd /c exit 0` — exit 0 means the runner created
 * the restricted token and spawned the child under it. The win32 chain is a
 * sole candidate, so the product never probes; the probe exists for override
 * chains and mirrors the other rungs' shape.
 */
function defaultProbeWindowsAcl(runnerInvocation: string[], timeoutMs: number): boolean {
  const program = runnerInvocation[0]
  if (program === undefined) return false
  const probe = spawnSync(program, [
    ...runnerInvocation.slice(1),
    '--workspace', tmpdir(), '--temp', tmpdir(), '--mode', 'read-only',
    '--', 'cmd', '/c', 'exit', '0',
  ], {
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
  /** Replaces the resolved windows-acl runner argv prefix (a fake runner). */
  windowsAclRunnerArgs?: string[]
  /** Replaces the resolved windows-acl runner built entry path (a fake lib/runner.js location). */
  windowsAclRunnerEntry?: string
  /** Replaces the functional windows-acl probe (the win32 chain's sole rung — only consulted if that chain ever grows). */
  probeWindowsAcl?: () => boolean
}

/** The chain's verdict: which runner confines, and how completely it enforces. */
type SelectedRunner = { runner: 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl'; enforcement: SandboxEnforcement }

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
  // The Windows restricted-token runner (@deepseek-ai/dsh-sandbox-windows-acl):
  // a sole candidate, selected without a probe — its execution-time refusal
  // fails closed through its stderr signature (windows-acl-run:) and exit 127.
  win32: ['windows-acl'],
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
  // 'full' is the SUPPORTED-SURFACE promise: on NTFS both restricting lists
  // close every ambient write (INTERACTIVE/LOCAL and Authenticated Users are
  // absent from both — pinned by the runner's Public-probe and CIM-denial
  // regressions). FAT-class (non-ACL) targets are declared unsupported
  // (warn-only) in the backend README — outside the promise, not an
  // exception to it.
  'windows-acl': 'full',
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
 * The denial dialect each runner's kernel speaks — the case-insensitive stderr substrings a
 * denied file effect produces under it, carried on every wrap (the seam's
 * `ConfinedArgv.denialSignatures`).
 */
const DENIAL_SIGNATURES = {
  bwrap: ['read-only file system'],
  landlock: ['permission denied'],
  seatbelt: ['operation not permitted'],
  // pwsh/.NET: "Access to the path '...' is denied."; cmd: "Access is denied.";
  // node EACCES: "permission denied".
  'windows-acl': ['access is denied', 'access to the path', 'permission denied'],
  runnerCommand: ['read-only file system', 'permission denied'],
} as const satisfies Record<SelectedRunner['runner'] | 'runnerCommand', readonly string[]>

/** The windows-acl runner's documented failure exit (its own RUNNER_FAILURE_EXIT contract, distinct from Landlock's 125). */
const WINDOWS_ACL_RUNNER_FAILURE_EXIT = 127

/**
 * Runner-owned fatal diagnostics. Landlock has a versioned exit-125 plus
 * fatal-line launcher-failure contract. Bubblewrap's current fatal paths exit
 * 1 but its public contract does not reserve that status, while sandbox-exec
 * publishes no launcher-failure status; those backends remain signature-only.
 * The windows-acl runner prints `windows-acl-run: <detail>` on every
 * runner-side failure and exits 127 — the rule is exit-gated on that status
 * so a confined command that merely PRINTS the signature (or a runner
 * cleanup failure reported on a non-zero child exit) is never misclassified
 * as "the command did not run". Keep the Landlock tuple aligned with the
 * assembled snapshot fixture at
 * `examples/acp-agent/tests/fixtures/partial-landlock-sandbox.ts`.
 */
const RUNNER_FAILURE_RULES = {
  bwrap: [{ fatalSignatures: ['bwrap: '] }],
  landlock: [{
    allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
    fatalSignatures: [`${LAUNCHER_BIN}: `],
    informationalLines: [`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`],
  }],
  seatbelt: [{ fatalSignatures: ['sandbox-exec: '] }],
  'windows-acl': [{ allowedExitCodes: [WINDOWS_ACL_RUNNER_FAILURE_EXIT], fatalSignatures: ['windows-acl-run: '] }],
} as const satisfies Record<SelectedRunner['runner'], readonly RunnerFailureRule[]>

/**
 * Local process-sandbox provider. Registers as `ctx.sandbox`. Caches the
 * chain verdict and, on the windows-acl rung, the write grants
 * ({@link AclWriteGrant}: the standing workspace-root grant per workspace
 * and the revocable private-temp grant per session, the latter revoked on
 * provider dispose); the one-time probes spawn nothing else.
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
  /**
   * Server-lifetime write grants (windows-acl rung): the STANDING
   * workspace-root grant per workspace (its ACE is the cross-session reuse
   * cache and outlives the provider — never revoked) and the REVOCABLE
   * private-temp grant per session (revoked on provider dispose); the
   * durable half (workspace binding + private temp dir) lives in the
   * session log (`./acl-session.ts`).
   */
  private readonly workspaceGrants = new Map<string, AclWriteGrant>()
  private readonly tempGrants = new Map<string, AclWriteGrant>()

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
    if (runnerFailureSignatures.some(signature => signature.trim().length === 0 || /[\r\n]/u.test(signature))) {
      throw new Error('sandbox-local: runnerFailureSignatures entries must be non-empty single-line strings')
    }
    this.runnerCommand = runner.length > 0 ? runner : undefined
    this.configuredRunnerFailureSignatures = runnerFailureSignatures
    this.probeTimeoutMs = config.probeTimeoutMs as number
    assertPositiveFinite('probeTimeoutMs', this.probeTimeoutMs)
    // The temp grants are revoked with the provider: a clean server
    // shutdown leaves no temp ACEs behind (workspace ACEs stand by design —
    // the reuse cache; an unclean shutdown leaves them for the next
    // provision's exact-ACE skip).
    ctx.effect(() => () => {
      this.revokeAclGrants()
    })
  }

  /**
   * Wrap `argv` in the selected runner's invocation for `policy` — the configured
   * `runnerCommand` when present (the operator's assertion, no probe), else the platform
   * chain's runner speaking its own profile dialect.
   *
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @returns the wrapped argv plus the selected backend's enforcement completeness, denial
   *   signatures, and structured runner-failure rules; throws the fail-closed
   *   `SANDBOX_UNAVAILABLE` error when the platform has no usable runner.
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    if (this.runnerCommand !== undefined) {
      return {
        argv: [...this.runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv],
        enforcement: 'full',
        denialSignatures: DENIAL_SIGNATURES.runnerCommand,
        runnerFailureRules: [{ fatalSignatures: this.configuredRunnerFailureSignatures }],
      }
    }
    const selected = this.selectRunner(policy.mode)
    const runnerArgv = this.runnerArgv(selected.runner, policy)
    return {
      argv: [...runnerArgv, '--', ...argv],
      enforcement: selected.enforcement,
      denialSignatures: DENIAL_SIGNATURES[selected.runner],
      runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
    }
  }

  /** The selected rung's runner invocation (program + profile arguments) for one policy. */
  private runnerArgv(runner: SelectedRunner['runner'], policy: SandboxPolicy): string[] {
    switch (runner) {
      case 'bwrap': return ['bwrap', ...bwrapProfileArgs(policy)]
      case 'landlock': return [this.landlockLauncher(), ...landlockProfileArgs(policy)]
      case 'seatbelt': return [this.seatbeltExec(), ...seatbeltProfileArgs(policy)]
      case 'windows-acl': return this.windowsAclRunnerArgv(policy)
      default: return assertNever(runner)
    }
  }

  /**
   * The windows-acl runner argv for one policy. With a calling session
   * (the policy's `sessionId`), the session's durable record is folded from
   * the session log (provisioned on first use), its ACEs materialized once
   * per server lifetime, and the runner receives `--write-sid` plus the
   * session's PRIVATE temp subdirectory — it grants nothing and revokes
   * nothing. A fresh provision kicks an IMMEDIATE persistence flush right
   * after the append (no write-behind debounce delay), narrowing the
   * crash-and-lose-record window to the flush latency itself — the residual
   * is documented in the README (the spawn seams are synchronous, so no
   * await barrier exists between record and ACEs). Agentless calls (no
   * session) pass no SID: the runner self-manages per-call grants on the
   * ambient temp root.
   * @param policy - the resolved per-call policy.
   * @returns the runner invocation.
   */
  private windowsAclRunnerArgv(policy: SandboxPolicy): string[] {
    const sessionId = policy.sessionId
    if (sessionId === undefined) {
      return [
        ...this.windowsAclRunnerInvocation(),
        '--workspace', policy.workspaceRoot,
        '--temp', tmpdir(),
        '--mode', policy.mode,
      ]
    }
    const record = this.aclSessionRecord(sessionId, policy.workspaceRoot)
    this.materializeAclGrant(record, policy.mode)
    return [
      ...this.windowsAclRunnerInvocation(),
      '--workspace', policy.workspaceRoot,
      // Workspace-write sessions confine their temp writes to the PRIVATE
      // per-session subdirectory (bwrap --tmpfs /tmp semantics); read-only
      // runs pass the ambient temp root — the runner validates it exists
      // but grants nothing. The derived write SID is the per-workspace
      // identity; the flag's presence marks the seam-managed DACL contract.
      '--temp', policy.mode === 'workspace-write' ? record.tempDir : tmpdir(),
      '--mode', policy.mode,
      '--write-sid', workspaceWriteSid(record.workspace),
    ]
  }

  /**
   * Fold (or provision) the calling session's durable windows-acl record.
   * The provision appends exactly one log-only `sandbox/acl-session` event
   * to the session log and kicks an immediate persistence flush (the
   * write-behind coordinator's bounded window would otherwise delay the
   * record's durability past its ACE materialization); the record's
   * workspace must equal the policy root — both derive from the session's
   * immutable cwd, so a mismatch is a corrupted composition and fails loud.
   * @param sessionId - the policy's calling-session identity.
   * @param workspaceRoot - the resolved policy root.
   * @returns the session's record.
   */
  private aclSessionRecord(sessionId: SessionId, workspaceRoot: string): AclSessionRecord {
    const store = this.ctx.get('sessions')
    if (store === undefined) {
      throw new Error('sandbox-local: per-session windows-acl confinement requires the session store (ctx.sessions)')
    }
    const session = store.get(sessionId)
    if (session === undefined) {
      throw new Error(`sandbox-local: windows-acl policy carries session "${sessionId}" but ctx.sessions has no such session`)
    }
    const existing = sessionAclRecord(session.events, sessionId)
    if (existing !== undefined) {
      if (existing.workspace !== workspaceRoot) {
        throw new Error(
          `sandbox-local: session "${sessionId}" acl record workspace ${JSON.stringify(existing.workspace)} `
          + `does not match the resolved policy root ${JSON.stringify(workspaceRoot)} (session cwd is immutable)`,
        )
      }
      return existing
    }
    const record = provisionAclSession(session, workspaceRoot)
    // Immediate durability kick: the append is write-behind (bounded
    // coordinator window); flush now so the record is durable as close to
    // its ACE materialization as the synchronous confine seam allows. The
    // residual window (a crash inside the flush latency) strands the
    // private temp directory unrecorded — documented in the README.
    void store.flush(session)
    return record
  }

  /**
   * Materialize the record's ACEs once per server lifetime: lazily at the
   * session's first confined execution, reused for every later call (the map
   * hits are the whole call). The write SID is the per-workspace identity
   * derived from the record's workspace. Workspace-write grants the
   * workspace root STANDING (the ACE outlives every session — the reuse
   * cache) and the private temp subdirectory REVOCABLY — created here
   * EXCLUSIVELY (the name is random and unguessable, a pre-existing entry
   * throws EEXIST, and a reparse point is rejected, so the grant never
   * lands on an attacker-placed object); read-only materializes NOTHING —
   * its token alone restricts every write, and the standing grant from an
   * earlier workspace-write period is KEPT through a downgrade (never
   * revoked): the read-only restricted token carries no write SID (the
   * read-only list), so the ACE is inert there, while the map hit keeps the
   * re-upgrade free of re-propagation. Fail-closed: a half-materialized
   * temp grant is revoked before the error propagates.
   * @param record - the session's durable record.
   * @param mode - the policy mode (grants exist only under workspace-write).
   */
  private materializeAclGrant(record: AclSessionRecord, mode: ConfinedSandboxMode): void {
    if (mode === 'read-only') return
    const writeSid = workspaceWriteSid(record.workspace)
    if (!this.workspaceGrants.has(record.workspace)) {
      const grant = AclWriteGrant.create(writeSid)
      try {
        grant.add(record.workspace, true)
      } catch (error) {
        // Free the SID; a standing ACE (if the apply succeeded before a
        // post-apply throw) is the intended end state, not an error
        // artifact — nothing to revoke.
        try {
          grant.dispose()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'sandbox-local windows-acl workspace grant failed and its cleanup also failed')
        }
        throw error
      }
      this.workspaceGrants.set(record.workspace, grant)
    }
    if (this.tempGrants.has(record.sessionId)) return
    const grant = AclWriteGrant.create(writeSid)
    try {
      // Exclusive creation (no `recursive`): a pre-existing entry OR a
      // reparse point both fail EEXIST — the grant never lands on a foreign
      // object.
      mkdirSync(record.tempDir)
      grant.add(record.tempDir)
    } catch (error) {
      // Revoke whatever stands and free the SID — never leave a half-grant
      // behind a failed confine (the runner never runs).
      try {
        grant.dispose()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'sandbox-local windows-acl temp grant materialization failed and its cleanup also failed')
      }
      throw error
    }
    this.tempGrants.set(record.sessionId, grant)
  }

  /**
   * Dispose every write grant (provider dispose): the revocable temp ACEs
   * are revoked and every SID allocation freed; the standing workspace ACEs
   * stay (the reuse cache). Cleanup failures are reported, not thrown:
   * cordis teardown must not be aborted by grant cleanup, and the durable
   * records make a missed revocation self-healing on the next resume.
   */
  private revokeAclGrants(): void {
    if (this.workspaceGrants.size === 0 && this.tempGrants.size === 0) return
    const failures: unknown[] = []
    for (const grant of [...this.workspaceGrants.values(), ...this.tempGrants.values()]) {
      try {
        grant.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    this.workspaceGrants.clear()
    this.tempGrants.clear()
    if (failures.length > 0) {
      this.ctx.logger.warn(`sandbox-local: windows-acl grant cleanup completed with ${failures.length} failure(s)`)
      for (const error of failures) this.ctx.logger.warn(error)
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
    // A sole candidate needs no arbitration; its execution-time refusal still fails closed.
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
      case 'windows-acl': {
        const probe = this.internals.probeWindowsAcl
          ?? (() => defaultProbeWindowsAcl(this.windowsAclRunnerInvocation(), this.probeTimeoutMs))
        return probe() ? 'full' : 'unusable'
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

  /**
   * The windows-acl runner argv prefix: the built lib/runner.js entry when
   * present (production), else the package source through tsx (development).
   * The prefix stays `[node, runner, ...]` — a future native-exe runner keeps
   * the same argv contract and only swaps these entries.
   */
  private windowsAclRunnerInvocation(): string[] {
    const override = this.internals.windowsAclRunnerArgs
    if (override !== undefined) return override
    const builtEntry = this.internals.windowsAclRunnerEntry ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
    if (existsSync(builtEntry)) return [process.execPath, builtEntry]
    const sourceEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts'))
    return [process.execPath, '--import', 'tsx/esm', sourceEntry]
  }
}

export default LocalSandboxProvider
