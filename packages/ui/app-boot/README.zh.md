# `@deepseek-ai/dsh-app-boot`

[English](README.md) | 中文

供 app bin（[`dsh`](../../../apps/cli/README.md)、[`dsh-cli-demo`](../../examples/cli-demo/README.md)、[`dsh-acp-demo`](../../examples/acp-demo/README.md)）共用的启动粘合层：每个 bin 都是在这些 helper 上构建的精简自执行组合，并以自身诊断前缀参数化。这样，Loader 故障处理知识只需维护一处并接受逐文件覆盖率门禁，不会在已发布产物之间逐渐分化。

| 导出 | 职责 |
|---|---|
| `resolveConfigPath(path, snapshotMode, cwd?)` | 生成绝对配置路径；当 `snapshotMode === 'replay'` 时，把 basename 为 `cordis.yml`/`.yaml` 的文件替换为同级 `cordis.snapshot.yml` |
| `loadEnv(binName, dir?, warn?)` | 加载已被 git 忽略的 `.env`（Node `process.loadEnvFile`）；文件不存在不影响启动，文件无法加载时输出一行带标签的警告（默认写入 stderr） |
| `installFailLoud(binName, proc?)` | 将 `boot()` 之后未处理的 Loader rejection 转换为一行带标签的 stderr 消息并执行 `exit(1)`；返回卸载函数（供测试使用） |
| `assertEntriesLoaded(ctx, binName)` | 树结算后，如果其中存在已启用但没有 fiber 的条目，则抛出异常，并以 Cordis 启动故障的形式报告每个未解析插件的名称 |
| `assertEntriesActive(ctx, binName)` | 树结算后，如果已启用的 fiber 未处于 ACTIVE 状态，则抛出异常；对于 PENDING 条目还会列出缺失的注入服务 |
| `loadPersonalPatches(binName, dir?)` | 解析 Harness home 中可选的 `config.yaml`（默认使用 [`resolveDshHome()`](../../util/paths/README.md)：先取 `$DSH_HOME`，否则取 `~/.dsh`）：其顶层是一个 YAML 数组，内容为 include 的 `PatchOptions`（按 id 定位的配置覆盖、`insert` 列表，允许 `!!js`）；文件不存在时返回 `undefined`，文件不可读、不可解析或内容不是数组时抛出异常 |
| `loadOverlayPatches(binName, file)` | 解析一份必需的 patch 列表文件，其形状与个人配置相同；读取或解析失败时抛出带标签的错误 |
| `boot(binName, absoluteConfigPath, patches?, prepare?)` | 创建根上下文并安装 Loader，在配置树条目挂载前执行可选的宿主准备操作（`prepare` 可以使用 Loader，也可以提供由启动器拥有的上下文插槽，例如 [`MAIN_SESSION_ID_KEY`](../tui/README.md)），再挂载并等待 include 树结算，断言所有条目均已加载且处于 ACTIVE 状态，最后返回根上下文 |
| `addHarnessSourceSection(ctx, sourceRoot)` | 添加全局 `harness:source` 提示词段落（顺序紧随 harness 身份、位于 persona 之前），告知 agent（智能体）自身源代码 checkout 的磁盘路径；如果已启动树没有此项服务，则不执行操作并返回 `undefined`。这里的服务是 `systemPrompt`；该段落注册到它的 fiber，因此开发环境 HMR（热模块替换）重新加载系统提示词后，它会消失直至下次启动 |
| `HARNESS_SOURCE_SECTION` | `'harness:source'` 段落名称，供 `addHarnessSourceSection` 注册使用 |

这些保护处理两类故障。`loader.await()` 会吞掉初始化 rejection（`Promise.allSettled`）；Node 仍会因随后产生的未处理 rejection 以非零状态退出，而 `installFailLoud` 会把冗长转储替换为一行带标签的消息，并确保执行 `exit(1)`。插件导入失败则只会由 Loader 记录日志（否则，即使配置存在拼写错误，进程也会以代码 0 退出），并留下没有 fiber 的条目；`assertEntriesLoaded` 会将其转换为 `boot()` rejection，并在其中列出每个导入失败插件的名称。

