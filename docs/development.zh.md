# 开发指南

[English](development.md) | 中文

本文面向参与项目开发的贡献者，帮助你上手本地环境、日常工作流和 CI 流程。相关设计考量和技术取舍参见 RFC，不在这里展开。

## 前置条件

- Node.js 支持 22.19+ 和 24+。CI 覆盖 22.19、24、26；见 [Node engine floor RFC](rfc/implemented/process/2026-07-06-node-engine-floor.md)。
- 启用了 Corepack 的 pnpm。仓库在 `package.json` 中钉住 `pnpm@11.7.0`；如果 `pnpm --version` 无法通过 Corepack 解析，先运行 `corepack enable`。
- Git。
- 可选：一个 DeepSeek API key，用于 REPL/ACP agent（智能体）演示和真实 API 的 e2e 测试。

## 首次搭建

在仓库根目录安装依赖：

```sh
pnpm install
```

安装同时会运行根目录的 `postinstall` 脚本，它通过 `scripts/install-lefthook.mjs` 从仓库 dev 依赖安装 lefthook；该包装脚本使用 lefthook 经过评审的 `--force` 模式，使已存在 `core.hooksPath` 的关联 worktree 不会让正常的 `pnpm run …` 命令失败。

如果因为依赖是从缓存恢复或 `postinstall` 被跳过而缺少钩子，手动安装：

```sh
pnpm exec lefthook install --force
```

新克隆后先跑一次类型检查：

```sh
pnpm run typecheck
```

这次首跑会构建 package/vendor 构建图，并跑根目录 no-emit `tsconfig.json` 图（覆盖 examples、tests 和 scripts）。根图使用同一份源码 `paths` 映射，但依赖 project references，因此 vendor 代码在它自己的 tsconfig 设置下被检查。

如果准备从新克隆或新 worktree 推送，还要构建一次：

```sh
pnpm run build
```

`pnpm run hygiene` 包含 `publint`（用构建出的 `lib/*.js` 文件校验 package 入口点）和 `verify-node-next-types`（用一个临时的 NodeNext 消费方校验构建出的声明文件）。新 worktree 在 `pnpm run build` 运行之前没有打包的 JS 和声明文件。

## 环境变量

