# RFC：将示例应用提取为 package

Status: implemented

[English](2026-06-20-extract-example-app-packages.md) | 中文

## 问题

示例目录本应是*薄*的：只包含演示的可变接线，而非演示的机制本身。在本次变更之前它是厚的。每个示例都携带一份手写的 `start.ts` 启动引导、一段基础设施前导（`timer`，以及 stdio 演示还需要的 `logger` + `hmr`）、三个共享 YAML 片段的嵌套引入（`base.yml` / `base-core.yml` / `acp-agent/acp-tail.yml`），以及每个示例各自的 `agent-loop`/持久化/系统提示词配置。真正的应用——每个 agent 都需要的服务主干——分散在叶子配置和那些 include 中。

叶子配置还拥有一个耦合的前门。ACP 要求 stdout 纯净，通过 `session/new` 创建 agent；stdio 需要控制台 logger 和一个预创建的 `main`。防止错误组合的唯一手段是行文中的警告，而三个 `start.ts` 文件重复了 Loader 引导和生命周期代码。

## 决策

每个示例现在**基本上是对一个 app package 的调用**，沿着既有的[接口 / 实现 / 消费方 seam](2026-06-13-capability-seams.md) 拆分接线：**app 包拥有组合**，叶子 `cordis.yml` 只拥有**可替换的选择**（哪个 LLM 适配器、哪个 bash 执行器、模型、提示词、持久化根目录）。

- **`@deepseek-ai/dsh-agent-spine-demo`**（[packages/examples/agent-spine-demo](../../../../packages/examples/agent-spine-demo)）组合无提供方、无执行器、无 UI 的主干，并转发 loop 的 agent 列表配置。它对具体 loop 的依赖是有意为之，因为这个包组合的是主干而非扩展它；替换 loop 意味着提供另一个 bundle。
- **`@deepseek-ai/dsh-stdio-demo`**（[packages/examples/stdio-demo](../../../../packages/examples/stdio-demo)）和 **`@deepseek-ai/dsh-acp-demo`**（[packages/examples/acp-demo](../../../../packages/examples/acp-demo)）各自内置了前门。Stdio 包含 `ui-stdio`、控制台 logger 和 `main`；ACP 包含 bridge 和 JSONL 持久化，但不含 stdout logger 或预创建的 agent。叶子可以追加插件，但安全的组合现在是默认产物。
- **`start.ts` 已移除。** 每个 app 包暴露一个 `bin`（`dsh-stdio-demo` / `dsh-acp-demo`）；`demo:*` 脚本调用它（如 `dsh-stdio-demo ./cordis.yml`）。Loader 引导尾部、`.env` 加载和 fail-loud 守卫位于共享的 [`@deepseek-ai/dsh-app-boot`](../../../../packages/ui/app-boot) 包（在逐文件覆盖率门禁下有单元测试——见[共享 app bin 的启动胶水](../simplification/2026-07-04-share-app-bin-boot-glue.md)）；每个 bin 是一个薄的自执行组合，基于这些辅助函数加上自身特有的生命周期逻辑（ACP bin：快照模式选择与 stdin-dispose）。`bin.ts` 文件本身仍排除在覆盖率之外（自执行 CLI 入口，与旧的 `start.ts` 类似），由 keyless Loader 路径测试驱动。
- **每个叶子 `cordis.yml` 精简**为后端 + 配置：LLM 适配器（带 apiKey/models 的 `llm-deepseek`，或 `llm-replay`）、bash 执行器（`bash-local`）、stdio 演示的 `hmr`（见下方修正），以及一个 app 条目承载 app 的配置（模型、系统提示词、持久化根目录——作为 app 包自身的 `Config` 暴露，由 app 将每个值路由到其接线的目标位置：stdio 路由到预创建的 agent，acp 路由到 bridge 插件）。
- **echo-agent 折叠到 `dsh-stdio-demo`**，将 LLM 后端替换为本地的 `mock-llm`，并在叶子层添加本地的 `echo-tool`（加上 `bash-local`，由主干的 `tool-bash` 注入）——这是「替换后端、保留应用」的干净示范。`mock-llm.ts` / `echo-tool.ts` 作为示例本地的教学插件保留。
- **`base.yml`、`base-core.yml` 和 `acp-agent/acp-tail.yml` 退役**——它们共享的主干现在位于 `dsh-agent-spine-demo`。

