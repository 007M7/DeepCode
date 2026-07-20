# 快速开始

[English](quickstart.md) | 中文

本指南带你在 5 分钟内跑起一个 Agent。

## 环境准备

- [Node.js](https://nodejs.org/) ^22.19 或 >= 24
- 通过 Corepack 使用 [pnpm](https://pnpm.io/) 11

```sh
node -v
corepack enable
pnpm -v
```

## 第一步：运行 keyless Headless 演示

```sh
git clone https://github.com/deepseek-harness/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run demo:echo "echo hello world"
```

本地 mock 模型会调用 `echo` 工具，由工具返回大写文本，最终回复在不打开交互式 UI 的情况下直接输出。需要规范事件流时可使用 `--output-format stream-json`。

## 第二步：在 TUI 中使用真实模型

前往 [DeepSeek Platform](https://platform.deepseek.com/) 获取 API key，并创建已被 Git 忽略的仓库根目录 `.env`：

```sh
DEEPSEEK_API_KEY=sk-your-key-here
```

启动交互式 coding agent：

```sh
pnpm run demo:tui
```

这个全屏 Agent 可以读写文件、运行命令、分配子任务和跟踪计划。可以尝试：`Create hello.js in the current directory, print "Hello from Harness!", and run it`。

## 回头看

echo-agent 使用 Headless `@deepseek-ai/dsh-cli-demo` app，tui-agent 使用交互式 `@deepseek-ai/dsh-tui-demo` app。二者加载同一个 providerless agent spine，并通过各自的 `cordis.yml` 为对应 surface 选择模型和能力插件。

## 下一步

- [配置文件](./config.md) — 了解 `cordis.yml` 的格式
- [开发插件](../develop/basic/) — 编写自己的 tool 或后端
