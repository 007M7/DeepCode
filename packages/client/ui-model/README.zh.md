# @deepseek-ai/dsh-client-ui-model

[English](README.md) | 中文

模型选择插件（浏览器半侧）：**两个入口共用一份 per-session 目录**，由 `ModelService`（`ctx.models`）持有。对于普通会话，`/model` popupSelect contribution（经 `ctx.command` 注册）与 composer 的具名 `conversation.input.model` 坑位都通过同一个 `ModelDirectory` 实例，经 `session.models` 加载会话的建议目录，并经 `session.selectModel` 提交。紧凑型 composer 触发器会打开两级 Model/Effort 菜单：模型仍按提供方分组，所选确切模型则提供由其适配器持有的推理强度名称、说明和默认值。Host 报告的提供方／模型／推理（reasoning）目标是两个入口共同回显的唯一事实；`/model` 应用所选模型的默认推理强度，composer 随后可以选择任一已公布的推理强度。目录加载与选择共享一个代次计数器，旧响应不会覆盖新结果；连接重置会丢弃所有常驻目录投影，并在显示前重新拉取 Host 恢复的目标。逐提供方元数据失败会内联列出，同时可用分组仍可选择；选择失败会保留先前的目标和目录。目录按会话惰性解析（`ctx.models.directoryFor(sessionId)`），随会话 scope 一并释放。已寻址 subagent 会话不公开任一入口，其目录会拒绝加载、选择与重新连接刷新，因为绑定到 agent（智能体）的普通模型 RPC 会在直接 parent 继续执行 seam 之外激活持久化 child 历史。

`/client` 导出面为插件本体（`apply`/`inject`）、`ModelService`、`ModelDirectory` 及其状态形状、坑位注入面类型。

## 模型体验

间接影响，经仅普通会话可用的 `session.selectModel` RPC，两个入口都会提交提供方／模型／推理强度目标，Host 会在下一次提示词组装边界对该目标进行快照，因此后续请求采用所选路由和推理强度，而运行中的步骤保留已组装目标；只有当现有请求头记录一次实际采用该选择的请求后，选择才会持久化，且菜单交互不会添加提示词内容。

#### KV Cache 影响

切换路由可能减少提供方侧后续请求的缓存复用，或使其失效；提示词前缀本身不受影响。

## 已知限制与暂缓事项

- **无创建期或已寻址 subagent 选择**——两个入口都要求既有普通会话的 agent；没有可折入会话创建的 Draft 期模型选择，subagent 继续执行也有意不公开独立更改模型目标的契约。
- **目录名仅供呈现**——选择与持久化使用提供方／模型／推理强度 id；目录查询或确切模型元数据查询失败的提供方以不可选失败行列出，重新加载前保持原样。
- **不能任意输入推理强度**——composer 仅提供确切模型由适配器公布的推理强度；适配器没有推理元数据时不显示 Effort 行。
