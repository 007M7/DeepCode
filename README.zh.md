# DeepSeek Harness

[English](README.md) | 中文

**DeepSeek Harness SDK** 是用于构建 agent harness（智能体框架）的 SDK，采取基于插件的设计。

## 安装

一行命令即可安装 `dsh` 编码智能体——需要 `git` 和 Node `^22.19 || >=24`，缺少 `pnpm` 时会询问是否代为安装：

```sh
curl -fsSL https://raw.githubusercontent.com/deepseek-harness/deepseek-harness/master/scripts/install.sh | sh
```

脚本会把 harness 克隆到 `~/.dsh/source`，运行 `pnpm install`，把 `dsh` 软链接到 `~/.local/bin`（并询问是否加入 PATH），提示输入一次 `DEEPSEEK_API_KEY`，随后启动 `dsh`；再次运行会更新已有的检出。若在检出目录内运行（`sh scripts/install.sh`），脚本会复用当前检出并跳过克隆。可覆盖的 `DSH_*` 变量见 [`scripts/install.sh`](scripts/install.sh)。

## 开发

本 monorepo 基于 [Cordis](https://github.com/cordiverse/cordis) 框架构建（以源码形式收录在 `vendor/` 下），采用微内核风格：所有功能都以插件形式提供。

```sh
pnpm install
pnpm run test          # vitest
# Agent demos require DEEPSEEK_API_KEY.
pnpm run demo:tui      # full-screen TUI coding agent
pnpm run demo:headless "task" # one-shot coding agent
pnpm run demo:cordis   # self-referential agent demo
pnpm run demo:acp      # ACP server agent demo
```

面向开发者：先读[开发指南](docs/development.md)，了解本地环境搭建、钩子、环境变量与质量门禁，动手改 package 之前再读[架构设计](docs/architecture.md)和[文档关系图索引](docs/graph-atlas.md)。局部上下文见 [packages/](packages/) 与 [vendor/](vendor/)。

面向 agent：遵循 [AGENTS.md](AGENTS.md)。
