# 开发指南

[English](development.md) | 中文

搭建教程引导新贡献者从准备前置条件开始，直到检出通过检查。后面的贡献者参考介绍仓库布局、日常工作流和 CI 形态。设计依据与实现细节属于链接的 Agent Note 和脚本。

## 搭建教程

### 前置条件

- Node.js 支持 22.19+ 与 24+。CI 覆盖 22.19、24 和 26；见 [Node 引擎下限 Agent Note](../.agents/notes/implemented/process/2026-07-06-node-engine-floor.md)。
- 启用了 Corepack 的 pnpm。仓库在 `package.json` 中固定使用 `pnpm@11.7.0`；如果 `pnpm --version` 无法通过 Corepack 解析，请先运行 `corepack enable`。
- Git 2.26 或更高版本；钩子设置会启用 Git 的 worktree 专属配置扩展。
- 可选：一个 DeepSeek API key，用于 Web、headless 和 ACP（Agent Client Protocol）自动化 agent（智能体）演示以及真实 API 的 e2e 测试。

### 首次搭建

在仓库根目录安装依赖：

```sh
pnpm install
```

安装过程还会通过 `scripts/install-lefthook.mjs` 配置 worktree 本地的 lefthook 钩子。其安全与迁移契约由 [worktree 本地钩子 Agent Note](../.agents/notes/implemented/process/2026-07-27-worktree-local-lefthook.md) 负责。

如果依赖是从缓存恢复或 `postinstall` 被跳过而导致缺少钩子，请手动安装：

```sh
node scripts/install-lefthook.mjs
```

如果包装脚本拒绝现有 Git 配置或报告陈旧锁，请遵循其诊断和所链接的 Agent Note，不要凭猜测编辑 worktree 元数据。移动检出目录后，请重新运行包装脚本以重新生成自有路径。

新克隆后请先运行一次类型检查：

```sh
pnpm run typecheck
```

`pnpm run typecheck` 成功退出即表示搭建完成。

## 贡献者参考

### TypeScript 项目布局

仓库类型检查会执行全仓 `tsc -b` 图：它会发射每个 package/vendor 的 `lib/types`，并通过两个 no-emit 聚合检查示例、测试和脚本。

仓库的 TypeScript 配置只有三种角色；每个 tsconfig 文件恰好扮演其中一种。

| 文件 | 角色 | 是否构成 program？ |
|---|---|---|
| `tsconfig.json` | solution 根：`extends` base、`files: []`、引用两个聚合。全仓 `tsc -b tsconfig.json` 图、tsserver 发现入口，并经继承的 `paths` 充当 tsx 运行 `examples/` 与 `scripts/` 时的解析配置（它们最近的 tsconfig 就是此文件）。 | 否 |
| `tsconfig.host.json` | host 聚合：host 侧各包（经 references）、示例、测试、脚本、website。排除 `packages/client`。 | 是 |
| `tsconfig.client.json` | client 聚合：`packages/client/*` 各包及其测试、`apps/web`。 | 是 |
| `tsconfig.base.json` | 共享 compilerOptions 与源码 `paths` 映射。同时是各 vitest 配置让 vite-tsconfig-paths 指向的解析门面：它没有 `include`，因此其 `paths` 适用于任何 importer。 | 否 |
| `tsconfig.base.client.json` | 浏览器编译形状（`jsx`、DOM lib、`types: []`），由 client 聚合和每个 `packages/client/*` 包 extends。 | 否 |

host 与 client 保持两个聚合 program，是因为两侧在相同键下以不同服务对 cordis `Context` 接口做声明合并；单一 program 同时看到两份合并会报冲突。这种冲突只存在于 `ts.Program` 内部——模块解析永远不会触发它——所以 solution 可以同时引用两个聚合，一个 paths 门面也可以横跨两侧。由此推出两条纪律：

- `tsconfig.base.json` 永不添加 `include` 或 `files`：它们会泄漏进每个 extends 它的包项目，并收窄门面的全匹配范围。
- 构造全仓 `ts.Program` 的脚本显式种子 `tsconfig.host.json` 或 `tsconfig.client.json`——永不种子根 solution，因为把两个聚合展平进一个 program 会撞上 `Context` 合并冲突。基于 program 的生成器与门禁（`scripts/ts-project.ts` 的消费者、doc-typecheck standalone 模式）按决策仅覆盖 host 侧；client 侧只在出现真实需求时再获得基于 program 的工具。

静态分析和测试通过 base 的 `paths` 映射把工作区 import 解析到 `src`，且必须在干净树上通过；消费构建产物 `lib/` 的门禁显式声明该依赖。决策记录：[solution-root note](../.agents/notes/implemented/process/2026-07-22-tsconfig-solution-root-two-aggregates.md)；tsc-first 发射管线见 [ts-build-config note](../.agents/notes/implemented/process/2026-06-17-ts-build-config.md)。

业务 Service 在 Host 使用 `@Remote` 或 `@RemoteContext` 声明可调用方法；Host 构建生成 Host-for-Client 类型与运行时贡献，Client 的 `client-remotes` 组合加载这些贡献并将具体方法挂载到 `ctx.api` 或对应的作用域 Context。两侧的生成产物、装配关系、SRC 开发回退和 Web 构建顺序见 [API Gateway](api-gateway.md)。

如果相关的本地检查需要使用构建后的包产物，请先构建一次：

```sh
pnpm run build
```

`pnpm run hygiene` 包含 `publint`（用构建出的 `lib/*.js` 文件校验 package 入口点）和 `verify-node-next-types`（用一个临时的 NodeNext 消费方校验构建出的声明文件）。新 worktree 在 `pnpm run build` 运行之前没有打包的 JS 和声明文件；普通提交和推送无需构建，除非所选检查会使用这些产物。

