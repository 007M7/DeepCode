# @deepseek-ai/dsh-desktop

Desktop workbench for developing and studying DeepSeek Harness agents. The app is a first-party Electron client bound to this repository, not a generic workspace picker and not a continuation of the localhost prototype under `/Users/tn.shen/Documents/原型`.

The product loop is: run a task in chat, inspect what happened, modify Harness or a local plugin, restart only the runtime, replay a previous task, compare the new run against the baseline, and repeat.

## Run it

From the repository root:

```bash
pnpm --dir packages/ui/desktop run dev
```

This starts a Vite renderer on `http://127.0.0.1:5174`, opens Electron, and starts the real Harness ACP runtime with:

```bash
node --import tsx packages/examples/acp-demo/src/bin.ts --config examples/acp-agent/cordis.yml
```

The renderer talks only to the Electron preload API. The main process owns the ACP subprocess, session JSONL reads, feedback writes, runtime restart, and diagnostics.

Useful checks:

```bash
node_modules/.bin/vitest run packages/ui/desktop/tests/index.spec.ts packages/ui/desktop/tests/acp-subprocess.spec.ts
node_modules/.bin/tsc --noEmit --ignoreConfig --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM --strict --allowImportingTsExtensions packages/ui/desktop/src/index.ts packages/ui/desktop/src/app.ts packages/ui/desktop/src/global.d.ts packages/ui/desktop/src/css.d.ts
```

## User journey

The desktop app is for a Harness developer or researcher who wants to understand and improve one repo-bound agent runtime.

1. Install and open the app. The app binds to this repository; there is no workspace picker.
2. Start a session in `Chat` and run one or two tasks to prove the runtime works.
3. Switch the same run to `Trajectory`, `Waterfall`, or `Context` to understand what happened behind one message.
4. Click any interesting message, step, tool call, request, timing bar, or context section to open the `Inspector` with complete facts.
5. Use `Dev` to ask the agent to modify Harness, a plugin, a prompt, a tool, or config. The first version seeds chat with repo paths and context instead of exposing a graphical code editor.
6. Restart only the managed Harness runtime subprocess when code/config changes require it.
7. Replay a previous prompt or turn against the changed runtime.
8. Compare the baseline run and candidate run. Keep the new behavior or ask the agent to revert/change it, then repeat.

## Product shape

The Electron shell owns the desktop lifecycle while the Harness runtime runs as a managed subprocess. The renderer never talks directly to the filesystem or the model. It calls typed preload APIs; the main process starts the runtime, talks to the Agent Client Protocol (ACP) server over JSON-RPC stdio, and reads session logs through trusted query adapters.

The default runtime channel is ACP because `dsh-acp` already owns `session/new`, `session/load`, `session/prompt`, `session/cancel`, streaming `session/update`, permission prompts, and user elicitations. The desktop app may add a query side channel for persisted JSONL or `ctx.sessionQuery`, but live chat should not be implemented by polling JSONL.

The app is repository-bound. On startup it treats the package root as the Harness repository, launches the runtime from that directory, reads `.sessions` from that runtime's persistence config, and marks each run with repository state such as commit, dirty status, runtime config hash, and parent replay metadata.

## Main surfaces

`Sessions/Runs` is the left navigation. It lists new and persisted runs, supports search, opens or resumes a session, pins a baseline, and starts replay from a historical prompt or turn.

`Chat` is the reading and driving surface. It renders user messages, assistant text, and lightweight collapsed `Thinking` and `Tool use` rows. Clicking a message or activity opens the inspector. The composer is always available for the selected live session.

`Trajectory` is the structural surface. It is a mixed navigation view over `session -> turn -> step -> request / assistant / tool / context` with status, duration, token counts, tool names, errors, and short previews. It must not expand full raw payloads, complete system prompts, full tool schemas, or raw chunk streams inline. Clicking any node opens the inspector.

`Waterfall` is the time surface. It answers where latency went across turns, steps, model calls, tool calls, background work, and failures. It contains labels, timings, and critical-path cues only. Clicking a bar opens the inspector.

