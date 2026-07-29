# client/ — web GUI 浏览器半侧

[English](README.md) | 中文

dsh web GUI 的浏览器侧：shell 内核、模块系统、协议消费层、无 React 依赖的对象服务、slot 系统，以及 `ui-*` 特性插件阵列。编写规则见 [AGENTS.md](AGENTS.md)；宿主半侧是 [`host/`](../host/README.md)。全部为**产品**包，命名为 `@deepseek-ai/dsh-client-<name>`。

| 包 | 角色 | ctx 键／slot |
|---|---|---|
| `web/` | shell 内核：`AppWebEntry` 基于宿主推送的条目图运行两阶段启动 | （启动整棵树） |
| `modules/` | 客户端模块系统：Node ESM 加载器的浏览器对等物，是 vendored cordis Loader 之下的惰性 CJS 表 | （模块面） |
| `web-react/` | shell 侧 React 胶水：`createSlotRenderer` + `SessionProvider` 渲染座位 | （渲染器安装） |
| `connection/` | 协议两端的消费者：浏览器侧 `ctx.connection`（共享 api 客户端 + 流循环），node 半侧挂载带浏览器信任栅栏的 `/api` 路由 | `ctx.connection` |
| `runtime/` | 客户端 cordis 启动与无 React 对象服务：slots、Session、Workspace、逐会话绑定 | `ctx.slots` `ctx.sessions` `ctx.workspaces` |
| `hmr/` | 仅开发用的 fetch 到达型客户端插件热重载（`--dev` 图） | （开发条目） |
| `locale/` | 浏览器语言偏好（`zh`／`en`）与 ns×locale 词典注册表 | `ctx.locale` |
| `ui-slots/` | slot 注册表纯核心：SlotMap 合并、单一 `register` API、四份额 props 族 | （类型 + 核心） |
| `ui-theme/` | 基于 `--dsw-*` token 样式表的主题偏好（`light`／`dark`／`system`） | `ctx.theme` |
| `ui-primitives/` | 纯 React 原子：图标、Button/Pill/Menu/Modal/Input、markdown 族 | （组件库） |
| `ui-layout/` | shell 三栏 AppFrame；声明 `sidebar`／`conversation`／`details`／`conversation.empty` | `ctx.layout` |
| `ui-sidebar/` | 侧栏 shell：Workspace/会话栏、搜索、折叠；声明 `sidebar.workspaces` | （slot 宿主） |
| `ui-workspace/` | 共享 Workspace 选择器：浏览区域 + hero 选择器共用同一创建流程 | （填充 `sidebar.workspaces`、`conversation.hero.workspace`） |
| `ui-conversation/` | 会话域：骨架、聊天视图、输入坞、逐工具行 slot | （slot 宿主） |
| `ui-trajectory/` | Trajectory／Waterfall 视图标签；最小纯消费者插件范例 | （填充 `conversation.view`） |
| `ui-command/` | 命令面：按会话键控的目录缓存、`/` 源、三类分发 | `ctx.command` |
| `ui-slash/` | 输入触发流水线：光标下的 `/` 与 `@` 检测、分组候选菜单、源名册 | `ctx.slash` |
| `ui-skill/` | 基于 `skill.list` RPC 的 `/` 触发技能引用源 | （注册进 `ctx.slash`） |
| `ui-subagent/` | 基于会话快照的 `@` 触发子代理引用源 | （注册进 `ctx.slash`） |
| `ui-model/` | 模型选择：`/model` popupSelect + 输入坞模型座位，均由 `ModelService` 驱动 | `ctx.models` |
| `ui-question/` | Web `ask_user_question`：宿主半侧挂载工具，浏览器半侧填充输入坞座位 | （填充 `conversation.composer`） |
| `ui-settings/` | 设置 shell：触发 chrome + 模态面板；声明 `settings.*` slot | （slot 宿主） |
| `ui-settings-general/` | 设置的无主文案：chrome 内容 + General 分区骨架 | （填充 `settings.*`） |
| `ui-models/` | 模型设置导航项（内容列留待后续阶段） | （填充 `settings.section`） |

特性 UI 只通过 slot 系统组合（`ctx.slots.register`）——[slot 系统标准](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md)是权威模型；[web 客户端架构 Note](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) 拥有加载链与对象层。
