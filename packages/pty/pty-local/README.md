# @deepseek-ai/dsh-pty-local

English | [中文](README.zh.md)

Persistent shell backend for `ctx.pty` over `ctx.subprocess.spawnTerminal`. It starts an interactive shell under the shared `ctx.sandboxPolicy`, retains bounded line-oriented output, and detects readiness while the subprocess provider owns PTY allocation, environment scrubbing, foreground process groups, signalling, and complete terminal-session cleanup. The same PTY backend therefore composes with local or remote execution-world providers.

## Plugin (`pty-local`)

The plugin injects `pty`, `sandbox`, `sandboxPolicy`, and `subprocess`, then registers the configured backend type (`shell`). `danger-full-access` starts the shell directly; confined modes wrap the exact shell argv through `ctx.sandbox`. The effective session mode is resolved at spawn. A change to a different effective mode is rejected before its `sandbox/mode` event commits while that owner has an open PTY or a spawn in progress; the fence is attached to the exact owner and therefore outlives a provider reload that retains existing sessions. Wait for creation to settle and close the sessions before changing modes, so a terminal opened with wider access cannot survive a downgrade.

Readiness combines a foreground-verified private bash prompt marker, provider-reported foreground stdin-wait facts, silence fallback, and absolute timeout. A marker is not ready until the printable tail after the latest owned marker exactly equals the controlled `PS1`, including when the OSC marker and prompt are split across data callbacks; echoed input or output following a delayed earlier prompt therefore cannot settle the current send. Prompt and silence evidence collected before the provider write, including while pre-write foreground inspection is pending, is discarded at the write boundary. When bash prints the marker before the terminal provider publishes its return to the foreground process group, polling retains the candidate for `handoffGraceMs` past the ordinary silence bound so a coincident handoff can win. An interactive child that inherits `PROMPT_COMMAND` therefore cannot suppress inferred-idle readiness until the absolute timeout. Unknown foreground state is never a positive exact-idle signal. A foreground group's stdin wait that existed before a send is likewise not post-write readiness: the same group must be observed outside that wait before a later wait can settle the send, while a changed foreground group is new evidence. During unpublished startup, a fallback requires observed output; zero-output silence cannot publish an empty session, and timeout rejects the spawn. Cancellation closes the unpublished shell and rejects with the caller's exact abort reason; `PtyBackendCleanupError` separately preserves a cleanup failure. The terminal-allocation signal is detached when allocation returns, while readiness initialization keeps the setup signal, so later cancellation cannot terminate a published persistent session. Incomplete terminal-control sequences are bounded by `maxReadBytes` and discarded through their terminator after crossing that limit; a trailing carriage return is carried across callbacks so split CRLF becomes one newline.

Send cancellation marks queued input as canceled before asking the terminal handle to signal the current foreground process group with a real `SIGINT`; if asynchronous pre-write inspection later settles, it cannot execute that input. The canceled send retains its slot until foreground signalling settles, so a successor cannot become that signal's target. Cancellation never emulates interruption by writing `\x03`, so raw-mode programs remain cancellable. A send that times out during an asynchronous provider write, or whose cancellation signal fails while that write remains pending, reports its result but retains the slot until the write settles, so late bytes cannot interleave with a successor. Close starts provider-owned TERM-to-KILL whole-session cleanup and awaits quiescence after the terminal outcome. A cleanup failure does not cache a permanently rejected close; a later close retries the provider operation.

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
- Exact stdin-wait detection depends on the mounted subprocess provider; providers that cannot prove it use prompt-marker and silence/timeout readiness.
- Cleanup guarantees are those of `SubprocessTerminalHandle`; provider-specific gaps belong to that implementation's contract rather than this PTY consumer.
- Sessions do not survive harness process exit.
