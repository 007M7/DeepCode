# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

外壳插件：三栏 AppFrame（拖动手柄与让步链）加 `ctx.layout` 面板几何服务；它注册到运行时拥有的 `root` slot，并声明 `sidebar`、`conversation`、`details` 和 `conversation.empty`。侧边栏宽度固定（只会收缩详情栏，然后将其自动关闭）；关闭的侧边栏仍保留 56px 控制轨道，详情栏则关闭到零宽度。该包还提供主题呈现器：它消费解析后的 `ctx.theme` 快照，并将其投影到 `document.body`（依据当前配色方案设置 `data-ds-dark-theme`，并将主题的别名 token 设为内联变量）。

AppFrame 读取运行时 Session 投影：`baselinesReady` 选择加载状态，页面局部的 `SessionListState.intent` 选择空白编辑器，已连接 Session 则通过 `SessionProvider` 渲染。会话及空状态的 owner share 为空；每个注册方通过标准 hook 获取业务数据，并从自身的 inject 表层获取操作。侧边栏 owner share 只包含 `collapsed` 和 `width`；导航操作属于侧边栏自身注入的服务表层。

`/client` 导出表层包含插件主体（`apply`／`inject`）、`LayoutService` 和四个 owner-share 接口。AppFrame、面板 store 与让步求解器仍属于包内部；测试通过 `/src` 导入内部实现。

## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **详情栏打开／宽度状态是全局状态**：它不会随会话变化（P-I 已裁定）；为逐会话键控升级预留了 slot。
- **让步链自动关闭通过推导零宽度实现，不会改动持久化的打开标志**：窗口变宽时面板会自行恢复；消费方禁止把 `details.open` 当作实际渲染状态。
- **挤压重排期间尚未实现滚动锚定**：与虚拟化列表项目一并暂缓。
