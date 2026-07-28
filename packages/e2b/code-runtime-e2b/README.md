# @deepseek-ai/dsh-code-runtime-e2b

English | [中文](README.zh.md)

E2B implementation of [`ctx.codeRuntime`](../../code-runtime/code-runtime/README.md). Each run executes one model-written TypeScript program in a fresh remote Node worker while binding functions, type stripping, output accounting, and lifecycle orchestration remain on the host.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `computeMs` | `60000` | Remote worker event-loop busy-time budget. |
| `maxWallMs` | `600000` | Host-observed wall-clock ceiling. |
| `maxOutputBytes` | `67108864` | Combined serialized outer logs/value/diagnostic cap. |
| `maxOldGenerationSizeMb` | `512` | Remote worker old-generation heap cap in MiB. |
| `maxFrameBytes` | `268435456` | Largest decoded bridge frame, including binding traffic. |
| `killGraceMs` | `2000` | Remote process-group TERM-to-KILL grace. |

Every value is a positive safe integer. `maxOutputBytes` is at least four bytes, `maxWallMs` cannot exceed Node's maximum timer delay, and `maxFrameBytes` cannot be smaller than `maxOutputBytes`. The service requires the concrete `dsh-subprocess-e2b` backend so run cleanup has remote process-group semantics.

## Execution and bridge contract

Setup uploads one dependency-free runner under `ctx.e2b.runtimeRoot` and resolves remote Node. For each run, the host wraps and type-strips erasable TypeScript with Node's `stripTypeScriptTypes`, then starts the runner in `ctx.e2b.cwd`. The runner creates a fresh worker thread with an empty environment and heap limit, measures active event-loop time, and destroys that worker after one completion. The enclosing E2B subprocess group is terminated and awaited after every result, timeout, abort, or disposal, so ordinary child processes in that group stop with the run.

The bridge uses validated newline-delimited base64 JSON frames because E2B subprocess callbacks expose decoded text. Binding arguments and resolutions use the worker runtime's iterative lossless-JSON wire shape; binding functions execute on the host and typed rejection classes are materialized inside the remote worker. The worker captures the JavaScript intrinsics that its adapter boundary invokes before model code runs, hardening binding transport, output accounting, and completion validation against mutation of those references. The host repeats message validation, call-id deduplication, lossless-JSON checks, and the outer-output ledger.

Program failures resolve as `CodeRunResult.error`; only seam misuse rejects. `isolation` is reported as `container`, which is a deployment descriptor rather than a security claim.

## Model Experience

Indirectly, through Code Mode in `dsh-tools`, which returns program logs, values, or typed failures through the existing `run_code` result contract.

#### KV Cache effect

No direct invalidation; Code Mode owns request-prefix changes.

## Known Limitations and Deferred Work

- **Not a whole-agent runtime** — Cordis, sessions, LLM calls, binding dispatch, TypeScript stripping, output ledgers, and E2B SDK state remain on the host.
- **No reconnectable runs** — retaining a sandbox preserves files but not worker/subprocess handles, binding calls, timers, or output cursors.
- **Node worker internals share the model realm** — mutating realm-wide globals or prototypes that Node itself uses can terminate the worker; captured adapter intrinsics are not a separate JavaScript realm or a security boundary.
- **Deliberate process-group escape is not captured** — model code can create a new POSIX session; that unmanaged process is outside this backend's cleanup identity.
- **Intermediate binding traffic is memory-bounded only per frame** — it does not enter model context or the outer-output ledger, but aggregate host/remote process memory remains the limit.
- **Experimental type stripping** — the backend shares the worker implementation's reliance on Node's experimental erasable-syntax API.
- **Sandbox policy is template-owned** — this package adds no network, volume, snapshot, or workspace-synchronization policy.
