# RFC: Rich ACP bash rendering — the terminal card via the `_meta` convention

Status: implemented

## Problem

The ACP bridge lets each tool own its call rendering via `presentCall`/`presentResult` (see [tool-call UI presentation](../proposed/2026-06-14-acp-agent-client-protocol.md) and `packages/tools`). For `bash` we surface the model's `description` plus the command as the `tool_call` title, `kind: 'execute'`, and the completed output wrapped in a fenced ` ```console ` text block.

That is a correct, capability-free baseline, but not how the reference editors render a *terminal* tool at its best. An editor like Zed has a dedicated terminal tool-call card — a header showing the working directory, the command as the label, and the command output rendered as a terminal — but it only builds that card when the `tool_call` carries terminal metadata (below). With a plain text block the output appears as static markdown and there is no cwd header. (Zed also HIDES `rawInput` for `kind: 'execute'`, which is why our command rides inside the title.)

## Key finding: agent-executed terminals use a `_meta` convention, NOT `terminal/create`

The ACP spec has a *client-side* terminal sub-protocol — the agent calls the client's `terminal/create` with `{ command, args, cwd, env }` and the **editor** executes the process, then the agent reads `terminal/output` / `wait_for_exit`. That model is wrong for us: our harness executes bash itself through `dsh-bash` (sandboxed env-scrub, background-task ownership, per-session cwd). Routing execution to the editor would bypass all of that and fork execution into two backends.

Studying the two reference agents (2026-06-18) shows neither uses `terminal/create` for their own shell tool — **both keep agent-side execution and emit a `_meta` convention** that Zed special-cases:

- **`claude-agent-acp`** (`tools.ts`, `acp-agent.ts`): gated on `clientCapabilities._meta.terminal_output`. The `tool_call` carries `content: [{ type: 'terminal', terminalId }]` and `_meta.terminal_info.{ terminal_id, cwd }`; output/exit arrive on the `tool_call_update`'s `_meta.terminal_output.{ terminal_id, data }` and `_meta.terminal_exit.{ terminal_id, exit_code, signal }`.
- **`codex-acp`** (`CodexToolCallMapper.ts`, `TerminalOutputMode.ts`): same `terminal_info` on the call; output via `_meta.terminal_output` (full) or `_meta.terminal_output_delta` (incremental), selected from the same `_meta.terminal_output` capability.

Zed's side (`crates/agent_servers/src/acp.rs`, verified): on a `ToolCall` whose `_meta.terminal_info.terminal_id` is set, it registers a **display-only** terminal (header = `terminal_info.cwd`, label = `tool_call.title`); on a `ToolCallUpdate`, `_meta.terminal_output.data` writes to that terminal and `_meta.terminal_exit.{exit_code,signal}` sets the status. It advertises the capability as `clientCapabilities._meta.terminal_output = true`. This is an off-spec `_meta` extension, but it is the de-facto contract for the Zed integration and the only way to get the terminal card while keeping execution agent-side.

## Decision

Keep `dsh-bash` agent-side execution; render the terminal card via the `_meta` convention, capability-gated, with the ` ```console ` text block as the guaranteed fallback.

1. **Capability.** `initialize` reads `clientCapabilities._meta.terminal_output` and the bridge remembers it per connection.
2. **Neutral presentation vocabulary.** `dsh-tools` gains a terminal-shaped presentation a tool can return — provider-neutral (`cwd`, the output `data`, an `exitCode`/`signal`), NO ACP types. `dsh-tool-bash` returns it for `bash` (cwd from the resolved workdir; output + exit parsed from the run result).
3. **Bridge mapping.** When the client advertised the capability, the bridge maps that presentation to: on `tool_call`, `content:[{type:'terminal', terminalId}]` + `_meta.terminal_info.{terminal_id,cwd}`; on `tool_call_update`, `_meta.terminal_output.{terminal_id,data}` (the captured output). `terminalId` is derived from the harness `callId` (stable, unique per call). When the capability is absent, the bridge uses the existing ` ```console ` text content — unchanged.
4. **No new execution path, no live streaming, no exit pill yet.** Output is attached at completion (from the agent's own `tool/result`), not streamed token-by-token. The exit-status pill (`_meta.terminal_exit.{exit_code,signal}`) is NOT emitted: it needs a structured exit code the pure `presentResult(args, result)` seam doesn't get (the result is content blocks), and the exit is already visible in the output text's `[exit code: N]` / `[killed by signal: …]` marker. Disposal is unaffected: nothing new to tear down, since the bridge never creates a client-side terminal.

## Risks / trade-offs

- **Off-spec `_meta`.** The terminal card rides on a Zed-specific `_meta` extension, not the ACP terminal sub-protocol. A client that doesn't recognize it still gets the text fallback (the capability gate ensures we only emit it when the client opted in via `_meta.terminal_output`), so a non-Zed client is never worse off. If ACP later standardizes agent-executed terminals, migrate to that and drop the `_meta`.
- **Capability honesty.** Emit terminal metadata ONLY when the client advertised `_meta.terminal_output`; the text fallback is the contract for everyone else and must never regress. Covered by a no-capability test asserting the ` ```console ` path.
- **terminalId collisions.** Deriving it from the per-call `callId` keeps it unique within a session and stable across the call/result pair; never reuse one across calls.
- **Provider-neutral vocabulary creep.** The terminal presentation widens the `dsh-tools` surface; keep it neutral (no ACP types leak into `dsh-tools`) and only as rich as a second UI consumer would also want.

## Out of scope / non-goals

The text-block baseline stays the no-capability default. Client-side `terminal/create` execution is explicitly rejected (it bypasses `dsh-bash`). Three follow-ups are deliberately NOT built here and would each warrant their own RFC when someone takes them on: the **exit-status pill** (`_meta.terminal_exit.{exit_code,signal}`, which needs the structured exit surfaced from the run rather than parsed out of the rendered output text), **live incremental streaming** (`_meta.terminal_output_delta` as chunks arrive, which needs an incremental-output seam on `dsh-bash`), and **command classification** (parsing a `cat`/`sed` as a `read` card with a file location, a `grep` as a `search`, etc., falling back to the terminal card — display-only, must never change what executes).
