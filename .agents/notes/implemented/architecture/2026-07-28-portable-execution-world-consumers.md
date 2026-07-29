# Agent Note: Portable consumers over filesystem and subprocess execution worlds

Status: implemented

English | [中文](2026-07-28-portable-execution-world-consumers.zh.md)

## Problem

The filesystem and subprocess seams made file and ordinary process access replaceable, but several higher capabilities still reached host Node APIs directly. A remote execution provider therefore appeared to need separate PTY, LSP, and Code Runtime packages even though their domain behavior did not change. Those packages would be shallow adapters: each would duplicate an existing consumer merely to replace its file and process operations.

Ordinary pipes do not cover one requirement. A persistent terminal needs PTY allocation, foreground-process-group inspection and signalling, and cleanup of the complete terminal session. Pretending those operations can be rebuilt in `dsh-pty-local` from an ordinary `spawn()` handle would either leak provider internals or weaken its lifecycle contract.

## Decision

`ctx.fs` and `ctx.subprocess` together define one execution world. Providers mounted together must describe the same path namespace, executables, processes, and terminal sessions; higher capabilities consume those two interfaces rather than name the provider.

The filesystem interface owns the path facts that another capability needs without exposing its opaque target identity: a canonical process path, canonical `file:` URI, and containment. Existing whole and streaming text operations remain filesystem-owned; protocol consumers enforce their own retention limits while consuming the stream.

The subprocess interface owns the process coordinates and primitives: canonical cwd, private runtime storage, executable lookup, ordinary raw or collected process spawning, and `spawnTerminal()`. The terminal operation is one deep primitive whose handle owns text I/O, foreground groups, signalling, and one awaited TERM-to-KILL operation that settles in-flight handle calls and reaches quiescence for every session member the provider can still observe. Its signal cancels allocation only; the published handle owns its lifetime. Prompt detection, idle inference, scrollback, sandbox policy, and owner lifecycle remain in the PTY consumer.

Generic consumers use that execution world:

- `dsh-bash-local` continues to map Bash semantics onto ordinary `ctx.subprocess.spawn()`.
- `dsh-lsp-local` reads and contains source through `ctx.fs`, resolves and launches language servers through `ctx.subprocess`, and carries provider-owned file URIs through initialization and result rendering. One provider-lifetime signal aborts filesystem and protocol work during disposal, including workspace lookup before queue ownership; its JSON-RPC, pooling, synchronization, and normalization stay unchanged.
- `dsh-pty-local` maps persistent-shell semantics onto `ctx.subprocess.spawnTerminal()`. The local `node-pty` and process-inspection implementation moves into `dsh-subprocess-local`; another subprocess provider supplies the same primitive. `danger-full-access` needs no `ctx.sandbox`; a confined mode requires a same-world sandbox provider and fails before spawn when none is mounted. Prompt and silence evidence collected during asynchronous pre-write inspection is discarded when the provider write begins. Cancellation retains the send reservation while an in-flight write settles and then signals the foreground group, so late bytes or the signal cannot target a successor; an in-flight readiness poll cannot release that reservation, and a rejected write sends no signal. The absolute deadline remains armed throughout cancellation. A signal failure becomes terminal transport failure. Completion of a stale inspection resumes polling for the current send. Startup cancellation begins terminal rollback without waiting for a stalled readiness or signalling call. Close rejects new public signals and delegates provider-observable session quiescence to the handle's awaited termination operation.
- `dsh-code-runtime-subprocess` passes a bundled dependency-free eval runner directly to `ctx.subprocess`, preserving the Code Runtime binding and output contract across local or remote process worlds without a filesystem dependency or provider-specific package. It shares host-side worker mechanics through the non-plugin `dsh-code-runtime-worker/runtime-host` subpath instead of copying them. The heap-bounded worker rejects oversized binding frames before transfer, each outer hop enforces the same bound before forwarding, and raw subprocess pipes carry newline-delimited UTF-8 JSON without a redundant base64 representation. The launcher publishes an accepted terminal frame before reaping its controller so a descendant that inherits controller pipes cannot suppress completion; the host still awaits process-group quiescence.

`dsh-code-runtime-worker` remains a separate implementation. It is the smaller in-process backend and works in single-file distributions that cannot assume an installed Node executable. Remote filesystem/process compositions select `dsh-code-runtime-subprocess`; they do not need a provider-specific Code Runtime package.

## Alternatives considered

**Keep one PTY, LSP, and Code Runtime package per remote provider.** Rejected because provider mechanics would be repeated above the existing seams. The deletion test exposes the problem: deleting those adapters should not scatter domain behavior into the remote provider; the generic consumers already own it.

**Model a terminal as an ordinary piped subprocess.** Rejected because pipes cannot allocate a controlling terminal, resolve the current foreground process group, or prove complete terminal-session cleanup. One terminal primitive is smaller and more honest than exposing substrate-specific escape hatches.

**Move PTY readiness and session policy into the subprocess service.** Rejected because those are persistent-terminal consumer semantics, not OS process mechanics. A subprocess provider owns what only its substrate can do; `dsh-pty-local` owns what a Harness terminal means.

**Expose separate terminal termination and quiescence operations plus a shared lifecycle controller.** Rejected because every terminal consumer needs the same single cleanup outcome. Separate operations export provider bookkeeping, bounded-observer, and retry semantics without a production consumer; one awaited provider operation is a deeper interface.

**Add a stable bounded-read primitive to the filesystem seam.** Rejected because only LSP needs a complete-document byte ceiling, which it can enforce while consuming the existing text stream. A second primitive forces every provider to implement stable-handle and no-follow mechanics, including a remote helper protocol, without an observed concurrent-replacement defect.

**Delete the worker-thread Code Runtime.** Rejected because portability does not erase its current deployment need. The subprocess backend requires a Node executable; the worker backend does not and remains the supported single-process path.

**Run the whole harness inside the remote environment.** Rejected as a different deployment model. Making execution capabilities portable does not move model calls, session state, plugin state, or the agent loop.

## Consequences

A remote execution provider implements only its shared sandbox owner plus filesystem and subprocess adapters. Bash, PTY, LSP, and subprocess Code Runtime compose above them, so fixes to those capabilities remain provider-neutral.

The fundamental interfaces are wider, and a filesystem/subprocess pair must agree on one execution world. The added operations are limited to facts and lifecycle mechanics that current generic consumers require; model schemas, protocol framing, readiness policy, and presentation do not leak into the providers.

The local implementation absorbs `node-pty` and platform process inspection because it owns local terminal mechanics. This moves code without weakening terminal teardown: disposal sweeps descendants before and after terminating the top-level shell, waits for exact PID-identity-fenced descendants retained during foreground inspection, and retains Linux session members that survive top-level exit. macOS cannot enumerate a POSIX session after its leader exits, so a child that reparents between inspection snapshots remains an explicit local-provider limitation rather than a reason to move process mechanics back into the PTY consumer.
