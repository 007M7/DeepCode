# Harness 接线事实清单：程序化 boot cordis root + agent spine

核实日期：2026-07-19。所有相对路径均相对 worktree 根 `/weka-hg/prod/deepseek/permanent/ys/private/workspace/github/deepseek-harness/.vscode/worktrees/worktree-web2`。行号以当前 HEAD（9eb1fbd5d）为准。

## 1. 程序化 boot 最小做法（不经 Loader / cordis.yml）

我们自己做一个 preset 放在 apps/dsc 下面，就像 agent-spine-demo 一样。（但是我们这里全拍平，不依赖其他 preset 包）
还允许开发者配置 cordis.yml 读取 ~/.dsc/cordis.yml
所以，我们这个也算一个 （portal）独立入口了。

### 1.1 核心 API：`new Context()` + `ctx.plugin()` + await fiber

- `ctx.plugin(plugin, config)` 返回一个 thenable fiber：`vendor/cordis/src/registry.ts:315-335`。`wrapped.then` 直接代理到 `fiber.await()`（`registry.ts:330-333`），所以 **`await ctx.plugin(X, config)` 就是"等该插件 fiber 稳定并重抛启动错误"** —— 没有独立的 `ctx.start()`。
- `Fiber.await()` 语义（等 inertia 清空、`_error` 存在则 throw）：`vendor/cordis/src/fiber.ts:701-707`。
- 停机侧对应物是 `ctx.fiber.dispose()`（Fiber 的 `dispose` 字段声明在 `vendor/cordis/src/fiber.ts:193`）。

### 1.2 仓库内现成的"纯程序化装满 spine"范例

最完整的一份在 `packages/context/workspace-context/tests/workspace-context.e2e.ts:37-53`：

```
ctx = new Context()                                             // :37
await ctx.plugin(LlmService)                                    // :38  @deepseek-ai/dsh-llm
await ctx.plugin(SessionStore)                                  // :39  @deepseek-ai/dsh-session
await ctx.plugin(SystemPrompt, { persona: '...' })              // :40  @deepseek-ai/dsh-system-prompt
await ctx.plugin(ToolRegistry)                                  // :41  @deepseek-ai/dsh-tools
await ctx.plugin(AgentRegistry)                                 // :42  @deepseek-ai/dsh-agent
await ctx.plugin(LocalFileSystem, { cwd: '/' })                 // :43  @deepseek-ai/dsh-fs-local
await ctx.plugin(ToolFs)                                        // :44
await ctx.plugin(WorkspaceContext, { maxBytes: 65536 })         // :45
await ctx.plugin(AgentLoop, { agents: [] })                     // :46  @deepseek-ai/dsh-agent-loop
await ctx.plugin(LlmDeepSeek, { models: [{ id: 'deepseek-v4-flash' }] })  // :47
const handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider: 'deepseek', model: 'deepseek-v4-flash' } })  // :48-52
```

teardown 用 `await ctx?.fiber.dispose()`（同文件 `:27`）。等空闲的方式是订阅 `ctx.on('agent/status', ...)` 等 `'idle'`（`:56-65`）。

更小的官方 helper：`packages/support/agent-loop-testkit/src/index.ts:37-46`（`mountAgentLoopTestDependencies`）依次 `await ctx.plugin()` 挂 LlmService / SessionStore / SystemPrompt / ToolRegistry / AgentRegistry，注释明确"await 逐个装，失败即 reject"。

### 1.3 更省事的做法：直接装 spine bundle 插件

`@deepseek-ai/dsh-agent-spine-demo` 是一个"函数插件 bundle"，其 `apply()` 一次性挂全默认 spine（`packages/examples/agent-spine-demo/src/index.ts:136-170`），子插件与传参逐个是：

