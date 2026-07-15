<!--
  README.zh.md — Chinese pair.
  If you edit this, update README.md in the same commit, then run:
    pnpm run verify-translation-pairing --write
  to refresh README.i18n.yaml.
-->

<div align="center">

<!-- TODO: 待设计后替换为 logo / wordmark 资源 -->
<h1>DeepSeek Harness</h1>

**插件优先的 agent（智能体） SDK。每一项能力 &mdash; 包括 loop 本身 &mdash; 都是插件。**

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522.19-3c873a" alt="node"></a>
  <a href="https://pnpm.io"><img src="https://img.shields.io/badge/pnpm-workspace-f69220" alt="pnpm"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="typescript"></a>
  <a href="https://agentclientprotocol.com"><img src="https://img.shields.io/badge/protocol-ACP-4a6ef5" alt="ACP"></a>
</p>

[English](README.md) | 中文

<!-- TODO: deepseek.com/harness-sdk 是占位 URL，最终域名就绪后替换。 -->
[文档](https://deepseek.com/harness-sdk/docs) &nbsp;·&nbsp; [Landing page](https://deepseek.com/harness-sdk) &nbsp;·&nbsp; [社群](#community)

</div>

<br>

<p align="center">
  <img src="./assets/arch-zh.png" alt="DeepSeek Harness · 系统一览" width="100%">
</p>

## 这是什么？

DeepSeek Harness 是一个用 TypeScript 写的 AI agent SDK，构建在 [Cordis](https://github.com/cordiverse/cordis) 微内核之上。**所有服务，包括默认的 ReAct loop，都是通过 `ctx.*` 注册的插件。** 仓库里带了一整套开箱即用的服务 —— LLM 适配、沙盒执行、带策略的文件读写、网页搜索、子 agent、动态工作流、会话持久化等 —— 由项目根目录下的 `cordis.yml` 决定加载哪些。你可以替换任何一项、加装自己的，或者保留默认。

## 上手

**新起一个项目**（一条命令生成脚手架）：

```sh
npm create @deepseek-ai/harness   # coming soon, not yet on npm
```

**克隆仓库**（读代码 / 跑 demo / 贡献代码）：

```sh
git clone https://github.com/deepseek-harness/deepseek-harness.git
cd deepseek-harness
pnpm install
export DEEPSEEK_API_KEY=sk-...    # optional — omit and use pnpm run demo:echo (mock, no key)
pnpm run demo:repl
```

需要 **Node `^22.19 || ≥24`** 和 **pnpm ≥ 11.7**（Node 引擎与 pnpm 版本由 `package.json` 的 `engines` / `packageManager` 字段锁定；`corepack enable` 会自动装对 pnpm 版本）。Node 23 不在支持范围内。

**注意：** `demo:repl` 会用真实的 `read` / `write` / `edit` 文件工具和 `bash` 操作**当前工作目录**，最好在空目录或干净的 git 项目里运行，方便随时 review 改动。

## 接入编辑器

Harness 内置了一个 [Agent Client Protocol (ACP)](https://agentclientprotocol.com) server。ACP 是一个把 agent 挂到编辑器边栏作为后端的协议；[Zed](https://zed.dev) 目前原生支持。

ACP server 的启动命令（在 clone 的仓库根目录下）：

```sh
pnpm run demo:acp
```

Zed 端 —— 在 Zed 的 `settings.json`（Cmd-Shift-P → "zed: open settings"）里加上 `agent_servers` 一节：

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/deepseek-harness", "run", "demo:acp"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." }
    }
  }
}
```

`--dir` 指向本地仓库路径。Zed 把 agent 作为子进程拉起，每个 Zed session 对应一个独立的 agent 实例；编辑器边栏可以直接对话，tool 调用（参数、结果、文件 diff）内联渲染到编辑区。完整配置说明见 [`examples/acp-agent`](./examples/acp-agent)。

**VS Code / Cursor** —— 两个编辑器都可以装 ACP 客户端插件，比如 [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client)（`formulahendry.acp-client`）或 [ACP Pro](https://marketplace.visualstudio.com/items?itemName=duclvz.acp-pro)（`duclvz.acp-pro`），把 `pnpm run demo:acp` 配成自定义 agent 即可接入。

**其他 ACP 客户端** —— 接入方式相同。支持哪些 ACP 特性见 [`packages/ui/acp/acp-feature-support.md`](./packages/ui/acp/acp-feature-support.md)。

## 嵌入自己的应用

Harness 是通过 [`@deepseek-ai/dsh-app-boot`](./packages/ui/app-boot) 从一份 `cordis.yml` 引导起来的。如果希望在个人 Node.js 服务里以库的形式集成，可以用同样的引导方式：

```ts
// my-app.ts
import {
  boot,
  installFailLoud,
  loadEnv,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot'

installFailLoud('my-app')
loadEnv('my-app')

const ctx = await boot('my-app', resolveConfigPath('./cordis.yml', undefined))
// ctx is the Cordis root Context; every service you mount in cordis.yml
// is reachable via ctx.* (ctx.agents, ctx.sessions, ctx.tools, …).
// The app plugins loaded from cordis.yml keep the process alive on their own
// (stdio agents hold stdin; the ACP agent holds an RPC connection).
// To shut down programmatically, call `await ctx.fiber.dispose()`.
```

`boot()` 会在整棵插件树 settle 完之后返回。两条失败路径要分开处理：模块导入失败会直接 reject `boot()` 的 Promise，`await` 处会抛出，调用方用 `try/catch` 接住即可。`installFailLoud` 负责的是另一件事 —— `boot()` 返回之后才浮出来的 late plugin-init rejection，如果不接就会变成无人处理的 unhandled rejection 静默死掉。`cordis.yml` 里的 app 插件入口 —— `dsh-stdio-agent`（REPL）、`dsh-acp-agent`（ACP server）或自定义 —— 搭配想加载的服务。完整的 helper 表见 [`packages/ui/app-boot`](./packages/ui/app-boot)。

完整的组合示例见 [`examples/`](./examples)：

- [`echo-agent`](./examples/echo-agent) —— mock LLM + echo tool 的最小示例
- [`coding-agent`](./examples/coding-agent) —— 接真实 DeepSeek LLM 的完整 coding agent
- [`acp-agent`](./examples/acp-agent) —— ACP server，含一个沙盒 composition variant

## 演示

Harness 作为 ACP agent 挂在 Zed 里 —— 边栏对话，工具调用（bash、文件编辑、diff）内联渲染在编辑区：

<p align="center">
  <video src="https://github.com/user-attachments/assets/a2bee95d-684f-41f4-b55f-1c14db0f24fa" controls width="800">
    浏览器不支持内联视频，可下载 <a href="./assets/demo-acp.mp4">assets/demo-acp.mp4</a> 查看。
  </video>
</p>

<!-- TODO: 后续加各功能特色演示视频（Code Mode / 动态工作流 / 自安装插件） -->

## 编写插件

Harness 的 function/namespace 插件通过分开的 `name` / `inject` / `apply` 命名导出注册，cordis Loader 读的是这些字段。**`export default` 不适用于这种形态** —— Loader 只会拿到 `apply` 函数，`inject` / `name` 被静默丢掉，加载时报 `cannot get property … without inject`（详见 [postmortem 0001](./docs/postmortem/0001-acp-default-export-drops-inject.md)）。`apply(ctx)` 内通过 `ctx.*` 注册 tool、挂载 LLM adapter 或暴露 service。

下面这个是 [`examples/echo-agent`](./examples/echo-agent) 里的真实 echo tool 插件：

```ts
// echo-tool.ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'echo-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'Echo the given text back, uppercased.',
    parameters: {
      text: { type: 'string', required: true },
    },
    async execute(args) {
      // args is typed: { text: string }
      return [{ type: 'text', text: `ECHO: ${args.text.toUpperCase()}` }]
    },
  }))
}
```

`parameters` 是 [schemastery](./vendor/schemastery) 的 JSON-Schema 风格 DSL —— 每个字段一项定义，`required: true` 标记必填。leaf `cordis.yml` 是 Loader 迭代的一个 flat `EntryOptions[]`，这个工具的条目长这样：

```yaml
- id: echo-tool
  name: './echo-tool.ts'          # your tool
