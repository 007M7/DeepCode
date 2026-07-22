# DeepSeek Harness

English | [中文](README.zh.md)

The **DeepSeek Harness SDK** is a plugin-based SDK for building agent harnesses.

## Install

Install the `dsh` coding agent with one line — it needs `git` and Node `^22.19 || >=24`, and offers to install `pnpm` if it is missing:

```sh
curl -fsSL https://raw.githubusercontent.com/deepseek-harness/deepseek-harness/master/scripts/install.sh | sh
```

It clones the harness to `~/.dsh/source`, runs `pnpm install`, symlinks `dsh` into `~/.local/bin` (offering to add it to your PATH), prompts once for your `DEEPSEEK_API_KEY`, and launches `dsh`; re-running it updates an existing checkout. Run from inside a checkout (`sh scripts/install.sh`) it reuses that checkout and skips the clone. The overridable `DSH_*` variables are documented in [`scripts/install.sh`](scripts/install.sh).

## Development

This monorepo is built on the [Cordis](https://github.com/cordiverse/cordis) framework (vendored as source under `vendor/`), microkernel-style: everything is a plugin.

```sh
pnpm install
pnpm run test          # vitest
# Agent demos require DEEPSEEK_API_KEY.
pnpm run demo:tui      # full-screen TUI coding agent
pnpm run demo:headless "task" # one-shot coding agent
pnpm run demo:cordis   # self-referential agent demo
pnpm run demo:acp      # ACP server agent demo
```

For humans, start with the [development guide](docs/development.md) for local setup, hooks, environment variables, and quality gates, then read the [architecture design](docs/architecture.md) and [documentation graph index](docs/graph-atlas.md) before package work. Local context lives in [packages/](packages/) and [vendor/](vendor/).

For agents, follow [AGENTS.md](AGENTS.md).
