# Process Sandbox

The process-sandbox seam of [dsh-sandbox](../../packages/sandbox/sandbox) wraps a same-world subprocess argv in a file-effect policy without coupling consumers to a platform runner. [dsh-sandbox-local](../../packages/sandbox/sandbox-local) supplies the Linux bwrap/Landlock and macOS Seatbelt backends; [dsh-bash-sandbox](../../packages/bash/bash-sandbox) is the first consumer. Containers, microVMs, and remote execution are sibling implementations of whole capability seams, not providers of `ctx.sandbox`.

Source: [`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

## Modes and enforcement

`SandboxMode` governs filesystem effects only. `read-only` denies writes except the required `/dev/null` sink; `workspace-write` permits writes under the workspace root and the backend's promised temp area; `danger-full-access` bypasses confinement. Network and process visibility are outside this vocabulary.

```ts type-equiv
/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace and a
 * backend-defined temp area; `danger-full-access` bypasses confinement. Network
 * and process visibility are outside this vocabulary.
 */
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

Only the first two modes can be sent to a provider. A `danger-full-access` consumer spawns its original argv and does not call `ctx.sandbox`.

```ts type-equiv
/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

Enforcement is a reported fact. `full` means the backend governs every file effect promised by the mode; `partial` means an active backend or older kernel ABI governs only a subset, so consumers that require the absolute promise must reject or surface that distinction.

```ts type-equiv
/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
type SandboxEnforcement = 'full' | 'partial'
```

## Per-call policy

The policy is fully resolved and carried per call. This permits concurrent consumers and one-shot escalated retries to ask the same provider for different boundaries without mutating provider state.

```ts type-equiv
/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is the consumer's
 * explicit step (its config owns the fallback chain); the provider treats
 * the policy as fully specified.
 */
interface SandboxPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
}
```

## Wrapped argv and classification dialects

`ConfinedArgv` is what the consumer spawns. Besides the replacement argv, it carries the backend's enforcement fact and two orthogonal stderr dialects. `denialSignatures` identify the confined command being blocked while the sandbox works correctly. `runnerFailureSignatures` identify the sandbox runner refusing or failing before it executes the command; consumers check these first and surface a sandbox infrastructure failure, never an ordinary task failure.

```ts type-equiv
/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * The selected backend's denial DIALECT: the case-insensitive stderr
   * substrings a file effect denied by THIS backend produces (EROFS text
   * under bwrap's read-only binds, EACCES under Landlock, EPERM under
   * Seatbelt). A consumer that infers denials from a failed run's stderr
   * matches against exactly these rather than a cross-backend union — the
   * union claims denials a given backend never produces.
   */
  denialSignatures: readonly string[]
  /**
   * Case-insensitive signatures for runner failure before command execution.
   * Consumers check these before denial signatures: runner failure means the
   * command never ran, while denial means confinement worked and blocked it.
   */
  runnerFailureSignatures: readonly string[]
}
```

An operator-configured local runner must supply at least one `runnerFailureSignatures` entry for its own pre-exec refusal dialect; the provider adds outer-shell missing and unexecutable forms automatically. This makes an executable custom runner rejecting its profile distinguishable from the wrapped command exiting with the same status.

## Provider and fail-closed errors

`ctx.sandbox.confine(argv, policy)` returns a `ConfinedArgv` or throws `SandboxUnavailableError` with code `SANDBOX_UNAVAILABLE` when no usable backend exists. A selected runner can also fail closed at execution time, in which case its failure signature carries the same infrastructure meaning. Silent unconfined passthrough is never legal for a confined policy.

Provider probing arbitrates between multiple candidates and is cached for the provider lifetime. A platform with one candidate may select it directly; execution-time refusal retains the safety property. The local provider reports bwrap and Seatbelt as full and preserves the Landlock launcher's full/partial kernel verdict.
