# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness 是一个面向 coding agent（智能体）的开源、插件原生运行时。本仓库同时提供可组合的 SDK，以及由同一组包（package）组装而成、可直接运行的 agent `dsh`。

**使命。** 构建能力强大的 agent 产品，而不把产品选择硬编码到单一循环中。模型、工具、策略、存储、上下文、接口，乃至循环本身，都是 [Cordis 插件](docs/architecture.md)；会话日志是权威记录，模型历史、持久化、回放、查询、遥测和 UI 均从中派生。

## 使用前，想先说声谢谢

感谢你愿意花时间试用 DeepSeek Harness。它还在内测，整体完成度不高，也远没有达到我们想交付的样子。有些功能还没做完，有些地方用起来会很粗糙。真实使用中暴露出来的问题，也可能让我们推翻现在的设计。

我们会继续认真把这些地方做好，也希望你能把真实感受直接告诉我们。哪里失败了，哪里让你困惑或不好用，都请直说。如果它没有帮到你，反而给工作添了麻烦，那就是我们没有做好。你遇到的具体问题和任何建议，都会帮助我们判断接下来先改什么。谢谢你愿意在它还不成熟的时候花时间试用，也谢谢你愿意和我们一起把它一点点做好。

> **预发布说明：** 在首个带标签的版本发布之前，包 API、配置和持久化格式可能直接变更，不提供兼容层。

## 一条命令开始

```sh
curl -fsSL https://raw.githubusercontent.com/deepseek-harness/deepseek-harness/master/scripts/install.sh | sh
```

安装器要求系统已安装 `git` 和 Node `^22.19 || >=24`，可代为安装 `pnpm`，会提示输入 DeepSeek API 密钥，并在当前目录启动 TUI。它把受管检出放在 `~/.dsh/source` 下；再次运行同一命令即可更新。其他安装位置和非交互选项见 [`scripts/install.sh`](scripts/install.sh)。

## 选择使用方式

| 使用方式 | 入口 |
|---|---|
| 全屏 TUI | `dsh` |
| 浏览器 UI | 在源码检出中运行 `pnpm run demo:web`，或在已构建的检出中运行 `dsh web` |
| 一次性无头任务 | 运行 `pnpm run demo:headless "summarize this workspace"`，或在已构建的检出中运行 `dsh -p "summarize this workspace"` |
| ACP（Agent Client Protocol）自动化服务器 | 在源码检出中运行 `pnpm run demo:acp` |
| Python / JSON-RPC SDK | [`python/`](python/README.md) 及其自带的运行时 |

一行安装命令可直接启动从源码运行的 TUI，无需构建。`dsh web` 和 `dsh -p` 入口还需要先通过 `pnpm run build` 生成前端与客户端构建产物；`pnpm run demo:web` 会自行执行该构建。TUI、Web 和无头入口都把调用命令时的目录用作工作区。配置、会话恢复、提供方及工作区细节见 [`dsh` CLI（命令行界面）契约](apps/cli/README.md)；[示例](examples/README.md)展示了更精简的 ACP、JSON-RPC、Code Mode 和自指组合。

## 当前提供的能力

能力由组合决定。本仓库交付的插件涵盖：

- **编程：** 文件系统读写、编辑与搜索，shell 和持久 PTY 执行，LSP 导航，Web 搜索与抓取，可复用 skill（技能），以及由模型编写的 Code Mode 程序。
- **编排：** subagent、后台任务、工作线程工作流、同一会话内的目标、计划状态、待办事项，以及向用户提问。
- **运维：** 工作区沙箱与审批、会话持久化／恢复／fork／查询、压缩（compaction）与 spill、投影、标题，以及 OpenTelemetry 导出。

凡是模型可见的内容，都必须能从会话日志中重建。这样一来，不同 UI、持久化后端、回放和运维工具都成为同一事件流的消费方，而不是彼此并行的真源。

## 扩展 harness

一项可替换能力通常会将接口、实现和消费方彼此分离。你可以为 `ctx.llm`、`ctx.fs`、`ctx.pty`、`ctx.web` 或 `ctx.subagents` 等服务添加或替换提供方；通过 `ctx.tools` 注册面向模型的行为；通过类型化事件挂接策略和请求整形；再在 `cordis.yml` 中组合这些部分，无需 fork agent loop（智能体循环）。

从[第一个插件指南](docs/user/develop/basic/index.md)和[扩展实操手册](docs/cookbook/extension-cookbook.md)开始。需要系统图时查看[架构](docs/architecture.md)，需要当前服务关系时查看生成的[能力图](docs/capability-seams.md)，需要所有权细节时查看[包图](packages/README.md)。

## 开发

```sh
pnpm install
pnpm run demo:tui
```

将 `DEEPSEEK_API_KEY` 设置在环境变量或根目录 `.env` 中。环境搭建和验证由[开发指南](docs/development.md)统一说明；修改 `packages/` 前请阅读[架构](docs/architecture.md)，在本仓库工作时请遵循 [AGENTS.md](AGENTS.md)。

## 社区

前往 <a href="https://wj.qq.com/s2/27234598/03eb/">DeepSeek Harness 微信社区</a>关注项目动态。

## 许可证

[BSD 3-Clause](LICENSE)
