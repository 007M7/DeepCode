# @deepseek-ai/dsh-client-ui-model

[English](README.md) | 中文

模型选择插件（浏览器半侧）：**两个入口共用一份 per-session 目录**，由 `ModelService`（`ctx.models`）持有。`/model` popupSelect contribution（经 `ctx.command` 注册）与 composer 的具名 `conversation.input.model` 坑位（紧凑触发器 + 向上展开的按提供方分组菜单，视觉取 figma 313:14108 的 ToggleButton）都通过同一个 `ModelDirectory` 实例经 `session.models` 加载会话的建议目录、经 `session.selectModel` 提交——host 报告的 current target 是两个界面共同回显的唯一事实，在任一入口切换，另一入口下次打开显示的就是新值。目录加载与选择共享一个代次计数器（旧响应永不覆盖新结果）；连接重置会先丢弃所有常驻目录投影，再重新拉取 Host 恢复的 target 后显示，避免继续呈现未消费的进程内选择。提供方级目录失败内联列出，可用分组保持可选；整体失败与选择失败落各入口自己的重试面（popup 壳的 error/retry、坑位菜单的内联错误），状态不分叉。目录按会话惰性解析（`ctx.models.directoryFor(sessionId)`），随会话 scope 一并释放。

`/client` 导出面为插件本体（`apply`/`inject`）、`ModelService`、`ModelDirectory` 及其状态形状、坑位注入面类型。

## Model Experience

间接影响，经两个入口共同提交的 `session.selectModel` RPC：host 在下一次提示词组装边界快照所选提供方/模型对，因此后续请求按所选目标路由（并盖入提示词变量），运行中的步骤保持其已组装目标——目录、两个菜单及全部选择交互都留在 client 侧，永不进入 session log。

#### KV Cache effect

切换路由可能降低或作废提供方侧后续请求的缓存复用；提示词前缀本身不受影响。

## Known Limitations and Deferred Work

- **无创建期选择**——两个入口都寻址既有会话的 agent；没有 Draft 期模型选择折入会话创建的通道（host `targetFor` 处的种子序注释记录了该层未来的落点）。
- **目录名仅供呈现**——选择与持久化使用提供方/模型 id；目录查询失败的提供方以不可选失败行列出，重新加载前保持原样。
- **坑位不显示 effort 档位**——figma 设计稿中的 `High` 文本尚无对应 wire 概念；触发器只渲染模型名。