配置中的裸插件 specifier（`@deepseek-ai/dsh-*`、npm 包（package））通过 Cordis Loader 的内部模块 loader 解析。仓库 bin 会安装 Loader 的可选 peer `node-addon-require-builtin`；外部调用方必须提供该组件，或者把插件安装到普通 Node import 解析可以找到的位置。相对 specifier 无需原生 helper，并以配置目录为基准解析。`dsh` 源码启动器还会将 manifest（元数据清单）声明的 workspace 包映射到其 TypeScript 源码；其配置门禁要求每个 TUI／Web 裸插件都出现在解析所用 manifest 的 `dependencies` 中。bin 的子进程冒烟测试覆盖内部 loader 路径，而本包的单元测试套件会在进程内使用相对 specifier 配置驱动 `boot()`。

此包不包含 loader 钩子，也不提供开发模式接口。[`dsh` 应用](../../../apps/cli/README.md)持有自己的 Node 源码启动钩子，并在启动序列中使用这些 helper；构建后的消费方仍使用普通 Node 包解析。

## 个人配置

开发者的机器本地偏好位于所有仓库之外的 Harness home 中（默认 `~/.dsh`，可由 `$DSH_HOME` 覆盖；统一由根级 [`resolveDshHome`](../../util/paths/README.md) 解析），并由官方 `dsh` 界面（[`apps/cli`](../../../apps/cli/README.md)）使用；demo bin 会原样启动仓库中提交的树。这里有两个可选文件：

- **`.env`**：在调用目录的 `.env` 之后加载；`process.loadEnvFile` 从不覆盖已有值，因此优先级为环境中的值 > 项目 `.env` > 个人 `.env`。
- **`config.yaml`**：在发布的默认配置上应用 Loader overlay patch，语义与交付的 surface overlay 相同：按 id 定位的 patch 会替换对应条目的整个 `config`（未改字段也要重述），`insert` 会添加条目，`!!js` 表达式则在挂载时插值，因此个人 `apiKey` 可以引用个人 `.env`。如果 patch 指定的条目 id 不在已启动树中，则静默不执行任何操作。空文件或仅含注释的文件会抛出异常（其解析结果为空，而不是列表）；如需禁用 overlay，请使用 `[]` 或删除该文件。

子进程测试 launcher 会把 `DSH_HOME` 指向逐测试隔离的目录，确保开发者的个人 overlay 不会泄漏到 fixture（测试前置数据）中。

## 模型体验

模型通过此包加载的插件树间接受到影响；该树决定最终应用中的提示词、schema、消息和模型适配器。唯一贡献模型可见文本的导出 `addHarnessSourceSection`，也只有在消费方启动后调用它时才会产生影响。

#### KV Cache 影响

`boot()` 不会直接使缓存失效；消费方调用 `addHarnessSourceSection` 时，会在系统提示词靠前位置、逐请求内容之前添加一行短文本，因此不会使跨轮次缓存失效。请求前缀的其他任何变化均由相应的具名消费方持有。

## 已知限制与延期工作

- **裸包 specifier 依赖 Loader 内部机制**：生产 bin 需要 Loader 的可选原生 helper；没有该 helper 的进程内调用方必须使用可解析的相对／file specifier，或提供自己的模块解析钩子。
- **快照回放替换仅识别特定 basename**：只有以 `cordis.yml` 或 `cordis.yaml` 结尾的配置会映射到同级 `cordis.snapshot.yml`；自定义配置名称需要调用方自行选择。
- **环境加载局限于 cwd 且为可选操作**：helper 只加载一个 `.env` 文件，并在失败时发出警告；它不会搜索父目录、合并 profile 或验证必需变量。
- **个人配置采用 patch 形式**：按 id 定位的 patch 会替换条目的整个 `config`，而不是深度合并，因此个人覆盖必须重述需要保留的基础字段。
