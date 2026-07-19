# 开发指南

[English](development.md) | 中文

本指南覆盖参与 DeepSeek Harness 开发所需的本地环境搭建、日常工作流与 CI 流程；设计动机与技术权衡请查阅相应 Agent Note。

## 前置条件

- Node.js 支持 22.19+ 与 24+。CI 覆盖 22.19、24 和 26；见 [Node 引擎下限 Agent Note](../.agents/notes/implemented/process/2026-07-06-node-engine-floor.md)。
- 启用了 Corepack 的 pnpm。仓库在 `package.json` 中固定使用 `pnpm@11.7.0`；如果 `pnpm --version` 无法通过 Corepack 解析，请先运行 `corepack enable`。
- Git。
- 可选：一个 DeepSeek API key，用于 REPL/ACP（Agent Client Protocol） agent（智能体）演示和真实 API 的 e2e 测试。

## 首次搭建

在仓库根目录安装依赖：

```sh
pnpm install
```

安装过程同时会运行根目录的 `postinstall` 脚本，该脚本通过 `scripts/install-lefthook.mjs` 从仓库 dev 依赖安装 lefthook。包装脚本使用 lefthook 经过评审的 `--force` 模式，确保已存在 `core.hooksPath` 的关联 worktree 不会导致正常的 `pnpm run …` 命令失败。

如果依赖是从缓存恢复或 `postinstall` 被跳过而导致缺少钩子，请手动安装：

```sh
pnpm exec lefthook install --force
```

新克隆后请先运行一次类型检查：

```sh
pnpm run typecheck
```

首次类型检查会执行 package/vendor 的构建图，以及根目录下用于示例、测试和脚本的 no-emit `tsconfig.json` 项目图。根图使用同一份源码 `paths` 映射，但依赖 project references，因此 vendor 代码在它自己的 tsconfig 设置下被检查。

如果准备从新克隆或新 worktree 推送，还需要构建一次：

```sh
pnpm run build
```

`pnpm run hygiene` 包含 `publint`（用构建出的 `lib/*.js` 文件校验 package 入口点）和 `verify-node-next-types`（用一个临时的 NodeNext 消费方校验构建出的声明文件）。新 worktree 在 `pnpm run build` 运行之前没有打包的 JS 和声明文件。

## 环境变量

真实的 DeepSeek 适配器和需要密钥的 agent 演示从环境变量或仓库根目录一个被 gitignore 的 `.env` 文件读取凭证：

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` 可选，默认为公开 API。请勿提交真实凭证。未设置 `DEEPSEEK_API_KEY` 时，真实 API 的 e2e 套件会自动跳过。

## Git 钩子

lefthook 在 `lefthook.yml` 中配置，作为评审前的本地早期检查点：

- `pre-commit` 运行对暂存文件的 ESLint 修复、`pnpm run typecheck` 和 vendor manifest（元数据清单）守卫；
- `pre-push` 运行 `pnpm run check:pre-push`，其调度器并发运行 runtime-closure 校验、单元测试、重复代码检查、快照测试、构建、module-graph 新鲜度，以及 `pnpm run hygiene` 与 `pnpm run doc-sync` 的各成员门禁。

vendor manifest 守卫检查 `vendor/*/src` 下的改动是否连同对应的 `vendor/README.md` manifest 更新一起暂存。请在编辑 vendor 代码前先阅读 `vendor/README.md`。

这些钩子并不与 CI 完全一致。特别是：`pre-push` 运行不带覆盖率的单元测试，而 CI 运行 `pnpm run test:coverage`；CI 还会运行 echo-agent 和 built-bin 冒烟测试，并在 Node 22.19、24 和 26 上执行兼容性矩阵。

## CI 门禁

keyless [CI 工作流](../.github/workflows/ci.yml) 将独立门禁分组到若干宽粒度 lane，并在受支持的 Node 版本上运行一组较小的兼容性检查。产物消费方在各自 lane 内等待一次 build。单独的真实 API 工作流按其配置的 worker 上限运行 `pnpm run test:e2e`。当前门禁和 job 清单以 [scripts/run-gates.ts](../scripts/run-gates.ts) 和工作流文件为准。

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

修改 package 的公开行为时，请在同一个变更中更新相关 README 或 JSDoc。`pnpm run doc-sync` 能检测到被检查的 TypeScript 片段、生成文档的新鲜度、Markdown 换行/链接漂移、type-equiv、翻译配对、Mermaid 语法和文档预算，但更广泛的行文/API 同步仍需评审把关。

## 演示

echo 演示不需要 API 凭证：

```sh
pnpm run demo:echo
```

repl-agent 示例使用面向行的 readline 前端，并需要环境变量或仓库根目录 `.env` 中的 `DEEPSEEK_API_KEY`：

```sh
pnpm run demo:repl
```

全屏 TUI 通过 pi-tui 前端复用 repl-agent 组装，并需要相同的凭证：

```sh
pnpm run demo:tui
```

自指的 cordis-agent 演示可以检查并修改其实时插件运行时，并需要相同的凭证：

```sh
pnpm run demo:cordis
```

ACP 服务器 agent 演示通过 JSON-RPC stdio 暴露 agent，同样需要 `DEEPSEEK_API_KEY`：

```sh
pnpm run demo:acp
```

## TODO 标记

请使用以下三种注释标签之一标记代码中的已知问题，按紧急程度排序：

- `FIXME`：应当阻塞新版本发布的问题。除非评审者明确同意该更改可以合并，否则发布版本不应包含未解决的 `FIXME`；
- `TODO`：应当尽快修复的问题，等资源到位即可处理；
- `XXX`：也许某天会修复的问题，优先级最低，不作承诺。

请选择与紧急程度匹配的标签，让浏览代码的人一眼分清「发布阻塞」和「有空再说」。

## 逐字记录类型（`ts type-equiv`）

[核心数据结构](core-data-structures/core.md)文档会把与源码等价的声明及其原始 JSDoc 一并粘贴，让读者看到确切形状和源码契约。为防止粘贴内容在源码变化时漂移，请将其围栏为 ` ```ts type-equiv `（而不是 ` ```ts `），并在 `scripts/type-equiv.manifest.json` 中登记它镜像的源文件和符号：

```json
{ "doc": "docs/core-data-structures/session.md", "symbol": "SessionEvent", "source": "packages/core/session/src/types.ts" }
```

`pnpm run verify-type-equiv`（`doc-sync` 的一环）随后通过 TypeScript 解析器从源码提取该符号的声明及其附带的 JSDoc，并断言代码块同时匹配两者。对于不应把实现体写进目录的类，请使用 ` ```ts public-api ` 并设置 `"projection": "public-api"`；门禁检查的投影会保留公共字段、构造函数、访问器、方法以及类和成员的原始 JSDoc，同时省略实现体和私有或受保护成员。比对会忽略空白和非 JSDoc 注释，但要求保留每条原始 JSDoc（包括成员文档），让读者同时看到源码契约和确切形状。该门禁还按文档、符号和投影强制 1:1 对应，因此不会有块被静默漏检，也不会有陈旧条目滞留。`doc-typecheck` 跳过两种围栏（它们不能独立编译），并将其排除在 opt-out 比例之外。当你改动一个已记录的类型声明或其 JSDoc 时，门禁会失败直到你更新粘贴内容；当你增删一个块时，请在同一个变更里更新 manifest。

## 架构上下文

在修改 `packages/` 目录下的任何内容之前，请先阅读 `docs/architecture.md`。这套代码围绕 Cordis 插件、事件溯源的会话、类型化的服务 seam 与显式扩展点构建。