`Context` is the request-anatomy surface. It answers what the model saw at a selected request boundary: config, system prompt, session prefix, derived conversation surface, injected `context/message` entries, compaction summaries, visible tools, and request-header deltas. It may show section summaries and bounded previews, but the full raw data still belongs in the inspector.

`Inspector` is a right-side drawer, not a permanent column. It appears only after the user selects a message, trajectory node, waterfall bar, or context section. Its tabs are `Input`, `Output`, `Metadata`, and `Feedback`. It is the only place for complete JSON, JSONL, full schemas, complete system prompts, raw event windows, copy actions, and node-targeted feedback.

## Surface behavior contract

| Surface | Primary job | Inline content | Inspector trigger |
|---|---|---|---|
| `Chat` | Drive and read the conversation | User messages, assistant messages, collapsed thinking rows, collapsed tool-use rows | Message or activity click |
| `Trajectory` | Navigate run structure | `session -> turn -> step -> request / assistant / tool / context`, statuses, counts, durations, short previews | Any node click |
| `Waterfall` | Diagnose latency | Spans, critical path, status, start/duration | Bar click |
| `Context` | Explain request anatomy | Config summary, system summary, prefix summary, derived-history summary, context-message summary, tool-schema list summary, deltas | Section click |
| `Compare` | Compare two run artifacts | Baseline/candidate diffs for output, context, tools, events, usage, duration, errors | Diff hunk click |
| `Dev` | Support repo-bound modification loop | Runtime state, dirty state, watched paths, suggested agent prompts, restart-needed flag | Config/plugin/path click |

Only `Chat` owns the composer. The other middle surfaces are inspection modes over the selected run or selected request boundary.

## Information ownership

Middle surfaces locate and explain. The inspector preserves the complete facts.

`Trajectory` and `Context` should not duplicate inspector responsibilities. Trajectory shows where the user is in the run. Context shows which context sources contributed to a request. Inspector shows the selected object's complete input, output, metadata, and feedback.

The same selected object can be entered from multiple surfaces. A `tool/call` selected from Trajectory, a `Tool use` row selected from Chat, or a tool segment selected from Waterfall should resolve to one inspector target. This keeps feedback and copying attached to the event, not to the view that opened it.

### Why Trajectory still needs Inspector

Trajectory answers orientation questions:

- Which turn and step produced this behavior?
- Which request triggered which assistant output and tool calls?
- Did the run fail, cancel, or continue?
- What is the rough shape of this step before I inspect raw data?

Trajectory should not expand full request headers, full tool schemas, full system prompts, or raw chunk streams inline because that turns the navigator into a raw JSON viewer. Instead, every row has a stable target id. Clicking a row opens Inspector, where full `Input`, `Output`, `Metadata`, and `Feedback` are available.

### Why Context still needs Inspector

Context answers request-anatomy questions:

- What did this request include outside normal chat history?
- Did the system prompt, tools, call config, or session prefix change?
- Which `context/message` or `steering/message` entries were model-visible?
- Was history compacted or replaced before this request?
- Which sections are large enough to matter for token cost?

Context should show section summaries and bounded previews. The complete system prompt, complete tool schemas, full derived message list, raw `request/header`, and raw `request/header-delta` belong in Inspector. This makes Context useful as a map while preserving the user's requirement that every fact remains reachable.

## Plugin and development panel

The `Dev` panel is for changing Harness itself. It is not a full IDE and should not start as a graphical Cordis editor.

The first version lists Cordis config entries, local `plugins/*` packages when present, runtime status, repository dirty state, and whether a runtime restart is needed. It provides actions to ask the agent to add, modify, or disable a plugin by seeding the current chat with the relevant paths and config context.

Runtime changes are applied by restarting the managed ACP subprocess, not by restarting Electron. File watching should mark `Restart needed` for changes under `packages/**`, `examples/**`, `plugins/**`, `cordis.yml`, and package manifests. HMR can be explored later, but the reliable path is subprocess restart because ACP stdout is the JSON-RPC protocol channel.

## Replay and compare

Trace is looking at the past. Replay is running a past task against the current runtime. Compare is inspecting two run artifacts.

Replay creates a new run with `parentRunId` or `replayOf` metadata. If the app can only replay the user prompt and cwd rather than reconstructing an exact intermediate state, the UI must label it as prompt replay. It must not imply bit-for-bit session replay unless the runtime can prove it restored the same context boundary.