| 顺序 | 插件 | config 形状 | 行号 |
|---|---|---|---|
| 1 | `@cordisjs/plugin-timer` (Timer) | 无 | :144 |
| 2 | `@deepseek-ai/dsh-llm` (LlmService) | 无 | :145 |
| 3 | `@deepseek-ai/dsh-session` (SessionStore) | 无 | :146 |
| 4 | `@deepseek-ai/dsh-system-prompt` | `{ persona, toolOrder? }` | :148-151 |
| 5 | `@deepseek-ai/dsh-tools` (ToolRegistry) | `config.tools ?? {}` | :152 |
| 6 | `@deepseek-ai/dsh-skill` (SkillService) | `config.skills?.registry ?? {}` | :153 |
| 7 | `@deepseek-ai/dsh-skill-local` | `{ ...skills.local, dshHome }` | :154 |
| 8 | `@deepseek-ai/dsh-agent` (AgentRegistry) | 无 | :155 |
| 9 | `@deepseek-ai/dsh-tasks` (TaskService) | 无 | :156 |
| 10 | `@deepseek-ai/dsh-invariants` | 无 | :157 |
| 11 | `@deepseek-ai/dsh-tool-bash` | `{ ...toolBash, dshHome }` | :158 |
| 12 | `@deepseek-ai/dsh-workspace-context` | `config.workspaceContext`（`false` 时不装） | :159-161 |
| 13 | `@deepseek-ai/dsh-tool-skill` | `config.skills?.tool ?? {}` | :164 |
| 14 | `@deepseek-ai/dsh-tool-tasks` | `config.toolTasks ?? {}` | :165 |
| 15 | `@deepseek-ai/dsh-agent-loop` (AgentLoop) | `{ agents: config.agents ?? [], maxParallelToolCalls? }` | :166-169 |

要点：

- **装载顺序无关紧要**（cordis 按 `inject` 挂起 fiber 直到依赖服务出现），列表顺序只为可读性 —— 该文件 JSDoc 明说（`:130-134`）。但两个 session-prefix 生产者（workspaceContext 与 toolSkill）的注册顺序 = 渲染顺序（`:162-164`）。
- bundle 不装 LLM 适配器、bash 执行器、持久化、UI —— 那些是"部署选择"，由外层继续 `ctx.plugin()`（如 `LlmDeepSeek`、`@deepseek-ai/dsh-bash-local`、`SessionPersistenceJsonl`）。
- bundle 的 `apply()` 内部 `ctx.plugin()` **不 await**；stdio-demo 单测挂完后靠 `setTimeout 80ms` 等子 fiber 稳定（`packages/examples/stdio-demo/tests/stdio-agent.spec.ts:19-27` 及其注释 "The app mounts its children inside apply() (not awaited there)"）。程序化 boot 若要确定性等待，逐个 `await ctx.plugin()`（1.2 的做法）更稳。

### 1.4 stdio-demo 的组合形状（composeTerminalApp，作为 app 层参照）

`packages/examples/stdio-demo/src/index.ts:143-173`：先按 TTY 选 UI 模式（readline 时装 `@cordisjs/plugin-logger-console`，`:147`），然后依次 `ctx.plugin(SessionPersistenceJsonl, { root })`（`:148`）、`ctx.plugin(UserInteractionService)`（`:149`）、选定的 `uiTui`/`uiStdio`（带 `welcome`+`sessionId`，`:150-161`）、`ctx.plugin(agentCore, { ...pickSpineConfig(config), agents: [{ id, provider, model, cwd: process.cwd(), sessionId | resumeSessionId }] })`（`:162-171`）、最后 `ctx.plugin(toolAskUser)`（`:172`）。

### 1.5 Loader 路径的 boot（对照，dsh-app-boot）

`packages/ui/app-boot/src/index.ts:114-126` 的 `boot()`：`new Context()` → 设 `ctx.baseUrl`（`:116`）→ `await ctx.plugin(Loader)`（`:117`）→ 注册 include builtin（`:118`）→ `ctx.loader.create({ name: 'cordis:include', config: { path } })`（`:119-122`）→ **`await ctx.loader.await()`** 等整树稳定（`:123`；实现是 `vendor/loader/src/config/tree.ts:43-49`，循环 `Promise.allSettled` 所有 pending 任务）→ `assertEntriesLoaded()` 拒绝无 fiber 条目（`:124`，实现 `:89-95`）。

## 2. acp-demo 不预建 agent 的写法

