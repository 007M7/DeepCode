# @deepseek-ai/dsh-subprocess-e2b

English | [中文](README.zh.md)

E2B implementation of the [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) seam. It has no config: load [`@deepseek-ai/dsh-e2b`](../e2b/README.md) first, then this service in place of `dsh-subprocess-local`. Existing consumers such as [`dsh-bash-local`](../../bash/bash-local/README.md) then execute in the shared remote sandbox without an E2B-specific Bash adapter.

## Behavior

- **Asynchronous remote start** — the synchronous seam returns a handle immediately while `Sandbox.commands.run(..., { background: true })` starts remotely. `pid` is `-1` until the SDK returns the command PID; `done`, stdin, termination, and `waitForExit()` wait for readiness internally.
- **Linux process groups** — a quoted wrapper starts each argv under `setsid --wait` and records its actual process-group id plus private status files beneath `ctx.e2b.runtimeRoot/processes`. The handle waits for that file instead of assuming the SDK command PID is the group id. Termination signals the negative recorded id with `SIGTERM`, waits the caller's `graceMs`, then escalates to `SIGKILL` and the SDK kill fallback. Service disposal terminates and joins every retained handle before the sandbox owner disposes.
- **Environment boundary** — the wrapper starts from the sandbox command environment, removes ambient `DSH_*` and credential-shaped (`*KEY*`, `*SECRET*`, `*TOKEN*`) names, then restores every `spec.env` entry as an explicit caller opt-in. Host ambient variables never enter the sandbox implicitly.
- **Stdio projection** — pipe mode forwards E2B callbacks into host Node streams; inherit mode forwards them to the harness process streams; collect mode retains a bounded host tail with offset reads. Optional complete spill files are written remotely and advertised only while within their cap. Batch and streaming stdin use the SDK handle.

The base E2B image supplies the Bash/GNU utilities this adapter invokes: `bash`, `setsid`, `ps`, `tr`, `env`, `chmod`, `tee`, `head`, and `kill`. A custom template must retain compatible commands.

## Model Experience

Indirectly, through consumer seams such as the Bash executor behind `dsh-tool-bash`, which render remote output, exit facts, background deltas, and spill paths.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **The SDK still retains complete command output in host memory** — E2B `CommandHandle.stdout` and `.stderr` accumulate even when this adapter exposes bounded tails, so the subprocess seam's normal host-memory bound is not achieved.
- **Pipe output is not byte-faithful** — E2B delivers separately decoded strings rather than raw bytes, so split multibyte sequences and arbitrary binary protocols can be corrupted; LSP and other framed byte-stream consumers are unsupported.
- **Synchronous-PID consumers are unsupported** — `pid` remains `-1` during remote startup; consumers that require a positive PID immediately, including the ACP child backend, cannot use this provider unchanged.
- **Reconnect does not reconstruct handles** — remote PID/status/spill files survive a retained sandbox, but a new harness process does not rebuild live `SubprocessHandle` objects or output cursors from them.
- **Remote state accumulates when retained** — process directories and valid spill files remain under `.dsh-e2b`; this POC supplies no retention sweep.
- **Signal attribution is inferred** — when termination was requested and E2B reports a nonzero exit code, the adapter reports the last requested signal because the SDK result does not identify the terminating signal.
- **Linux utility and E2B transport semantics are assumed** — there is no PTY, Windows, arbitrary-template, or network-partition fidelity layer.
