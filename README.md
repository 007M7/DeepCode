<!--
  README.md — English side of the pair.
  If you edit this, update README.zh.md in the same commit, then run:
    pnpm run verify-translation-pairing --write
  to refresh README.i18n.yaml.
-->

<div align="center">

<!-- TODO: replace with wordmark / logo asset once designed -->
<h1>DeepSeek Harness</h1>

**The plugin-first agent SDK. Every capability &mdash; including the loop &mdash; is a plugin.**

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522.19-3c873a" alt="node"></a>
  <a href="https://pnpm.io"><img src="https://img.shields.io/badge/pnpm-workspace-f69220" alt="pnpm"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="typescript"></a>
  <a href="https://agentclientprotocol.com"><img src="https://img.shields.io/badge/protocol-ACP-4a6ef5" alt="ACP"></a>
  <a href="https://discord.gg/4nyuPgFzdE"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/Deepseekharness"><img src="https://img.shields.io/badge/X-@Deepseekharness-000000?logo=x&logoColor=white" alt="X"></a>
</p>

English | [中文](README.zh.md)

<!-- TODO: deepseek.com/harness-sdk placeholder URLs — swap for the final canonical URLs when ready. -->
[Docs](https://deepseek.com/harness-sdk/docs) &nbsp;·&nbsp; [Landing page](https://deepseek.com/harness-sdk) &nbsp;·&nbsp; [Community](#community)

</div>

<br>

<p align="center">
  <img src="./assets/arch-en.png" alt="DeepSeek Harness — System overview" width="100%">
</p>

## What is this?

DeepSeek Harness is a TypeScript SDK for building AI agents on top of the [Cordis](https://github.com/cordiverse/cordis) microkernel. **Every service, including the ReAct loop, is a plugin registered through `ctx.*`.** A batteries-included service registry ships in the box — LLM adapters, sandboxed execution, filesystem with policy, web search, sub-agents, dynamic workflows, session persistence, and more — and a `cordis.yml` at your project root chooses which get loaded. You can replace any of them, add your own, or leave the shipped defaults alone.

## Getting started

**New project** (one-command scaffold):

```sh
npm create @deepseek-ai/harness   # coming soon, not yet on npm
```

**From source** (read the code / run demos / contribute):

```sh
git clone https://github.com/deepseek-harness/deepseek-harness.git
cd deepseek-harness
pnpm install
export DEEPSEEK_API_KEY=sk-...    # optional — omit and use pnpm run demo:echo (mock, no key)
pnpm run demo:repl
```

Requires **Node `^22.19 || ≥24`** and **pnpm ≥ 11.7** (Node engine and pnpm pinned in `package.json`; `corepack enable` picks up the exact pnpm version). Node 23 is not on the support matrix.

**Heads up:** `demo:repl` runs real `read` / `write` / `edit` file tools and `bash` in your current working directory — best run from a scratch dir or a git-clean project so you can review the changes.

## Use it in your editor

Harness ships an [Agent Client Protocol (ACP)](https://agentclientprotocol.com) server. ACP lets an editor drive an agent from its sidebar; [Zed](https://zed.dev) supports it natively.

The ACP server command (from your local clone):

```sh
pnpm run demo:acp
```

Zed side — Zed's `settings.json` (Cmd-Shift-P → "zed: open settings") takes an `agent_servers` entry:

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/deepseek-harness", "run", "demo:acp"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." }
    }
  }
}
```

`--dir` points at your local clone. Zed launches the agent as a subprocess; each Zed session maps to its own agent instance, with chat in the sidebar and tool calls (arguments, results, file diffs) rendered inline in the editor. Configuration details in [`examples/acp-agent`](./examples/acp-agent) (including the snapshot-tested surface).

**VS Code / Cursor** — install an ACP client extension for either editor, such as [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client) (`formulahendry.acp-client`) or [ACP Pro](https://marketplace.visualstudio.com/items?itemName=duclvz.acp-pro) (`duclvz.acp-pro`), and point a custom agent at `pnpm run demo:acp`.

**Other ACP clients** — same launch. Feature-by-feature support matrix in [`packages/ui/acp/acp-feature-support.md`](./packages/ui/acp/acp-feature-support.md).

## Embed it in your own app

Harness bootstraps from a `cordis.yml` via [`@deepseek-ai/dsh-app-boot`](./packages/ui/app-boot). For library-style integration into your own Node.js service, the same boot helpers apply:

```ts
// my-app.ts
import {
  boot,
  installFailLoud,
  loadEnv,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot'

installFailLoud('my-app')
loadEnv('my-app')

const ctx = await boot('my-app', resolveConfigPath('./cordis.yml', undefined))
// ctx is the Cordis root Context; every service you mount in cordis.yml
// is reachable via ctx.* (ctx.agents, ctx.sessions, ctx.tools, …).
// The app plugins loaded from cordis.yml keep the process alive on their own
// (stdio agents hold stdin; the ACP agent holds an RPC connection).
// To shut down programmatically, call `await ctx.fiber.dispose()`.
```

`boot()` returns once the whole plugin tree has settled. Two separate failure paths: a module-import failure rejects the `boot()` Promise directly, so the caller's `await` throws — handle it with `try/catch`. `installFailLoud` covers a different case — a late plugin-init rejection surfacing *after* `boot()` has already resolved, which would otherwise become an unhandled rejection and die silently. In `cordis.yml`, the entry-point app plugin — `dsh-stdio-agent` for a REPL, `dsh-acp-agent` for an ACP server, or a custom one — sits alongside whichever services should load. Full helper surface: [`packages/ui/app-boot`](./packages/ui/app-boot).

For end-to-end examples, see [`examples/`](./examples):

- [`echo-agent`](./examples/echo-agent) — a minimal setup with a mock LLM and an echo tool
- [`coding-agent`](./examples/coding-agent) — a full coding agent wired to the real DeepSeek LLM
- [`acp-agent`](./examples/acp-agent) — ACP server, with a sandbox composition variant

## Demo

Harness driving Zed as an ACP agent — chat in the sidebar, tool calls (bash, file edits, diffs) rendered inline in the editor:

<p align="center">
  <video src="https://github.com/user-attachments/assets/a2bee95d-684f-41f4-b55f-1c14db0f24fa" controls width="800">
    Your browser does not support inline video; download it from <a href="./assets/demo-acp.mp4">assets/demo-acp.mp4</a>.
  </video>
</p>

<!-- TODO: additional feature-showcase clips go here (Code Mode / Dynamic Workflows / Self-installing plugins). -->

## Write a plugin

A Harness function/namespace plugin exports `name`, `inject`, and `apply` — cordis's Loader reads those separately. **`export default` breaks this shape** ([why](./docs/postmortem/0001-acp-default-export-drops-inject.md)): the Loader keeps only the `apply` function and silently drops `inject` / `name`, so the plugin fails to load with `cannot get property … without inject`. Inside `apply(ctx)`, tools / LLM adapters / services register through `ctx.*`.

The minimal echo tool from [`examples/echo-agent`](./examples/echo-agent):

```ts
// echo-tool.ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'echo-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'Echo the given text back, uppercased.',
    parameters: {
      text: { type: 'string', required: true },
    },
    async execute(args) {
      // args is typed: { text: string }
      return [{ type: 'text', text: `ECHO: ${args.text.toUpperCase()}` }]
    },
  }))
}
```

`parameters` uses the [schemastery](./vendor/schemastery) JSON-Schema-shaped DSL — one field per property, with `required: true` for mandatory ones. A leaf `cordis.yml` is a flat `EntryOptions[]` the Loader iterates; this tool's entry looks like:

```yaml
- id: echo-tool
  name: './echo-tool.ts'          # your tool