- acp-demo 的 `apply()` 里 **根本不给 spine 传 `agents` 字段**：`ctx.plugin(agentCore, agentCore.pickSpineConfig(config))`（`packages/examples/acp-demo/src/index.ts:90`）。`pickSpineConfig` 的类型就是 `Omit<Config, 'agents'>`（`packages/examples/agent-spine-demo/src/index.ts:112`）。
- 缺省落到 spine 的 `agents: config.agents ?? []`（`packages/examples/agent-spine-demo/src/index.ts:167`），最终是 AgentLoop schema 的 `.default([])`（`packages/core/agent-loop/src/index.ts:413-419`）；AgentLoop 构造器只对 `config.agents` 里的条目预建 agent（`:440` 起的 for 循环），空列表即什么都不建。
- 语义注释两处：spine 的 Config JSDoc "`agents` to the agent loop (an app that pre-creates no agents, like the ACP bridge, simply omits it)"（`packages/examples/agent-spine-demo/src/index.ts:43-44`）；acp-demo Config JSDoc "NOT a pre-created agent — ACP creates agents at `session/new`"（`packages/examples/acp-demo/src/index.ts:27-28`）与 apply JSDoc "pre-creates NO agents (its `agents` list defaults to `[]`) ... creates one agent per `session/new`"（`:83-87`）。
- agent 真正被创建的时机：ACP bridge 收到 `session/new` RPC 时 `await agents.create({ sessionId, meta: { cwd: params.cwd }, agentOptions: agentOptions(config), setup })`（`packages/ui/acp/src/index.ts:654-668`，`agents.create` 在 `:662`）。

## 3. DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / 根 .env 的读取链路

三层，全部与 dotenv 包和 `node --env-file` 无关：

1. **bin 层读 `.env` 进 process.env**：`loadEnv()` 用 Node 内建 `process.loadEnvFile(resolve(dir, '.env'))`，dir 默认 `process.cwd()`；ENOENT 静默回退到环境（`packages/ui/app-boot/src/index.ts:40-52`，`loadEnvFile` 调用在 `:45`）。各 bin 在 boot 前调用：stdio-demo `src/bin.ts:17`、acp-demo `src/bin.ts:23`（replay 快照模式跳过）、jsonrpc-demo `src/bin.ts:20`。
2. **cordis.yml 层用 `!!js` 把 env 显式喂进插件 config**：`examples/repl-agent/cordis.yml:18-19`（`apiKey: !!js process.env.DEEPSEEK_API_KEY`、`baseURL: !!js process.env.DEEPSEEK_BASE_URL`）；acp-agent 同款（`examples/acp-agent/cordis.yml:10-11`）。
3. **插件层兜底再读一次 process.env**：`@deepseek-ai/dsh-llm-deepseek` 的 `apply()` 里 `config.apiKey ?? process.env.DEEPSEEK_API_KEY`（缺 key 直接 throw，load 期 fail loud）与 `config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? PUBLIC_BASE_URL`（`packages/llm/llm-deepseek/src/index.ts:82-86`）。所以**程序化 boot 只要 process.env 里有 key，`ctx.plugin(LlmDeepSeek, {})` 即可工作**（1.2 范例正是这么干的）。

## 4. 停机 / dispose

统一原语：**`ctx.fiber.dispose()`**（root context 自己的 fiber）。各 demo 的触发方式：

- **jsonrpc-demo（信号处理最完整的样板）**：`packages/examples/jsonrpc-demo/src/bin.ts:39-51` —— `disposeAndExit(code)` 带 `exiting` 单次门闩，`try { await ctx.fiber.dispose() } finally { process.exit(code) }`；接线为 `process.stdin.on('end') → 0`、`SIGTERM → 0`、`SIGINT → 130`（`:49-51`）。
- **acp-demo**：仅快照模式在 stdin EOF 时 `void ctx.fiber.dispose().then(() => process.exit(0))`（`packages/examples/acp-demo/src/bin.ts:30-34`）；正常运行 "editors normally own process lifetime"（`:8`），无信号处理。
- **cli-demo**：bin 层不直接 dispose——SIGINT/SIGTERM 只 abort 一个 AbortController 并记退出码 130/143（`packages/examples/cli-demo/src/bin.ts:15-33`）；dispose 在 cli.ts 内部：`runtime.dispose ?? (target => target.fiber.dispose())`（`packages/examples/cli-demo/src/cli.ts:409`），任务收尾时 `await disposeContext(ctx)`（`:438`）。
- **stdio-demo**：bin 无信号处理（`src/bin.ts` 全文仅 19 行）；退出由 stdio UI 插件驱动——stdin EOF 后 `maybeExit()` 等 agent idle，再经 200ms flush 定时器调 `exit(0)`（默认 `process.exit`）（`packages/ui/stdio/src/index.ts:212-229`，默认 exit 钩子 `:464`）。
- 测试里的顺序惯例：先 `await ctx.fiber.dispose()` 再清理临时目录（`packages/context/workspace-context/tests/workspace-context.e2e.ts:26-31`）。