真实的 DeepSeek 适配器和需要密钥的 agent 演示从环境变量或仓库根目录一个被 gitignore 的 `.env` 读取凭证：

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` 可选，默认为公开 API。绝不要提交真实凭证。未设置 `DEEPSEEK_API_KEY` 时，真实 API 的 e2e 套件会自动跳过。

## Git 钩子

lefthook 在 `lefthook.yml` 中配置，作为评审前的本地早期检查点：

- `pre-commit` 运行对暂存文件的 ESLint 修复、`pnpm run typecheck` 和 vendor manifest 守卫。
- `pre-push` 运行 `pnpm run check:pre-push`，其调度器并发运行单元测试、快照测试、build、module graph 新鲜度，以及 `pnpm run hygiene` 和 `pnpm run doc-sync` 的成员门禁。

vendor manifest 守卫检查 `vendor/*/src` 下的改动是否连同对应的 `vendor/README.md` manifest 更新一起暂存。编辑 vendor 代码前先看 `vendor/README.md`。

这些钩子并不与 CI 完全一致。特别是：`pre-push` 跑不带覆盖率的单元测试，而 CI 跑 `pnpm run test:coverage`；CI 还会跑 echo-agent 和 built-bin 冒烟测试，并在 Node 22.19、24 和 26 上跑兼容性矩阵。

## CI 门禁

keyless GitHub 工作流有八个 job：五个 Node 24 lane 分别运行 static gates、lint、coverage、snapshot replay 和 artifact gates，三个兼容性 job 在 Node 22.19、24 和 26 上运行 `pnpm run check:node-compat`。兼容性命令会在每个运行时上运行 TypeScript 类型检查和 keyless 的 workflow-workerthread 源码启动冒烟测试，因此该矩阵既证明源码图能通过类型检查，也会实际执行一条未构建的 Worker loader 路径；其他 lane 调度器并发运行来自 `package.json` 的独立门禁：constraints、lint、coverage、snapshot replay、`doc-sync` 成员、module graph 新鲜度、`knip` 和 echo-agent 冒烟测试。

`pnpm run build` 供给 artifact lane，`publint`、`verify-node-next-types` 和 built-bin 冒烟测试等待 build 输出。单独的真实 API 工作流带密钥运行 `pnpm run test:e2e`，并设置 `DSH_E2E_MAX_WORKERS=14`。

## 日常命令

在仓库根目录使用：

```sh
pnpm run test           # unit tests
pnpm run test:coverage  # unit tests with per-file coverage gates
pnpm run test:e2e       # real-API tests; self-skips without DEEPSEEK_API_KEY
pnpm run typecheck      # build package/vendor outputs, then typecheck examples, tests, and scripts
pnpm run lint           # eslint .
pnpm run lint:fix       # eslint . --fix
pnpm run doc-typecheck  # compile checked TypeScript snippets in Markdown docs
pnpm run gen-cordis-catalog     # regenerate docs/cordis-catalog/events.md + services.md from source
pnpm run verify-cordis-catalog  # fail if either cordis catalog is stale
pnpm run verify-export-jsdoc    # fail if a module-level package export lacks complete JSDoc
pnpm run gen-doc-graphs     # regenerate generated relationship docs from source and curated graph definitions
pnpm run verify-doc-graphs  # fail if generated relationship docs are stale
pnpm run gen-rfc-index          # regenerate the docs/rfc/README.md index tables from the RFC tree
pnpm run verify-md-wrap  # fail on hard-wrapped prose paragraphs in docs/README markdown
pnpm run verify-mermaid  # fail if a ```mermaid diagram has invalid Mermaid syntax
pnpm run verify-type-equiv  # fail if a ```ts type-equiv doc block drifts from its source type
pnpm run verify-doc-budgets  # fail if a budgeted standing doc exceeds its word ceiling
pnpm run doc-sync       # all Markdown/doc gates; see the doc-sync script in package.json for the full list
pnpm run gen-module-graph     # regenerate docs/module-graph.md from package peerDeps
pnpm run verify-module-graph  # fail if docs/module-graph.md is stale
pnpm run build          # emit lib/types intermediates, then bundle lib/index.* runtime files
pnpm run verify-node-next-types  # fail if built declarations are not NodeNext-consumable
pnpm run hygiene        # knip, publint, workspace constraints, and NodeNext declaration check
```

改动 package 的公开行为时，在同一个变更里更新相关 README 或 JSDoc。`pnpm run doc-sync` 能抓住被检查的 TypeScript 片段、生成文档新鲜度、markdown 换行/链接漂移、type-equiv、翻译配对、Mermaid 语法和文档预算，但更广泛的行文/API 同步仍需评审把关。

## 演示

echo 演示不需要 API 凭证：

```sh
pnpm run demo:echo
```

REPL agent 演示使用真实的 DeepSeek 适配器，需要环境变量或仓库根目录 `.env` 中的 `DEEPSEEK_API_KEY`：

```sh
pnpm run demo:repl
```

ACP 服务器 agent 演示通过 JSON-RPC stdio 暴露 agent，同样需要 `DEEPSEEK_API_KEY`：

```sh
pnpm run demo:acp
```

## TODO 标记

用三种注释标签之一标记代码中的已知问题，按紧急程度排序：

- `FIXME`——应当阻塞新版本发布的问题。除非评审者明确同意可以照常合入，发布不应带着未解决的 `FIXME` 出门。
- `TODO`——应当尽快修复的问题，等资源到位就处理。
- `XXX`——也许某天会修的问题；优先级最低，不作承诺。

选择与紧急程度匹配的标签，让扫代码的人一眼分清「发布阻塞」和「有空再说」。

## 逐字记录类型（`ts type-equiv`）

[核心数据结构](core-data-structures/core.md)文档粘贴真实的类型定义，让读者看到确切的形状。为防止粘贴内容在源码变化时漂移，把它围栏成 ` ```ts type-equiv `（而不是 ` ```ts `），并在 `scripts/type-equiv.manifest.json` 中登记它镜像的源文件和符号：

```json
{ "doc": "docs/core-data-structures/session.md", "symbol": "SessionEvent", "source": "packages/core/session/src/types.ts" }
```

`pnpm run verify-type-equiv`（`doc-sync` 的一环）随后通过 TypeScript 解析器从源码提取该符号的声明，并断言文档块与之一致（对空白和注释不敏感，因此文档块可以展示干净的定义，语义由行文承载）。它还强制 1:1 对应：每个 `ts type-equiv` 块恰好有一条 manifest 条目，反之亦然，因此不会有块被静默漏检，也不会有陈旧条目滞留。`doc-typecheck` 跳过 `ts type-equiv` 块（它们不能独立编译），并将其排除在 opt-out 比例之外。当你改动一个被记录的类型，门禁会失败直到你更新粘贴内容；当你增删一个块，在同一个变更里更新 manifest。

## 架构上下文

改动 `packages/` 下的任何东西之前先读 `docs/architecture.md`。这套代码围绕 Cordis 插件、事件溯源的会话、类型化的服务 seam（扩展点）与显式扩展点构建。
