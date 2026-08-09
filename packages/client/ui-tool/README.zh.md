# @deepseek-ai/dsh-client-ui-tool

[English](README.md) | 中文

客户端工具展示插件。`ui-conversation` 通过 `conversation.chat.tool` 交付一个已经排好位置的根调用；本包渲染该根调用及其 Code Dispatch 子调用，并通过键控 slot `tool.call.toolview` 分发每个原子调用。未注册的工具名称使用通用卡片。

业务 UI 包只注册协议中的工具名称和原子视图，不配对会话事件、不重建 transcript，也不负责根调用与子调用的拓扑。运行时继续负责调用与结果的配对、生命周期和递归 `subCalls` 投影；对话视图继续负责在 ChatFlow 中的位置。

## 渲染约定

`ToolCallTree` 接收一个已经包含递归 `subCalls` 的根 `ToolCallBlock`、选中状态、会话 `cwd`，以及用于打开文件和检查调用的 Host 回调。它递归遍历标准调用块，让根调用与任意深度的子调用经过同一条原子分发路径，不再订阅独立的父子映射。

每个根调用和子调用的包装层都保留 `conversation.chat.tool` 的调用锚点 DOM 约定，供分页和 selection 使用。

本包还通过 `ToolDetails` 填充 `conversation.details.tool`。行渲染器与详情渲染器为 `terminal`、`read`、`diff`、`search` 和 `web` 渲染意图共用同一组纯卡片模型。未知的意图标签和格式错误的协议卡片数据都会回退为展平的工具结果文本。

通用行把已知工具名称归类为搜索、读取、shell、写入、编辑、代码或通用变体。运行中、成功、失败和中断状态只来自冻结的调用／结果切片。只有用户调用 Host 打开文件回调时，文件路径才相对会话 `cwd` 解析；展示代码不读取会话服务。

## 原子工具视图

业务属主把自己的协议工具名称注册到 `tool.call.toolview`：

```ts ignore-check
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: '<wire tool name>',
  }, BusinessToolRow))
```

属主载荷为 `ToolCallOwnerProps`：`callId`、`toolName`、冻结的 `block`、可选 `cwd`，以及普通的 `openFile`／`inspect` 回调。注册项会收到标准的会话 slot 运行时共享数据，但不会收到 React 节点、运行时服务或根调用／子调用拓扑信息。

本包当前负责通用回退，以及 bash/pwsh、读取、写入／编辑、grep/glob、web、todo、question 和 Code Dispatch 的内置展示。`ui-skill` 展示了业务包如何拥有 `skill` 注册。

各类卡片的上限与回退规则仍由对应的 [terminal](../../../.agents/notes/implemented/feature/2026-07-28-web-terminal-card.md)、[diff](../../../.agents/notes/implemented/feature/2026-07-30-web-diff-card.md)、[read](../../../.agents/notes/implemented/feature/2026-07-30-web-read-card-frontend.md)、[search](../../../.agents/notes/implemented/feature/2026-07-30-web-search-card.md) 和 [web](../../../.agents/notes/implemented/feature/2026-07-30-web-result-card-frontend.md) Note 负责。

## 模型体验

无，因为本包只渲染已经记录的工具调用和结果，不改变模型请求、工具执行或会话事件。

#### KV Cache 影响

无。本包只负责客户端展示。

## 已知限制与后续工作

- Host 不把 `run_code` 暴露为 Code Mode 程序 binding，因此生产事件目前只能产生一层分发；递归的运行时／UI 约定已为未来的嵌套生产方做好准备。
- 现有第一方 Tool 视图初期仍集中在本包，之后可以通过键控 slot 独立迁回各自业务包。
- Tool 文案暂时复用 `ui-conversation` locale namespace。