### 环境变量

真实的 DeepSeek 适配器和需要密钥的 agent 演示从环境变量或仓库根目录一个被 gitignore 的 `.env` 文件读取凭证：

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` 可选，默认为公开 API。请勿提交真实凭证。未设置 `DEEPSEEK_API_KEY` 时，真实 API 的 e2e 套件会自动跳过。

### Git 钩子

lefthook 在 `lefthook.yml` 中配置，作为快速的本地检查点：

- `pre-commit` 应用仅用于格式化的 ESLint 修复，使用 Oxlint 验证暂存文件并应用其原生修复，在暂存文件属于 `THIRD_PARTY_NOTICES.md` 的输入时重新生成该文件，然后检查暂存 diff 中的空白错误，并运行 vendor manifest（元数据清单）守卫；
- `pre-push` 只运行仓库增量类型检查（对根 solution 执行 `tsc -b`，覆盖 host 与 client 两个聚合）。

vendor manifest 守卫检查 `vendor/*/src` 下的改动是否连同对应的 `vendor/README.md` manifest 更新一起暂存。请在编辑 vendor 代码前先阅读 `vendor/README.md`。

这些钩子有意不运行测试、快照、文档检查、构建或 `hygiene`。贡献者只运行一次[与改动行为相关的检查](../AGENTS.md#run-relevant-checks-locally)；CI 负责全量覆盖率门禁、构建产物冒烟测试，以及 Node 22.19、24 和 26 兼容性矩阵。

贡献者可以选择运行 `pnpm run check:all`，执行全面的本地门禁集。该命令独立于两个 Git 钩子，也不是对 agent 的指令。

### CI 门禁

keyless [CI 工作流](../.github/workflows/ci.yml) 将独立门禁分组到若干宽粒度 lane，并在受支持的 Node 版本上运行一组较小的兼容性检查。产物消费方在各自 lane 内等待一次 build。单独的真实 API 工作流按其配置的 worker 上限运行 `pnpm run test:e2e`。当前门禁和 job 清单以 [scripts/run-gates.ts](../scripts/run-gates.ts) 和工作流文件为准。

### 日常命令

根目录的[贡献者说明](../AGENTS.md#commands)概述常用命令，[`package.json`](../package.json) 与 [scripts/run-gates.ts](../scripts/run-gates.ts) 则负责当前脚本和门禁清单。请选择覆盖变更表面的最小检查集。文档变更使用 `pnpm run doc-sync`；package 公开行为变更还需更新所属 README 或 JSDoc，而基于构建产物的检查需要先运行 `pnpm run build`。

### 演示

单次运行的 Headless coding agent 需要环境变量或仓库根目录 `.env` 中的 `DEEPSEEK_API_KEY`：

```sh
pnpm run demo:headless "summarize this workspace"
```

自指的 cordis 演示可以检查并修改其实时插件运行时，并需要相同的凭证（默认 `web`，也可用 `acp`）：

```sh
pnpm run demo:cordis
```

ACP 自动化服务器通过 JSON-RPC stdio 提供全新 agent 会话，同样需要 `DEEPSEEK_API_KEY`：

```sh
pnpm run demo:acp
```

### TODO 标记

请使用以下三种注释标签之一标记代码中的已知问题，按紧急程度排序：

- `FIXME`：应当阻塞新版本发布的问题。除非评审者明确同意该更改可以合并，否则发布版本不应包含未解决的 `FIXME`；
- `TODO`：应当尽快修复的问题，等资源到位即可处理；
- `XXX`：也许某天会修复的问题，优先级最低，不作承诺。

请选择与紧急程度匹配的标签，让浏览代码的人一眼分清「发布阻塞」和「有空再说」。

### 逐字记录类型（`ts type-equiv`）

[核心数据结构](core-data-structures/core.md)文档会把与源码等价的声明及其原始 JSDoc 一并粘贴，让读者看到确切形状和源码契约。为防止粘贴内容在源码变化时漂移，请将其围栏为 ` ```ts type-equiv `（而不是 ` ```ts `），并在 `scripts/type-equiv.manifest.json` 中登记它镜像的源文件和符号：

```json
{ "doc": "docs/core-data-structures/session.md", "symbol": "SessionEvent", "source": "packages/core/session/src/types.ts" }
```

`pnpm run verify-type-equiv`（`doc-sync` 的一环）随后通过 TypeScript 解析器从源码提取该符号的声明及其附带的 JSDoc，并断言代码块同时匹配两者。对于不应把实现体写进目录的类，请使用 ` ```ts public-api ` 并设置 `"projection": "public-api"`；门禁检查的投影会保留公共字段、构造函数、访问器、方法以及类和成员的原始 JSDoc，同时省略实现体和私有或受保护成员。比对会忽略空白和非 JSDoc 注释，但要求保留每条原始 JSDoc（包括成员文档），让读者同时看到源码契约和确切形状。该门禁按文档、符号和投影，在主块与 manifest 条目之间强制 1:1 对应；只有当配对 `.zh.md` 块的完整受跟踪围栏序列与其无后缀兄弟文件按字节一致且顺序相同时，才会复用后者的条目。`doc-typecheck` 对可编译围栏应用同一派生规则，同时跳过两种源码等价围栏的编译，并将其排除在 opt-out 比例之外。当你改动一个已记录的类型声明或其 JSDoc 时，门禁会失败直到你更新粘贴内容；当你增删一个主块时，请在同一个变更里更新 manifest。
