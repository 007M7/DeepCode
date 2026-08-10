/**
 * The windows-acl confinement runner: the argv-prefix wrapper the sandbox
 * seam spawns in place of the caller's command. It creates the
 * WRITE_RESTRICTED token with the workspace write-SID allowlist, spawns the
 * wrapped argv under it with the CALLER'S stdio inherited (bytes flow
 * straight through), mirrors the child's exit code, and revokes its temp
 * grant on exit (workspace ACEs stay standing as the reuse cache).
 *
 * Stable argv contract (the seam builds it; a native-exe replacement would
 * keep the same contract):
 *   [node, runner.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write>,
 *    ['--write-sid', <S-1-4-…>], '--', <argv...>]
 *
 * Modes:
 *  - workspace-write: the workspace and temp directories carry the orphan-SID
 *    Write grant; other ACL-addressable writes are denied except for the
 *    documented Everyone and hard-link boundaries.
 *  - read-only: no orphan-SID grants; the restricting list carries no orphan
 *    SID, so a standing grant ACE from an earlier
 *    workspace-write period stays inert. BOTH modes drop Authenticated Users
 *    (CIM unavailable — documented in README) and INTERACTIVE/LOCAL (the
 *    Public tree writes are denied); the two lists share the keep-alive group
 *    (logon SID, EVERYONE) and differ only by the orphan.
 *
 * `--write-sid`: the seam's grant contract — the CALLER has already
 * materialized the write-SID ACEs (the seam's workspace + private-temp
 * grants, server lifetime) and owns their revocation, so the runner neither
 * grants nor revokes (manageDacls: false). The carried SID is the
 * per-workspace identity ({@link workspaceWriteSid}) — the seam derives it
 * from the policy root; the flag's PRESENCE is the seam-managed marker (its
 * value must equal the workspace-derived SID). Absent `--write-sid`
 * (standalone/test use) the runner self-manages grants per invocation with
 * the same workspace-derived SID (its workspace ACEs are standing — the
 * reuse cache — and its temp ACE is revoked on exit). With `--write-sid` in
 * workspace-write mode, the runner rewrites the TMP/TEMP entries of its OWN
 * environment (SetEnvironmentVariableW) to the `--temp` directory — a
 * PRIVATE per-session temp subdirectory the seam provisions (bwrap `--tmpfs
 * /tmp` semantics) — and the child inherits the rewritten block (lpEnvironment
 * NULL; an explicit block through koffi trips ERROR_INVALID_PARAMETER in
 * CreateProcessAsUserW, verified empirically). Read-only leaves the ambient
 * temp entries untouched (writes there are denied anyway).
 *
 * Failure contract: every runner-side failure (bad args, missing
 * directories, token/grant/spawn errors) prints `windows-acl-run: <detail>`
 * to stderr and exits 127 — the seam's RUNNER_FAILURE_RULES matches that
 * signature. The child is NEVER spawned unrestricted.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/runner
 */

import { existsSync, statSync } from 'node:fs'

import { win32 } from './ffi.ts'
import { AclSandbox } from './index.ts'
import { workspaceWriteSid } from './workspace-sid.ts'

const RUNNER_SIGNATURE = 'windows-acl-run'
const RUNNER_FAILURE_EXIT = 127

class RunnerFailure extends Error {}

