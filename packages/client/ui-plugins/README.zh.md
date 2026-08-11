# @deepseek-ai/dsh-client-ui-plugins

[English](README.md) | 中文

Web 设置中的只读“插件”分区。浏览器插件在“模型”之后注册一个 id 为 `plugin-inventory` 的本地化 `settings.section` 贡献，并由 Settings shell 提供常规的回退图标。插件激活期间不会读取 Remote；挂载该分区时，组件才通过 [`api-remotes`](../../api/remotes/README.md) 懒调用 `ctx.remote.pluginInventory.list()`。

页面以可搜索的双列紧凑卡片展示清单。每张卡片使用 Loader 本地 id 作为标题，以彩色圆点表示根 Fiber 状态，以小标签表示有效启停状态。加载、空结果、无匹配结果与通用失败状态只属于已挂载组件；读取失败后可以重试，且不会暴露传输细节。注册使用 `ctx.slots.inject()`，因此能跟随 Settings 的延迟声明、重新声明、本地化变化与 teardown，而不拥有另一份全局 store。

## 模型体验

无，因为本包只在浏览器设置中展示 Host 拥有的部署快照，不注册任何模型接口。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **每次挂载或重试只读取一份快照** —— 页面不订阅 Loader 变化，也不会在重连后自动重新读取；重新打开分区会取得新快照。
- **只读 Loader 视图** —— 本地搜索不会额外引入来源、按来源分组、当前浏览器激活诊断或插件修改控件。
