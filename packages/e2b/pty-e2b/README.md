# @deepseek-ai/dsh-pty-e2b

English | [中文](README.zh.md)

E2B byte-PTY backend for [`ctx.pty`](../../pty/pty/README.md). It creates persistent interactive shells inside the shared `ctx.e2b` sandbox while the PTY registry keeps session identity, exact-Agent ownership, and cleanup policy on the host.

## Plugin and configuration

The `pty-e2b` plugin injects `e2b` and `pty`, then registers one backend under `backendType`.

| Key | Default | Meaning |
|---|---|---|
| `backendType` | `shell` | Registry type selected by `terminal_open`. |
| `rows` / `cols` | `40` / `160` | Initial remote PTY size. |
| `scrollbackLines` | `10000` | Maximum retained logical lines. |
| `scrollbackMaxBytes` | `4194304` | Maximum retained UTF-8 scrollback bytes. |
| `maxReadBytes` | `262144` | Maximum bytes returned by one read or settled send. |
| `pollIntervalMs` | `50` | Host readiness-poll interval. |
| `idleSilenceMs` | `3000` | Output silence that yields `inferred_idle`. |
| `timeoutMs` | `30000` | Absolute startup and send wait bound. |
| `disposeGraceMs` | `3000` | TERM-to-KILL cleanup grace. |

Numeric values are positive safe integers, `backendType` is non-empty, and `maxReadBytes` cannot exceed `scrollbackMaxBytes`. A relative spawn cwd resolves against `ctx.e2b.cwd`; an absolute remote path remains absolute. Before launch, the backend enumerates sandbox-default environment names, blanks `DSH_*` and credential-shaped names, then overlays its controlled terminal values and explicit `spec.env` entries.

## Runtime contract

The backend uses E2B's byte-oriented PTY callback with a streaming fatal UTF-8 decoder, then the backend-neutral line sanitizer and bounded buffers from `dsh-pty`. It installs a controlled Bash prompt marker and waits for printable prompt text; when that marker is unavailable, observed output plus the configured silence bound yields `inferred_idle`. Startup with no output reaches the absolute timeout and fails instead of publishing an empty session.

Each send writes UTF-8 bytes and an optional carriage-return submit sequence. Cancellation and explicit signals resolve the remote terminal's foreground process group through `ps`, then signal that group; cancellation rechecks the originating send after lookup so a settled operation cannot signal or fail its successor, and `SIGKILL` refuses to target the shell itself. The backend records the terminal's POSIX session id at startup. Close sends `SIGTERM` to every process group still in that session, escalates survivors to `SIGKILL`, verifies that the session is empty, and does not resolve until the SDK handle reports exit. A startup failure closes the unpublished PTY, and `PtyBackendCleanupError` preserves a concurrent cleanup failure.

The remote PTY process and its child processes live in E2B. Prompt/readiness state, scrollback, operation handles, owner authority, and SDK event delivery remain in host memory.

## Model Experience

### Indirect consumer

#### What the model sees

Nothing directly. Through `@deepseek-ai/dsh-tool-pty`, the model may receive bounded MOTD, send deltas, scrollback pages, readiness reasons, signal results, and cleanup failures.

#### Token effect

None until a consumer returns bounded backend output. Retained host PTY scrollback is not placed in model history by this package.

#### KV Cache effect

No direct invalidation; the consumer owns prompts, schemas, and appended results.

## Known Limitations and Deferred Work

- **Line-oriented terminal model** — CSI/OSC control sequences are removed; alternate-screen and full terminal emulation remain unsupported.
- **Readiness is marker-or-silence based** — E2B exposes foreground process groups but not the local backend's Linux syscall inspection, so `inferred_idle` is deliberately possible.
- **UTF-8 only** — invalid byte sequences fail the session instead of returning lossy text.
- **Deliberate session escape is unmanaged** — a process that calls `setsid` leaves the terminal session and is outside this backend's cleanup identity.
- **No reconnectable terminal handles** — retaining an E2B sandbox preserves remote files, not host ownership, buffers, callbacks, or live PTY sessions.