```

Alongside it, a bootable config also needs an LLM adapter and a `stdio-agent` app entry whose `config.model` points at an id that adapter registers. The minimal runnable version — mock LLM + this echo tool + a `stdio-agent` entry wired to `mock-echo` — is [`examples/echo-agent`](./examples/echo-agent), launched via:

```sh
pnpm run demo:echo
```

LLM-adapter and UI-plugin shapes: [`docs/cookbook/extension-cookbook.md`](./docs/cookbook/extension-cookbook.md).

## Packages

All packages ship under the `@deepseek-ai/dsh-*` scope. Grouped by family:

| Family | What lives here |
|---|---|
| **Core** (`packages/core/`) | `dsh-scope` · `dsh-session` · `dsh-tools` · `dsh-agent` · `dsh-agent-loop` · `dsh-system-prompt` |
| **LLM** (`packages/llm/`) | `dsh-llm` (the seam) + `dsh-llm-deepseek` (hand-rolled) and `dsh-llm-pi-ai` (library-backed twin — same DeepSeek endpoint, different internals, kept for design verification) |
| **Bash** (`packages/bash/`) | Shell execution: local + sandboxed backends, model-facing `bash` tool |
| **Filesystem** (`packages/fs/`) | Filesystem service with a policy layer, `read` / `write` / `edit` tools |
| **Web** (`packages/web/`) | Web search (Perplexity, Exa, DeepSeek) + fetch, model-facing tool |
| **Sandbox** (`packages/sandbox/`) | Process-confinement seam (bwrap / Landlock / Seatbelt) — wraps a caller's argv under a per-call policy; execution itself lives in `ctx.bash` |
| **Code runtime** (`packages/code-runtime/`) | JS worker runtime that Code Mode dispatches into |
| **Sub-agents** (`packages/subagent/`) | `spawn`, `fork`, plus in-process / subprocess / ACP-backed backends |
| **Workflows** (`packages/workflow/`) | Dynamic workflow orchestration (worker-thread execution) |
| **Skills** (`packages/skill/`) | Skill-provider registry (`ctx.skills`) + a local-filesystem provider |
| **Session persistence** (`packages/session-persistence/`) | Event-log persistence: JSONL and SQLite backends |
| **Session query** (`packages/session-query/`) | `ctx.sessionQuery` — unified logical-corpus reads over live sessions + persistence |
| **Compact** (`packages/compact/`) | Context compression / summarization |
| **Context** (`packages/context/`) | Opt-in request-context enrichment (e.g. `dsh-time-context` — dynamic time-in-prompt) |
| **Cordis toolset** (`packages/cordis/`) | Model-facing tools that inspect / mount / unmount cordis plugins at runtime |
| **UI apps** (`packages/ui/`) | `dsh-stdio-agent` (REPL) · `dsh-acp-agent` (ACP server) · `dsh-app-boot` · approval + ask-user primitives |
| **Hooks** (`packages/hooks/`) | Hook protocol + Claude Code / OpenAI Codex hook-config bridges |
| **Guards** (`packages/guard/`) | Advisory loop-hygiene plugins (e.g. `repeat-tool-guard` for repeated-call escalation) |
| **Timeouts** (`packages/timeout/`) | `timeout-policy` — a zero-config `tools/execute` wrapper enforcing per-tool `timeoutMs` |
| **Todo** (`packages/todo/`) | The model-facing `todo_write` tool (whole-list task tracker) |
| **Support** (`packages/support/`) | `invariants` — runtime diagnostic plugin mounted unconditionally by the shipped `dsh-agent-spine-demo` bundle; plus test/dev-only helpers (`llm-replay`, `acp-snapshot`, `subagent-mock`) |
| **Example bundles** (`packages/examples/`) | Ready-to-run demo compositions the top-level `demo:*` scripts launch: `dsh-agent-spine-demo` (default spine + capabilities), `dsh-stdio-demo` (REPL), `dsh-acp-demo` (ACP server), `dsh-jsonrpc-demo` |
| **Utils** (`packages/util/`) | Internal utility packages (`brand`, `timeout`) |

For the full module dependency graph, see [`docs/module-graph.md`](./docs/module-graph.md).

## Deep dives

To understand what makes DeepSeek Harness different, start here:

- [Architecture](./docs/architecture.md) — the service taxonomy and the microkernel structure
- [Agent lifecycle](./docs/agent-lifecycle.md) — how a turn flows through the loop, with sequence diagrams
- [Cordis primer](./docs/cordis-primer.md) — a working introduction to the underlying plugin framework
- [Tool execution pipeline](./docs/tool-execution-pipeline.md) — how a tool call passes through permission gates, hooks, and logging
- [Capability seams](./docs/capability-seams.md) — the extension points each service exposes
- [Code Mode](./docs/rfc/implemented/feature/2026-06-15-code-mode.md) — the model writes one JavaScript program per turn that chains many bash / tool calls, executed in a single runtime pass. **One model round-trip per multi-step operation**, not one per call.
- [Dynamic Workflows](./docs/rfc/implemented/feature/2026-07-05-dynamic-workflows.md) — the model writes a plain-JS orchestrator that fans out sub-agents in parallel, joins their results, and returns to the parent — instead of a chain of sub-agent tool calls.
- [Self-referential Cordis toolset](./docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) — the SDK's own plumbing (`cordis_inspect`, `cordis_mount`, `cordis_unmount`) is exposed as tools, so the model can inspect its own runtime and load new plugins on the fly.

Docs site: **[deepseek.com/harness-sdk/docs](https://deepseek.com/harness-sdk/docs)**.

## Community

<a name="community"></a>

- **[GitHub Issues](https://github.com/deepseek-harness/deepseek-harness/issues)** — bug reports
- **[GitHub Discussions](https://github.com/deepseek-harness/deepseek-harness/discussions)** — questions, ideas, RFCs

Real-time chat on <a href="https://discord.gg/4nyuPgFzdE"><b>Discord</b></a>. Release announcements on <a href="https://x.com/Deepseekharness"><b>X / Twitter</b></a>.

## License

[BSD 3-Clause](./LICENSE) &copy; DeepSeek