## 5. pnpm-workspace.yaml 现状（全文）

`pnpm-workspace.yaml` 全文如下。**glob 是 `packages/*/*`（`:3`），目前没有 `apps/*`**；成员为 `vendor/*`、`packages/*/*`、`website`、`examples`（仅依赖解析、非构建目标，见 `:5-10` 注释）、`python/sdk-runtime`。

```yaml
packages:
  - vendor/*
  - packages/*/*
  - website
  # The runnable demo leaves join as ONE workspace member: examples/package.json
  # declares the union of every leaf's cordis.yml plugins as workspace:*, so a
  # plain-node (`:lib`) boot of any leaf (examples/<leaf>/cordis.yml) resolves its
  # plugins through real package `exports`→lib by walking up to examples/node_modules.
  # Members for DEPENDENCY RESOLUTION only — NOT build targets: tsdown's explicit
  # globs (vendor/*, packages/*/*) exclude them. See the example-execute-over-tsx RFC.
  - examples
  # Deploy root of the single-exe build: a pure dependency manifest whose
  # closure is what the exe bundles and what the Python runtime distributes.
  - python/sdk-runtime

peerDependencyRules:
  allowedVersions:
    typescript: '>=5 <7'

# pnpm 10+ blocks any dependency shipping an install/build script until it is
# explicitly reviewed here (strictDepBuilds defaults to true: an unlisted script
# is a hard install error). Every such package MUST be listed; we deny by
# default and only allow scripts we need. esbuild (native binary) and lefthook
# (git hooks) genuinely need theirs.
allowBuilds:
  esbuild: true
  lefthook: true
  # Pulled in by @earendil-works/pi-ai (optional LLM API backend). pnpm lists
  # them only because they ship lifecycle scripts, but those are no-ops we don't
  # need, so we deny them — install still succeeds.
  '@google/genai': false
  protobufjs: false
  node-addon-require-builtin: false

# The Landlock launcher family is our own sibling-repo release, consumed
# fresh (hours old at each coordinated bump) — the release-age quarantine
# would block every such bump, so the family is exempted BY NAME, not by
# pinned version.
minimumReleaseAgeExclude:
  - node-addon-landlock-run
  - node-addon-landlock-run-linux-arm64
  - node-addon-landlock-run-linux-x64
  # Cordis release candidates are source-vendored and pinned in vendor/README.md
  # during the same-day sync that updates package manifests and the lockfile.
  - '@cordisjs/plugin-loader@1.0.0-rc.5'
  - cordis@4.0.0-rc.7
```

tsdown 侧印证 "examples 目录非构建目标"：根 `tsdown.config.ts:16` 只 bundle `workspace: ['vendor/*', 'packages/*/*']`。

## 6. demo 脚本运行方式与构建产物

- **demo 脚本全部是 tsx 跑 src**（根 `package.json:81-87`）：
  - `demo:echo` / `demo:repl` / `demo:tui` / `demo:cordis`：`node --expose-internals --import tsx packages/examples/stdio-demo/src/bin.ts examples/<leaf>/cordis.yml`（`:81,82,84,86`；`--expose-internals` 是 HMR 需要）
  - `demo:headless`：`node --expose-internals --import tsx packages/examples/cli-demo/src/bin.ts --config examples/headless-agent/cordis.yml`（`:83`）
  - `demo:acp`：`node --import tsx packages/examples/acp-demo/src/bin.ts --config examples/acp-agent/cordis.yml`（`:87`，无 `--expose-internals`，因 ACP 无 HMR）
