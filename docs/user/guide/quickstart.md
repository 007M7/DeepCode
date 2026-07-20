# Quick start

English | [中文](quickstart.zh.md)

This guide gets an agent running in five minutes.

## Prerequisites

- [Node.js](https://nodejs.org/) ^22.19 or >= 24
- [pnpm](https://pnpm.io/) 11 through Corepack
- A [DeepSeek Platform](https://platform.deepseek.com/) API key

```sh
node -v
corepack enable
pnpm -v
```

## Step 1: install and configure the API key

```sh
git clone https://github.com/deepseek-harness/deepseek-harness.git
cd deepseek-harness
pnpm install
```

Create the gitignored repository-root `.env`:

```sh
DEEPSEEK_API_KEY=sk-your-key-here
```

## Step 2: run one Headless task

Run a non-interactive task and print its final answer:

```sh
pnpm run demo:headless "summarize the architecture of this workspace"
```

Headless runs one complete model/tool turn, persists the session, prints the result, and exits. Use `--output-format stream-json` when you need the canonical event stream.

## Step 3: use the TUI

Start the interactive coding agent:

```sh
pnpm run demo:tui
```

The full-screen agent can read and write files, run commands, delegate subtasks, and track a plan. Try: `Create hello.js in the current directory, print "Hello from Harness!", and run it`.

## What happened

headless-agent uses the `@deepseek-ai/dsh-cli-demo` app; tui-agent uses the interactive `@deepseek-ai/dsh-tui-demo` app. Both load the same providerless agent spine, while their `cordis.yml` files select the DeepSeek model and capability plugins appropriate to each surface.

## Next steps

- [Configuration](./config.md) — understand the `cordis.yml` format
- [Develop a plugin](../develop/basic/) — build your own tool or backend
