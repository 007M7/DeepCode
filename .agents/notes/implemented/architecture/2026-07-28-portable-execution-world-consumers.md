# Agent Note: Portable consumers over filesystem and subprocess execution worlds

Status: implemented

English | [中文](2026-07-28-portable-execution-world-consumers.zh.md)

## Problem

The filesystem and subprocess seams made file and ordinary process access replaceable, but several higher capabilities still reached host Node APIs directly. A remote execution provider therefore appeared to need separate PTY, LSP, and Code Runtime packages even though their domain behavior did not change. Those packages would be shallow adapters: each would duplicate an existing consumer merely to replace its file and process operations.

Ordinary pipes do not cover one requirement. A persistent terminal needs PTY allocation, foreground-process-group inspection and signalling, and cleanup of the complete terminal session. Pretending those operations can be rebuilt in `dsh-pty-local` from an ordinary `spawn()` handle would either leak provider internals or weaken its lifecycle contract.

## Decision

`ctx.fs` and `ctx.subprocess` together define one execution world. Providers mounted together must describe the same path namespace, executables, processes, and terminal sessions; higher capabilities consume those two interfaces rather than name the provider.

The filesystem interface owns the path facts that another capability needs without exposing its opaque target identity: a canonical process path, canonical `file:` URI, containment, and a bounded stable-handle text read. The existing text and mutation operations remain filesystem-owned.

The subprocess interface owns the process coordinates and primitives: canonical cwd, private runtime storage, executable lookup, ordinary raw or collected process spawning, and `spawnTerminal()`. The terminal operation is one deep primitive whose handle owns byte I/O, foreground groups, signalling, TERM-to-KILL session cleanup, and a quiescence wait. Prompt detection, idle inference, scrollback, sandbox policy, and owner lifecycle remain in the PTY consumer.

Generic consumers use that execution world:

- `dsh-bash-local` continues to map Bash semantics onto ordinary `ctx.subprocess.spawn()`.
- `dsh-lsp-local` reads and contains source through `ctx.fs`, resolves and launches language servers through `ctx.subprocess`, and sends provider-owned file URIs. Its JSON-RPC, pooling, synchronization, cancellation, and normalization stay unchanged.
- `dsh-pty-local` maps persistent-shell semantics onto `ctx.subprocess.spawnTerminal()`. The local `node-pty` and process-inspection implementation moves into `dsh-subprocess-local`; another subprocess provider supplies the same primitive. A timed-out asynchronous write retains the send reservation until the provider settles it, and completion of a stale inspection resumes polling for the current send.
- `dsh-code-runtime-subprocess` materializes a dependency-free runner through `ctx.fs` and launches it through `ctx.subprocess`, preserving the Code Runtime binding and output contract across local or remote worlds. It shares host-side worker mechanics through the non-plugin `dsh-code-runtime-worker/runtime-host` subpath instead of copying them. The heap-bounded worker rejects oversized binding frames before transfer, each outer hop enforces the same bound before serialization, and the launcher publishes an accepted terminal frame before reaping its controller so a descendant that inherits controller pipes cannot suppress completion; the host still awaits process-group quiescence.

`dsh-code-runtime-worker` remains a separate implementation. It is the smaller in-process backend and works in single-file distributions that cannot assume an installed Node executable. Remote filesystem/process compositions select `dsh-code-runtime-subprocess`; they do not need a provider-specific Code Runtime package.

## Alternatives considered

**Keep one PTY, LSP, and Code Runtime package per remote provider.** Rejected because provider mechanics would be repeated above the existing seams. The deletion test exposes the problem: deleting those adapters should not scatter domain behavior into the remote provider; the generic consumers already own it.

**Model a terminal as an ordinary piped subprocess.** Rejected because pipes cannot allocate a controlling terminal, resolve the current foreground process group, or prove complete terminal-session cleanup. One terminal primitive is smaller and more honest than exposing substrate-specific escape hatches.

**Move PTY readiness and session policy into the subprocess service.** Rejected because those are persistent-terminal consumer semantics, not OS process mechanics. A subprocess provider owns what only its substrate can do; `dsh-pty-local` owns what a Harness terminal means.

**Delete the worker-thread Code Runtime.** Rejected because portability does not erase its current deployment need. The subprocess backend requires a Node executable and filesystem materialization; the worker backend has neither requirement and remains the supported single-process path.

**Run the whole harness inside the remote environment.** Rejected as a different deployment model. Making execution capabilities portable does not move model calls, session state, plugin state, or the agent loop.

## Consequences

A remote execution provider implements only its shared sandbox owner plus filesystem and subprocess adapters. Bash, PTY, LSP, and subprocess Code Runtime compose above them, so fixes to those capabilities remain provider-neutral.

The fundamental interfaces are wider, and a filesystem/subprocess pair must agree on one execution world. The added operations are limited to facts and lifecycle mechanics that current generic consumers require; model schemas, protocol framing, readiness policy, and presentation do not leak into the providers.

The local implementation absorbs `node-pty` and platform process inspection because it owns local terminal mechanics. This moves code without weakening terminal teardown: disposal still waits for exact PID-identity-fenced descendants and the top-level terminal process to reach quiescence.