```

同一份配置里还要有 LLM adapter 和一个 `stdio-agent` app 条目，`config.model` 指向 adapter 里注册的某个 model id。最小可跑组合 —— mock LLM + 这个 echo tool + 接到 `mock-echo` 的 `stdio-agent` —— 见 [`examples/echo-agent`](./examples/echo-agent)，运行命令：

```sh
pnpm run demo:echo
```

LLM adapter 与 UI 插件的写法见 [`docs/cookbook/extension-cookbook.md`](./docs/cookbook/extension-cookbook.md)。

## Packages

所有包都在 `@deepseek-ai/dsh-*` scope 下，按目录分组：

| 分组 | 包含 |
|---|---|
| **Core**（`packages/core/`）| `dsh-scope` · `dsh-session` · `dsh-tools` · `dsh-agent` · `dsh-agent-loop` · `dsh-system-prompt` |
| **LLM**（`packages/llm/`）| `dsh-llm`（seam）+ `dsh-llm-deepseek`（手写实现）与 `dsh-llm-pi-ai`（第三方库实现的孪生 —— 打同一个 DeepSeek endpoint，内部走不同代码路径，用于设计验证）|
| **Bash**（`packages/bash/`）| 命令行执行：本地 + 沙盒后端，模型可调用的 `bash` tool |
| **Filesystem**（`packages/fs/`）| 带策略层的文件服务，`read` / `write` / `edit` tools |
| **Web**（`packages/web/`）| 网页搜索（Perplexity、Exa、DeepSeek）+ fetch，模型可调用的 tool |
| **Sandbox**（`packages/sandbox/`）| 进程隔离接缝（bwrap / Landlock / Seatbelt）—— 按每次调用的策略包一层 argv，真正的执行由 `ctx.bash` 负责 |
| **Code runtime**（`packages/code-runtime/`）| Code Mode 分发进入的 JS worker 运行时 |
| **Sub-agents**（`packages/subagent/`）| `spawn` / `fork`，以及进程内 / 子进程 / ACP 后端 |
| **Workflows**（`packages/workflow/`）| 动态工作流编排（worker 线程执行）|
| **Skills**（`packages/skill/`）| Skill provider 注册中心（`ctx.skills`）+ 本地文件系统 provider |
| **Session persistence**（`packages/session-persistence/`）| 事件日志持久化：JSONL 与 SQLite 后端 |
| **Session query**（`packages/session-query/`）| `ctx.sessionQuery` —— 把 live sessions 和持久化层合成同一份逻辑语料的统一查询 |
| **Compact**（`packages/compact/`）| 上下文压缩 / 摘要 |
| **Context**（`packages/context/`）| 可选的请求上下文增强（如 `dsh-time-context` —— 系统提示词里注入动态时间）|
| **Cordis toolset**（`packages/cordis/`）| 模型可调用的、在运行时查看 / 挂载 / 卸载 cordis 插件的 tools |
| **UI apps**（`packages/ui/`）| `dsh-stdio-agent`（REPL）· `dsh-acp-agent`（ACP server）· `dsh-app-boot` · approval / ask-user 基础件 |
| **Hooks**（`packages/hooks/`）| Hook 协议 + Claude Code / OpenAI Codex 的 hook 配置桥 |
| **Guards**（`packages/guard/`）| 建议性的 loop 健康插件（如 `repeat-tool-guard` —— 检测同一 tool 重复调用并升级 advisory）|
| **Timeouts**（`packages/timeout/`）| `timeout-policy` —— 零配置的 `tools/execute` 包装，按 tool 声明的 `timeoutMs` 强制超时 |
| **Todo**（`packages/todo/`）| 模型可调用的 `todo_write` tool（整表任务追踪）|
| **Support**（`packages/support/`）| `invariants` —— 由默认组合 `dsh-agent-spine-demo` 无条件挂载的运行时诊断插件；此外是仅测试/开发用的辅助包（`llm-replay`、`acp-snapshot`、`subagent-mock`）|
| **Example bundles**（`packages/examples/`）| 顶层 `demo:*` 脚本直接跑的组合示例包：`dsh-agent-spine-demo`（默认 spine + 能力）、`dsh-stdio-demo`（REPL）、`dsh-acp-demo`（ACP server）、`dsh-jsonrpc-demo` |
| **Utils**（`packages/util/`）| 内部工具包（`brand`、`timeout`）|

完整的模块依赖图见 [`docs/module-graph.md`](./docs/module-graph.md)。

## 深入阅读

想理解 DeepSeek Harness 为什么与众不同，从这里入手：

- [架构](./docs/architecture.md) —— 服务分类和微内核结构
- [agent 生命周期](./docs/agent-lifecycle.md) —— 一次 turn 在 loop 里的流转（含时序图）
- [Cordis 入门](./docs/cordis-primer.md) —— 底层插件框架的实用入门
- [工具执行流水线](./docs/tool-execution-pipeline.md) —— 一次 tool 调用如何经过权限校验、hooks 和日志
- [能力接缝](./docs/capability-seams.md) —— 每个服务暴露的替换点
- [Code Mode](./docs/rfc/implemented/feature/2026-06-15-code-mode.md) —— 模型每个 turn 写一段 JS 程序，在一次运行里串起多次 bash / tool 调用。**多步操作 → 一次模型往返**，不是每次调用一次往返
- [动态工作流](./docs/rfc/implemented/feature/2026-07-05-dynamic-workflows.md) —— 模型写一段 JS orchestrator，把多个 sub-agent 并行 fan out、合并结果、再回到父 agent —— 而不是链式地调 subagent tool
- [自引用的 Cordis 工具集](./docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) —— SDK 自身的插件管理机制（`cordis_inspect` / `cordis_mount` / `cordis_unmount`）以 tool 的形式暴露给模型，让模型能在运行时查看当前运行时并按需挂载新插件

文档站：**[deepseek.com/harness-sdk/docs](https://deepseek.com/harness-sdk/docs)**。

## 社群

<a name="community"></a>

- **[GitHub Issues](https://github.com/deepseek-harness/deepseek-harness/issues)** —— Bug 反馈
- **[GitHub Discussions](https://github.com/deepseek-harness/deepseek-harness/discussions)** —— 功能建议、设计讨论、Q&A

企业微信讨论群通过腾讯问卷申请入群，专人筛选后邀请：

<img src="./assets/community-wecom-survey.png" alt="腾讯问卷 · 企业微信社群入群申请" width="220">

## License

[BSD 3-Clause](./LICENSE) &copy; DeepSeek
