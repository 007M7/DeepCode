# 开发指南

[English](development.md) | 中文

本指南覆盖参与 DeepSeek Harness 开发所需的本地环境搭建，并帮助你理解本地钩子、日常检查与 CI 门禁。

## 前置条件

- Node.js 24 或更新版本。仓库声明 `node >=24`；CI 在 Node 24 和 26 上跑矩阵。
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
- `pre-push` 运行 `pnpm run test`、`pnpm run test:snapshot`、`pnpm run hygiene`、`pnpm run doc-sync` 和 `pnpm run verify-module-graph`。

vendor manifest 守卫检查 `vendor/*/src` 下的改动是否连同对应的 `vendor/README.md` manifest 更新一起暂存。编辑 vendor 代码前先看 `vendor/README.md`。

这些钩子并不与 CI 完全一致。特别是：`pre-push` 跑不带覆盖率的单元测试，而 CI 跑 `pnpm run test:coverage`；CI 还会跑 echo-agent 和 built-bin 冒烟测试，并在 Node 24 和 26 上跑矩阵。

## CI 门禁

GitHub 工作流在每个 pull request 上运行这些门禁：

- `pnpm install --frozen-lockfile`
- `pnpm run constraints`
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run doc-sync`
- `pnpm run verify-module-graph`
- `pnpm run test:coverage`
- `pnpm run test:snapshot`
- `pnpm run build`
- `pnpm run hygiene`
- 一个 echo-agent 冒烟测试，检查演示的工具调用、工具结果和 JSONL 输出
- built-bin 冒烟测试，用纯 `node` 运行发布产物 `lib/bin.js` 入口

`pnpm run hygiene` 是 `pnpm run knip && pnpm run publint && pnpm run constraints && pnpm run verify-node-next-types` 的本地简写；CI 还会把 `pnpm run constraints` 作为更早的快速失败步骤单独跑一次，然后在 `pnpm run build` 之后跑完整的 hygiene 脚本。

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
pnpm run gen-rfc-index          # regenerate the docs/rfc/README.md index tables from the RFC tree
pnpm run verify-md-wrap  # fail on hard-wrapped prose paragraphs in docs/README markdown
pnpm run verify-type-equiv  # fail if a ```ts type-equiv doc block drifts from its source type
pnpm run verify-doc-budgets  # fail if a budgeted standing doc exceeds its word ceiling
pnpm run doc-sync       # all Markdown/doc gates; see the doc-sync script in package.json for the full list
pnpm run gen-module-graph     # regenerate docs/module-graph.md from package peerDeps
pnpm run verify-module-graph  # fail if docs/module-graph.md is stale
pnpm run build          # emit lib/types intermediates, then bundle lib/index.* runtime files
pnpm run verify-node-next-types  # fail if built declarations are not NodeNext-consumable
pnpm run hygiene        # knip, publint, workspace constraints, and NodeNext declaration check
```

改动 package 的公开行为时，在同一个变更里更新相关 README 或 JSDoc。`pnpm run doc-sync` 能抓住被检查的 TypeScript 片段、cordis 事件/服务目录漂移和硬折行的 markdown 段落，但更广泛的行文/API 同步仍需评审把关。

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