Compare is not a normal tab inside one session. It is a mode over two runs: baseline and candidate. The first version compares final output, request header, context sections, tool sequence, tool inputs and outputs, event counts, step counts, usage, duration, and errors.

## Backend integration plan

The first implementation uses two backend paths:

- ACP subprocess for live chat and runtime lifecycle. It maps to `session/new`, `session/load`, `session/prompt`, `session/cancel`, and streamed `session/update`. This is the authoritative path for driving the agent.
- Session query/read adapters for exact inspection. They read live-preferred persisted logs through `listSessions()`, `listEvents(sessionId)`, and bounded raw-event windows for Inspector.

The renderer receives normalized view models, not raw filesystem paths. The main process owns:

- Runtime process start, stop, restart, status, stderr diagnostics, and JSON-RPC stdout framing.
- Session/run discovery and run metadata sidecars.
- Trace normalization into chat messages, trajectory nodes, waterfall spans, context sections, compare diffs, and inspector payload refs.
- Feedback writes attached to stable inspector target ids.

## Trace and context data sources

The current session log can provide all core facts needed by the UI:

- `turn/start` and `turn/end` define durable user-visible turn boundaries.
- `step/start` and `step/end` define one model request plus its tool work.
- `request/header` and `request/header-delta` reconstruct model config, system prompt, tools, and `messagePrefix`.
- `user/message`, `assistant/message`, `tool/result`, `context/message`, and `steering/message` define the model-visible surface through `deriveMessages()`.
- `assistant/chunk` preserves token-level streaming fidelity but should usually be folded in Chat and opened in Inspector only when needed.
- `tool/call` and `tool/result` define tool input/output pairs and errors.
- `sourceEventSeqs` and `surfaceOp` explain provenance and compaction/replacement.

## Minimum implementation plan

Start with a desktop package that defines shared UI contracts, then build the Electron shell around them.

1. Add an Electron main process that launches the ACP runtime subprocess from the repository root and owns lifecycle commands: start, stop, restart, status.
2. Add a preload API for sessions, prompts, trace reads, replay, compare, dev status, and feedback. Renderer code must not use Node globals.
3. Build the renderer around the five middle surfaces and the inspector drawer. The renderer should treat all trace/context/compare objects as view models supplied by the main process.
4. Implement session ingestion from ACP live updates and persisted session logs. Normalize selected objects to stable inspector targets.
5. Implement Dev panel actions as agent-seeded chat prompts first. Direct file mutations and graphical Cordis editing are later features.
6. Implement replay by creating a new run from a historical prompt or turn. Attach run metadata and open Compare after the candidate completes.

## Phase-one acceptance criteria

- A developer can open the desktop app from this repository without selecting a workspace.
- A developer can create/load sessions and send prompts through the real ACP runtime.
- The same run can switch between `Chat`, `Trajectory`, `Waterfall`, and `Context`.
- Clicking any middle-surface object opens the Inspector drawer with `Input`, `Output`, `Metadata`, and `Feedback`, with Feedback last.
- Complete system prompts, tool schemas, raw event windows, and JSON/JSONL are reachable from Inspector.
- Feedback defaults the author to `shentuni` and persists against the selected target.
- Runtime restart does not close the Electron shell.
- Replay creates a separate candidate run with lineage metadata.
- Compare operates over two runs, not "inside" one session.

## Known limitations and deferred work

This package now ships a usable Electron/Vite development app and a real ACP subprocess bridge. It is still a v1 workbench rather than a packaged distributable.

The first runtime channel is ACP. Direct in-process embedding would make context queries and restarts richer, but it makes isolation, teardown, and hot reload harder and should wait until the ACP path is working.

The first Dev panel is agent-assisted. A direct graphical plugin/config editor should come after the app can reliably run, replay, compare, and restart the runtime.

The current trace/context surfaces read persisted JSONL after turns complete and use ACP live updates for streaming chat. A richer live raw-event side channel would make Trajectory/Context update at token-time rather than after the persistence flush.

The first Compare view is structural and textual. Semantic evaluation and dataset-level analysis belong to a later evaluation product surface.