/** Print the runner-failure signature line and unwind. */
function fail(detail: string): never {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`)
  throw new RunnerFailure(detail)
}

interface ParsedArgs {
  workspace: string
  temp: string
  mode: 'read-only' | 'workspace-write'
  writeSid: string | undefined
  command: string
  args: string[]
}

function parseArgs(raw: string[]): ParsedArgs {
  let workspace: string | undefined
  let temp: string | undefined
  let mode: string | undefined
  let writeSid: string | undefined
  let index = 0
  for (; index < raw.length; index++) {
    const token = raw[index]
    if (token === '--') {
      index++
      break
    }
    index++
    const value = raw[index]
    if (value === undefined) fail(`missing value after ${token}`)
    switch (token) {
      case '--workspace': workspace = value; break
      case '--temp': temp = value; break
      case '--mode': mode = value; break
      case '--write-sid': writeSid = value; break
      default: fail(`unknown argument: ${token}`)
    }
  }
  if (workspace === undefined) fail('missing --workspace')
  if (temp === undefined) fail('missing --temp')
  if (mode !== 'read-only' && mode !== 'workspace-write') fail(`unknown mode: ${String(mode)}`)
  const argv = raw.slice(index)
  const command = argv[0]
  if (command === undefined) fail('missing command after --')
  return { workspace, temp, mode, writeSid, command, args: argv.slice(1) }
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`)
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  // Both directories are validated in both modes: a provider bug that passes
  // a bogus root must fail loudly at the runner boundary, never mid-child.
  requireDirectory('--workspace', parsed.workspace)
  requireDirectory('--temp', parsed.temp)

  const api = await win32()
  // Ignore this process's own CTRL+C: the confined child (same console) keeps
  // handling its own; the runner must survive to revoke grants and mirror the
  // child's exit code.
  if (api.setConsoleCtrlHandler(null, 1) === 0) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`)
  }

  // The write SID is the per-workspace identity in BOTH flows; the flag's
  // presence (seam-derived, or the self-managed derivation) selects who
  // owns the DACLs below.
  const writeSid = parsed.mode === 'workspace-write' ? parsed.writeSid ?? workspaceWriteSid(parsed.workspace) : undefined
  const sandbox = new AclSandbox({
    writableDirs: parsed.mode === 'workspace-write' ? [parsed.workspace] : [],
    tempDir: parsed.mode === 'workspace-write' ? parsed.temp : null,
    mode: parsed.mode,
    ...writeSid === undefined ? {} : { writeSid },
    // With --write-sid the seam owns the DACLs (workspace + private-temp
    // grants): this invocation must neither add nor revoke ACEs.
    manageDacls: parsed.writeSid === undefined,
  })
  await sandbox.init()

  // The seam's per-session temp contract: under --write-sid, workspace-write
  // children see the PRIVATE per-session temp subdirectory through TMP/TEMP
  // (bwrap --tmpfs /tmp semantics). The runner rewrites its OWN environment
  // (SetEnvironmentVariableW) and the child inherits the block; self-managed
  // and read-only runs keep the ambient entries.
  if (parsed.mode === 'workspace-write' && parsed.writeSid !== undefined) {
    if (api.setEnvironmentVariableW('TMP', parsed.temp) === 0) {
      fail(`SetEnvironmentVariableW TMP failed (Win32 ${api.getLastError()})`)
    }
    if (api.setEnvironmentVariableW('TEMP', parsed.temp) === 0) {
      fail(`SetEnvironmentVariableW TEMP failed (Win32 ${api.getLastError()})`)
    }
  }

  try {
    const child = sandbox.spawn({
      command: parsed.command,
      args: parsed.args,
      stdio: 'inherit',
    })
    const result = await child.wait()
    return result.exitCode
  } finally {
    // Cleanup failures must not mask the child's exit code: report and keep going.
    try {
      sandbox.dispose()
    } catch (error) {
      process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

main().then(
  (exitCode) => {
    // Exit-code mirroring is full-width on Windows, verified empirically on
    // this machine (Windows 11 build 26200, Node 24): a child that exits
    // with the NTSTATUS 0xC0000005 (STATUS_ACCESS_VIOLATION) is read back
    // by GetExitCodeProcess as the uint32 3221225477, and after
    // process.exitCode = 3221225477 the parent observes exactly
    // 3221225477 (spawnSync status). PowerShell's $LASTEXITCODE and cmd
    // print the signed view (-1073741819), but no truncation or masking
    // happens anywhere in the chain — the mirror contract holds for the
    // full 32-bit range, so no re-mapping is needed.
    process.exitCode = exitCode
  },
  (error: unknown) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(`${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = RUNNER_FAILURE_EXIT
  },
)
