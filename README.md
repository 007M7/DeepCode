# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source coding agent built on the DeepSeek Harness SDK.

It uses an architecture where **everything is a plugin**.

## Internal testing notice

感谢您愿意拨冗试用 DeepSeek Harness。当前版本仍处于内部测试阶段，功能仍待完善，体验难免有些粗糙。

“如切如磋，如琢如磨。” 产品的成长，离不开一次次真实的碰撞与坦诚的反馈。您在真实使用中发现的问题，也可能促使我们重新审视，甚至推翻已有的设计。

为了帮助我们更准确地还原您真实使用中的问题，内测版本默认会上传所有 Session Log；如需关闭，可以设置环境变量 `DSH_TELEMETRY_DISABLED=1`。另外，如果您有任何反馈与建议，请在企业微信群中留言告诉我们。每一条反馈，都会帮助我们把它打磨得更好。

## Install

Clone the repository, then run the installer:

```sh
git clone <repo-url>
cd deepseek-harness
scripts/install.sh
```

The installer requires `git` and Node `^22.19 || >=24`, offers to install `pnpm` when it is missing, and prompts for a DeepSeek API key.

The installer keeps every checkout under `~/.dsh/source`: the master clone at `~/.dsh/source/master` and each install's staging checkout as a git worktree `~/.dsh/source/staging-<timestamp>`. The stable symlink `~/.dsh/source/current` points at the active staging worktree, and `dsh` in `~/.local/bin` links to `current/bin/dsh`, so an upgrade repoints one symlink and the `dsh` on PATH never moves. Re-running the command adds a fresh staging worktree from an updated master and repoints `current` at it. See [`scripts/install.sh`](scripts/install.sh) for alternate install locations and other options.

## Use DeepSeek Harness

### Web UI

For the recommended local interface, build the active checkout after installation and after each update, then start the Web UI:

```sh
(cd ~/.dsh/source/current && pnpm run build)
dsh web
```

The full build produces the library and client bundles plus the frontend dist. The path above is the installer's default. If you set `DSH_SOURCE` or `DSH_CURRENT`, or reused an existing checkout, replace `~/.dsh/source/current` with that checkout path; see [`scripts/install.sh`](scripts/install.sh) for details. The Web UI is served at `http://127.0.0.1:3080` by default.

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

### Automation and SDKs

From a source checkout with `DEEPSEEK_API_KEY` in the environment or its root `.env`, start the ACP automation server:

```sh
pnpm run demo:acp
```

The [Python SDK](python/README.md) drives a bundled JSON-RPC runtime. The [examples](examples/README.md) cover the runnable headless, ACP, JSON-RPC, Code Mode, and self-referential compositions.

## Why DeepSeek Harness

Built-in capabilities cover file reading, editing, and search; shell and persistent PTY execution; reusable skills; task tracking, goals, plans, todos, and background tasks; subagents and workflows; sandboxing and approvals; settings and credentials; persistent, resumable, forkable, and queryable sessions; LSP and web access; context compaction; and telemetry. Each composition selects the subset appropriate to its surface. The TUI and Web UI both include Plan Mode.

- **Everything is a plugin.** Models, tools, policies, storage, context management, and interfaces are composable [Cordis plugins](docs/user/develop/basic/index.md), so deployments can extend or replace behavior without forking the agent loop. See the [architecture](docs/architecture.md) for the underlying design.
- **Runs are reconstructable.** Anything visible to the model is logged in the authoritative session stream; persistence, resume/fork/query, replay, telemetry, and UIs derive from the same events. See the [session-log architecture](docs/architecture.md#session-log).
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

DeepSeek Harness is currently in internal testing.

## License

[BSD 3-Clause](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
