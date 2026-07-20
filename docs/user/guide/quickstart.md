# Quick start

English | [中文](quickstart.zh.md)

This guide gets an agent running in five minutes.

## Prerequisites

- [Node.js](https://nodejs.org/) ^22.19 or >= 24
- [pnpm](https://pnpm.io/) 11 (use Corepack to select the repository-pinned version)

```sh
# Check versions
node -v   # v22.19.x, or v24.x and newer
corepack enable
pnpm -v   # 11.x
```

## Step 1: run echo-agent

echo-agent needs no API key and runs after dependencies are installed.

```sh
# Clone the repository
git clone https://github.com/deepseek-harness/deepseek-harness.git
cd deepseek-harness

# Install dependencies
pnpm install

# Start echo-agent
pnpm run demo:echo
```

The process prints:

```
echo-agent ready. Type a message ("echo <text>" triggers the tool).
>
```

Enter:

```
> echo hello world
```

The model issues a tool call, and the echo tool returns the text in uppercase:

```
[tool call] echo({"text":"hello world"})
[tool result] ECHO: HELLO WORLD
```

Your local environment is ready.

## Step 2: use a real model

Next, connect a real DeepSeek model and run the complete command-line agent.

### Get an API key

Get an API key from [DeepSeek Platform](https://platform.deepseek.com/).

### Configure the environment

Create a gitignored `.env` file in the repository root:

```sh
DEEPSEEK_API_KEY=sk-your-key-here
```

### Start repl-agent

```sh
pnpm run demo:repl
```

```
agent REPL ready. Give it a coding task.
>
```

This is a complete coding assistant that can read and write files, run commands, and delegate subtasks.

Try a task:

```
> Create hello.js in the current directory, print "Hello from Harness!", and run it
```

## What happened

echo-agent and repl-agent use the same application framework (`@deepseek-ai/dsh-stdio-demo`). Their `cordis.yml` files select different plugins and configuration. Custom agents use the same composition model.

## Next steps

- [Configuration](./config.md) — understand the `cordis.yml` format
- [Develop a plugin](../develop/basic/) — build your own tool or backend
