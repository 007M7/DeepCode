# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source coding agent built on the DeepSeek Harness SDK.

It uses an architecture where **everything is a plugin**.

## Install

Install `dsh` with one command:

```sh
curl -fsSL https://raw.githubusercontent.com/deepseek-harness/deepseek-harness/master/scripts/install.sh | sh
```

The installer requires `git` and Node `^22.19 || >=24`, offers to install `pnpm` when it is missing, and prompts for a DeepSeek API key.

The installer clones DeepSeek Harness to `~/.dsh/source`, links `dsh` into `~/.local/bin`, and launches it. Re-running the command updates the checkout. See [`scripts/install.sh`](scripts/install.sh) for alternate install locations and other options.

## Use DeepSeek Harness

### Web UI

For the recommended local interface, build the frontend after installation and after each update, then start the Web UI:

```sh
pnpm --dir ~/.dsh/source run build:web
dsh web
```

The Web UI is served at `http://127.0.0.1:3080` by default.

### TUI

Start the full-screen terminal interface:

```sh
dsh
```

### Headless

Run one task, print the final answer, and exit:

```sh
dsh -p "summarize this workspace"
```

## Why DeepSeek Harness

Built-in capabilities cover file reading, editing, and search; shell execution; reusable skills; task tracking; subagents and workflows; persistent sessions; and context compaction. The TUI also includes Plan Mode.

- **Everything is a plugin.** Models, tools, policies, storage, context management, and interfaces are composable [Cordis plugins](docs/user/develop/basic/index.md), so deployments can extend or replace behavior without forking the agent loop. See the [architecture](docs/architecture.md) for the underlying design.
- **Code Mode (opt-in).** It exposes a `run_code` tool and a generated TypeScript SDK; only program output re-enters model context. See [Code Mode](packages/core/tools/README.md#code-mode).
- **Self-referential Cordis tools are opt-in.** They let the agent inspect its live runtime and mount or unmount plugins while it runs. See the [Cordis tools](packages/cordis/tool-cordis/README.md).

## Community

Follow <a href="https://x.com/Deepseekharness">DeepSeek Harness on Twitter</a> for project updates.

## Development

```sh
pnpm install
pnpm run test:coverage
```

Start with the [development guide](docs/development.md) and read the [architecture](docs/architecture.md) before changing packages.

For agents, follow [AGENTS.md](AGENTS.md).

DeepSeek Harness is currently pre-release.

## License

[BSD 3-Clause](LICENSE)
