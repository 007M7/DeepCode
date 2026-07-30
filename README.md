# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness is an open-source, plugin-native runtime for coding agents. This repository ships both the composable SDK and `dsh`, a working agent assembled from the same packages.

**Mission.** Build capable agent products without hard-wiring product choices into one loop. Models, tools, policy, storage, context, interfaces, and even the loop are [Cordis plugins](docs/architecture.md); the session log is the authoritative record from which model history, persistence, replay, queries, telemetry, and UIs derive.

## Before you begin, thank you

Thank you for taking the time to try DeepSeek Harness.

This version is for internal testing only. Overall, it is still far from complete and nowhere near what we want to deliver. Some features are unfinished, and some parts will feel rough. What we learn from real use may also lead us to rethink the designs we have today.

We will keep working carefully on it, and we sincerely want direct feedback—especially about the moments when it fails, confuses you, or gets in your way. If it does not help you, or makes your work harder, please leave a message in our WeCom group and tell us plainly.

> **Pre-release notice:** Package APIs, configuration, and persisted formats may change without compatibility shims until the first tagged release.

## Start in one command

```sh
curl -fsSL https://raw.githubusercontent.com/deepseek-harness/deepseek-harness/master/scripts/install.sh | sh
```

The installer requires `git` and Node `^22.19 || >=24`, offers to install `pnpm`, prompts for a DeepSeek API key, and launches the TUI in the current directory. It keeps managed checkouts under `~/.dsh/source`; run the same command again to update. [`scripts/install.sh`](scripts/install.sh) documents alternate locations and non-interactive options.

## Choose a surface

| Surface | Entry point |
|---|---|
| Full-screen TUI | `dsh` |
| Browser UI | `pnpm run demo:web` from a source checkout, or `dsh web` from a built checkout |
| One-shot headless task | `pnpm run demo:headless "summarize this workspace"`, or `dsh -p "summarize this workspace"` from a built checkout |
| ACP automation server | `pnpm run demo:acp` from a source checkout |
| Python / JSON-RPC SDK | [`python/`](python/README.md) with its bundled runtime |

The one-line installer launches the source-running TUI without a build. The `dsh web` and `dsh -p` entries additionally need the frontend and client bundles from `pnpm run build`; `pnpm run demo:web` performs that build itself. The TUI, Web, and headless entries use the invoking directory as the workspace. See the [`dsh` CLI contract](apps/cli/README.md) for configuration, resume, provider, and workspace details; the [examples](examples/README.md) show the thinner ACP, JSON-RPC, Code Mode, and self-referential compositions.

## What ships

Capabilities are selected by composition. The repository's shipped plugins cover:

- **Coding:** filesystem read/write/edit and search, shell and persistent PTY execution, LSP navigation, web search/fetch, reusable skills, and model-written Code Mode programs.
- **Orchestration:** subagents, background tasks, worker-thread workflows, same-session goals, plan state, todos, and user questions.
- **Operations:** workspace sandboxing and approvals, session persistence/resume/fork/query, compaction and spill, projections, titles, and OpenTelemetry export.

Anything visible to the model must be reconstructable from the session log. That makes alternate UIs, persistence backends, replay, and operational tooling consumers of one event stream instead of parallel sources of truth.

## Extend the harness

A swappable capability normally separates its interface, implementation, and consumer. Add or replace a provider behind a service such as `ctx.llm`, `ctx.fs`, `ctx.pty`, `ctx.web`, or `ctx.subagents`; register model-facing behavior through `ctx.tools`; attach policy and request shaping through typed events; compose the result in `cordis.yml` without forking the agent loop.

Start with the [first-plugin guide](docs/user/develop/basic/index.md) and [extension cookbook](docs/cookbook/extension-cookbook.md). Use the [architecture](docs/architecture.md) for the system map, the generated [capability graph](docs/capability-seams.md) for current service relationships, and the [package map](packages/README.md) when you need ownership details.

## Develop

```sh
pnpm install
pnpm run demo:tui
```

Set `DEEPSEEK_API_KEY` in the environment or root `.env`. The [development guide](docs/development.md) owns setup and validation; read the [architecture](docs/architecture.md) before changing `packages/`, and follow [AGENTS.md](AGENTS.md) when working in this repository.

## Community

Follow <a href="https://x.com/Deepseekharness">DeepSeek Harness on X</a> for project updates.

## License

[BSD 3-Clause](LICENSE)