`bash-local` 和 LLM 适配器保持为**叶子选择**：bundle 提供 `tool-bash`（消费方 schema），叶子选择执行器实现，因此沙箱执行器或回放适配器可以在不触碰 app 的情况下替换进来。

### 实现修正：`hmr` 保留为叶子条目

提案将 `hmr` 列入 stdio app 内置的前门集群。对照代码验证后发现，将 `hmr` 内置到 `dsh-stdio-demo` 包在两方面与 Cordis 冲突，因此改为作为**叶子 `cordis.yml` 条目**交付：

1. `@cordisjs/plugin-hmr` 是一个仅限 Loader、仅限子进程的开发插件——其构造函数在没有 `node --expose-internals` 和活跃 `loader` 服务的情况下会抛出异常，因此只能在真实的 `demo:*`/bin 子进程中运行，无法在进程内的单元/覆盖率测试层运行。
2. 进程内测试层（vitest）甚至无法*导入* vendor 的 `hmr` 模块（其 class-decorator `@Inject` 形式在 Vite 的 transform 下会失败），因此一个 `apply` 静态导入了它的包永远无法满足其主函数的逐文件 100% 覆盖率门禁。

关键在于，`hmr` **不是**像控制台 logger 那样的 stdout 纯净隐患——在 ACP 配置中误加 `hmr` 不会破坏 JSON-RPC 帧——因此将它留在叶子不会损失耦合论证所关注的安全性。**logger**（真正的耦合）保持内置：stdio app 包含它，ACP app 省略它。

## 曾考虑的替代方案

### 为什么不继续用共享 YAML include 来接线？

旧的 `base*.yml`/`acp-tail.yml` include 已经去重了*配置*，但 YAML include 无法**封装**前门耦合——它只能在注释中描述，并信任每个叶子遵守。它也无法拥有 `bin`，因此启动胶水只能在三个 `start.ts` 文件中复制。包将「ACP app 绝不向 stdout 输出日志」从行文警告变成产物的属性：叶子中没有可以写错的 logger 条目。

## 验证

- 示例目录只包含配置、README 和测试：`start.ts`、基础设施前导和共享 YAML include 已移除。
- `demo:echo`、`demo:repl` 和 `demo:acp` 调用 app 包的 bin。
- 每个新包有 README 和逐文件 100% 覆盖率；每个 app 包还有一个 keyless 的真实 Loader 路径 bin 冒烟测试，用于捕获 [postmortem 0001](../../../postmortem/0001-acp-default-export-drops-inject.md) 中描述的导出形状失败。
- ACP 回放 transcript 保持不变，因为插件集和加载顺序未改变。

## 后果

- **裸插件树教学法。** echo-agent 的内联 `cordis.yml` 曾一次展示所有插件；主干现在藏在 bundle 后面，因此查看完整树意味着打开 `dsh-agent-spine-demo`。app 包的 README 承担了这部分教学职责。
- **多了一层间接。** 「这个演示加载了什么？」变成了读一个 package，而非扫一份 YAML。

## 相关

- 取代 [Make the shared example base providerless](../../rejected/architecture/2026-06-20-providerless-example-base.md)：一旦主干移入 `dsh-agent-spine-demo` 且 `base*.yml` 文件被删除，将 `base.yml` 重命名为无提供方核心便不再有意义。
- 建立在[能力 seam](2026-06-13-capability-seams.md) 的接口/实现/消费方拆分之上——后端和展示层保持为叶子选择；主干是共享 bundle。
- 与 [Reorganize packages into a modular hierarchy](2026-06-20-package-hierarchy.md) 互补：新的 app/core 包按该层级结构归入既有分组（`core` 放可复用的主干 bundle，`ui` 放 app 特有的前门）。