- **发布/built 路径是 plain node 跑 `lib/bin.js`**：built-bin e2e 明确 "run `lib/bin.js` under plain Node ... NO tsx"（`packages/examples/stdio-demo/tests/built-bin.e2e.ts:10,17,112`）。
- **构建管线**：`build = tsc -b tsconfig.build.json && tsdown`（根 `package.json:16`）。tsc 先出 `lib/types/*.js + d.ts`，tsdown 从 `lib/types/index.js` bundle 出 `lib/index.js`（根 `tsdown.config.ts:12-27`，`dts: false`）。**带 bin 的包需要自己的 tsdown override 加第二个 entry**：`packages/examples/stdio-demo/tsdown.config.ts` 的 `entry: ['lib/types/index.js', 'lib/types/bin.js']`（acp-demo 同款）。
- bin 字段指向构建产物：`"bin": { "dsh-stdio-demo": "lib/bin.js" }`（`packages/examples/stdio-demo/package.json:9-11`）、`"dsh-acp-demo": "lib/bin.js"`（`packages/examples/acp-demo/package.json:9-11`）。

## 7. 三个 examples 包 package.json 形状（新包模板参考）

共同形状（三个包一致）：

- `"name": "@deepseek-ai/dsh-<pkg>"`、`"version": "0.0.1"`、`"private": true`、`"type": "module"`、`"license": "BSD-3-Clause"`
- `"main": "lib/index.js"`、`"types": "lib/types/index.d.ts"`
- `exports`：`"."` → `{ types: ./lib/types/index.d.ts, default: ./lib/index.js }`；有 bin 的再加 `"./bin"` 同构；一律带 `"./src/*": "./src/*"` 和 `"./package.json": "./package.json"`
- `files`：`lib/index.js`（+ `lib/bin.js`）、`lib/types/**/*.d.ts`、`lib/types/**/*.d.ts.map`、`src`
- **依赖模式：所有运行时依赖同时出现在 `peerDependencies`（`^0.0.1` / cordis `^4.0.0-rc.7`）和 `devDependencies`（`workspace:^`）**，符合根约定 "cordis is a peerDependency (+ dev) of every harness package"。

逐包：

- **stdio-demo**（`packages/examples/stdio-demo/package.json`）：有 `bin`（`:9-11`）、`./bin` export（`:17-20`）；peers 含 plugin-include/plugin-loader/plugin-logger-console、dsh-app-boot、dsh-agent、dsh-agent-loop、dsh-llm、dsh-agent-spine-demo、dsh-workspace-context、dsh-session、dsh-session-persistence-jsonl、dsh-stdio、dsh-tui、dsh-tool-ask-user、dsh-tools、dsh-user-interaction、cordis、schemastery（`:32-51`）。
- **agent-spine-demo**（`packages/examples/agent-spine-demo/package.json`）：无 bin；peers 是 spine 全家（timer、agent、agent-loop、invariants、home、llm、workspace-context、session、skill、skill-local、system-prompt、tasks、tool-bash、tool-skill、tool-tasks、tools、cordis，`:24-42`）；**特例：`schemastery` 在 `dependencies` 而非 peer**（`:63-65`）。
- **acp-demo**（`packages/examples/acp-demo/package.json`）：有 `bin`（`:9-11`）；peers 含 plugin-include/plugin-loader（无 logger-console —— stdout 纯 JSON-RPC）、dsh-app-boot、dsh-acp、dsh-agent-spine-demo、dsh-workspace-context、dsh-session-persistence-jsonl、dsh-tools、dsh-user-interaction、cordis、schemastery（`:32-44`）。

## 附：repl-agent cordis.yml 的 Loader 声明式全量清单（对照）

`examples/repl-agent/cordis.yml` 挂载（id → 包名，含 config 要点）：`hmr`（root `['.']`，`:9-12`）、`llm-deepseek`（apiKey/baseURL 走 `!!js` env，`:15-19`）、`bash` = dsh-bash-local（`timeoutMs: 60000`，`:22-25`）、`stdio-agent` = dsh-stdio-demo（provider/model、resumeSessionId `!!js`、persistenceRoot `./.sessions`、workspaceContext.maxBytes 65536、ui.mode readline、persona，`:28-48`）、`token-meter`（`:51-52`）、`compact-basic`（`:56-57`）、`subagent` + `subagent-spawn` + `subagent-fork` + 两个 `tool-subagent`（`:62-85`）、`workflow-workerthread` + `tool-workflow`（`:90-96`）、`tool-todo`（`:98-99`）、`fs-local`（`cwd: !!js process.cwd()`，`:104-106`）、`fs-policy`（`:108-109`）、`tool-fs`（`:111-112`）、`tool-fs-search`（`:117-118`）、`timeout-policy`（`:124-125`）、`spill-local` + `spill-policy`（`maxInlineBytes: 50000`，`:132-138`）。
