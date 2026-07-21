# @deepseek-ai/dsh-pty-local

Local `node-pty` backend for `ctx.pty`. It starts an interactive shell under the shared `ctx.sandboxPolicy`, strips credential-shaped ambient environment variables, retains bounded line-oriented output, detects readiness, and tears down the captured process tree rooted at the `node-pty` child.

## Plugin (`pty-local`)

The plugin injects `pty`, `sandbox`, and `sandboxPolicy`, then registers the configured backend type (`shell`). `danger-full-access` starts the shell directly; confined modes wrap the exact shell argv through `ctx.sandbox`. The current session-level sandbox override is resolved at spawn and remains fixed for the PTY lifetime.

Linux readiness combines a foreground-verified private bash prompt marker, foreground-process-group syscall inspection, silence fallback, and absolute timeout. macOS uses the verified prompt marker plus silence/timeout because it has no `/proc` syscall surface. Unrecognized or unreadable process state is never a positive exact-idle signal. During unpublished startup, a fallback requires observed output; zero-output silence cannot publish an empty session, and timeout rejects the spawn. Incomplete terminal-control sequences are bounded by `maxReadBytes` and discarded through their terminator after crossing that limit.

## Model Experience

### Indirect consumer

#### What the model sees

Nothing directly. Through `@deepseek-ai/dsh-tool-pty`, the model may receive bounded MOTD, send deltas, scrollback pages, readiness reasons, and cleanup errors.

#### Token effect

None until a consumer returns bounded backend output. Retained PTY scrollback is not placed in model history by this package.

#### KV Cache effect

No direct invalidation; the consumer owns prompts, schemas, and appended results.

## Known Limitations and Deferred Work

- Line-oriented output is normalized; full-screen alternate-buffer interaction is unsupported.
- Linux exact probes support x64 and arm64 UAPI tables; other architectures use prompt-marker and silence/timeout readiness.
- A descendant that daemonizes and reparents before teardown leaves the captured tree; cleanup never broadens to the launcher PID's POSIX session because that can include unrelated processes.
- Sessions do not survive harness process exit.
