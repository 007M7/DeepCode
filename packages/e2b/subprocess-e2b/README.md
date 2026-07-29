# @deepseek-ai/dsh-subprocess-e2b

English | [中文](README.zh.md)

E2B implementation of the [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) seam. It has no config: load [`@deepseek-ai/dsh-e2b`](../e2b/README.md) first, then this service in place of `dsh-subprocess-local`. Existing Bash, PTY, LSP, and subprocess Code Runtime consumers then execute in the shared remote sandbox without E2B-specific capability packages.

## Behavior

- **Asynchronous remote start** — the synchronous seam returns a handle immediately while `Sandbox.commands.run(..., { background: true })` starts remotely. `pid` is `-1` until the wrapper publishes and the adapter validates its process-group id; stdin and ordinary observation wait for that publication, while cancellation can stop the provisional SDK handle first.
- **Execution-world coordinates** — `cwd` and private `runtimeRoot` come from the shared owner; executable lookup verifies absolute paths or resolves a bare name against the sandbox PATH plus explicit overrides.
- **Linux process groups** — a quoted wrapper starts each argv under `exec setsid --wait` and records its actual process-group id plus private status files beneath `ctx.e2b.runtimeRoot/processes`. The handle waits for that file instead of treating the SDK command PID as its published identity. Termination signals the negative recorded id with `SIGTERM`, waits the caller's `graceMs`, then escalates to `SIGKILL` and the SDK kill fallback; TERM delivery or probe failures also force that escalation. Process-table probes treat groups containing only zombie or dead entries as quiescent. A failed transaction is observable through `waitForExit()` and may be retried, while any proven quiescence permanently fences later termination against PID reuse. Before publication, cancellation uses the provisional SDK handle; if publication fails, rollback kills and verifies the provisional group before startup rejects. After publication, a monitoring failure also rolls back the group before rejecting. Service disposal rejects new starts, terminates and joins every retained process group, then awaits SDK settlement and private cleanup before the sandbox owner disposes.
- **Environment boundary** — the wrapper starts from the sandbox command environment, removes ambient `DSH_*` and credential-shaped (`*KEY*`, `*SECRET*`, `*TOKEN*`) names, then restores every valid `spec.env` entry as an explicit caller opt-in; empty names, `=`, and NUL framing violations reject before launch. Host ambient variables never enter the sandbox implicitly. Private environment files are removed after consumption, and failed command or terminal setup removes its private state before rejecting.
- **Stdio projection** — the remote wrapper branches raw bytes into optional bounded spill files, frames each live chunk as newline-delimited base64 ASCII, and the host incrementally restores bytes across arbitrary SDK callback boundaries. Pipe mode writes those bytes to host Node streams; inherit mode writes them to the harness process streams; collect mode retains a bounded host tail with offset reads. The wrapper publishes the direct command status before waiting for inherited writers. For collect or inherit output, the adapter disconnects an incomplete SDK stream after `graceMs`, withholds its partial spill, and returns that status while retaining the remote group for `waitForExit()` and termination; raw pipes instead await lossless transport completion and preserve backpressure. Batch and streaming stdin use the SDK handle.
- **Terminal sessions** — `spawnTerminal()` uses E2B's byte PTY API, installs the exact argv and scrubbed environment through private mode-`0600` files, reports the foreground process group, sends real signals, and tears down every live group in the remote terminal session before settlement; zombie-only groups are already quiescent. A private random output boundary discards the E2B bootstrap shell's prompt and echoed runner command while preserving every requested-process byte, including its first prompt. Setup and teardown own the private state transaction, abort pending setup during service disposal, fence publication, and retain an unproven setup cleanup for disposal retry. Prompt detection, scrollback, readiness, and owner policy remain in `dsh-pty-local`.

The base E2B image supplies the runtime and Bash/GNU utilities this adapter invokes: `node`, `bash`, `setsid`, `ps`, `awk`, `tr`, `env`, `chmod`, `tee`, `head`, `rm`, and `kill`. A custom template must retain compatible commands and E2B PTY support.

## Model Experience

Indirectly, through consumer seams such as the Bash executor behind `dsh-tool-bash`, which render remote output, exit facts, background deltas, and spill paths.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **The SDK still retains complete command output in host memory** — E2B `CommandHandle.stdout` and `.stderr` accumulate the base64 transport even when this adapter exposes bounded raw-byte tails, so the subprocess seam's normal host-memory bound is not achieved and transport retention is larger than the source stream.
- **Synchronous-PID consumers are unsupported** — `pid` remains `-1` during remote startup; consumers that require a positive PID immediately, including the ACP child backend, cannot use this provider unchanged.
- **Reconnect does not reconstruct handles** — remote PID/status/spill files survive a retained sandbox, but a new harness process does not rebuild live `SubprocessHandle` objects or output cursors from them.
- **Remote state accumulates when retained** — process directories and valid spill files remain under `.dsh-e2b`; this POC supplies no retention sweep.
- **E2B exposes no signal fact** — an adapter-requested `SIGTERM` or `SIGKILL` is reported only when no wrapper-published direct exit code wins; every unrequested SDK exit remains an exit code, including values shaped like `128 + signal`.
- **Exact terminal stdin-wait inspection is unavailable** — E2B exposes the foreground process group but not the syscall evidence needed to prove it is waiting on fd 0, so the generic PTY backend falls back to controlled prompt markers and bounded silence.
- **Linux utility and E2B transport semantics are assumed** — there is no Windows, arbitrary-template, escaped-session recovery, or network-partition fidelity layer.
