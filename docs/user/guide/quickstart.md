# Quick start

English | [中文](quickstart.zh.md)

This guide gets an agent running in five minutes.

## Prerequisites

- [Node.js](https://nodejs.org/) ^22.19 or >= 24
- [pnpm](https://pnpm.io/) 11 through Corepack

```sh
node -v
corepack enable
pnpm -v
```

## Step 1: run the keyless Headless demo

```sh
git clone https://github.com/deepseek-harness/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run demo:echo "echo hello world"
```

The local mock model calls the `echo` tool, which returns the text in uppercase, and the final response is printed without opening an interactive UI. Use `--output-format stream-json` when you need the canonical event stream.

## Step 2: use a real model in the TUI

Get an API key from [DeepSeek Platform](https://platform.deepseek.com/) and create the gitignored repository-root `.env`:

```sh
DEEPSEEK_API_KEY=sk-your-key-here
```

Start the interactive coding agent:

```sh
pnpm run demo:tui
```

The full-screen agent can read and write files, run commands, delegate subtasks, and track a plan. Try: `Create hello.js in the current directory, print "Hello from Harness!", and run it`.

## What happened

echo-agent uses the Headless `@deepseek-ai/dsh-cli-demo` app; tui-agent uses the interactive `@deepseek-ai/dsh-tui-demo` app. Both load the same providerless agent spine, while their `cordis.yml` files select the model and capability plugins appropriate to each surface.

## Next steps

- [Configuration](./config.md) — understand the `cordis.yml` format
- [Develop a plugin](../develop/basic/) — build your own tool or backend
