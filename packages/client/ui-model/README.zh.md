# @deepseek-ai/dsh-client-ui-model

[English](README.md) | 中文

模型选择插件（浏览器侧）：**两个入口共用一份会话级目录**，由 `ModelService`（`ctx.models`）持有。`/model` popupSelect 贡献项（经 `ctx.command` 注册）与 composer 的具名 `conversation.input.model` 坑位都通过同一个 `ModelDirectory` 实例，经 `session.models` 加载会话的建议目录，并经 `session.selectModel` 提交。紧凑型 composer 触发器会打开两级 Model/Effort 菜单：模型仍按提供方分组，所选具体模型则提供由其适配器持有的推理强度名称、说明和默认值。Host 报告的提供方／模型／推理（reasoning）目标是两个入口共同回显的唯一事实；`/model` 应用所选模型的默认推理强度，composer 随后可以选择任一已公布的推理强度。目录加载与选择共享一个代次计数器，旧响应不会覆盖新结果；连接重置会丢弃所有常驻目录投影，并在显示前重新拉取 Host 恢复的目标。各提供方的元数据获取失败会内联列出，同时可用分组仍可选择；选择失败会保留先前的目标和目录。目录按会话惰性解析（`ctx.models.directoryFor(sessionId)`），随会话作用域一并释放。

`/client` 导出面为插件本体（`apply`/`inject`）、`ModelService`、`ModelDirectory` 及其状态形状、坑位注入面类型。

## 模型体验

间接影响，经两个入口共同提交的 `session.selectModel` RPC：Host 在下一次提示词组装边界快照所选提供方／模型／推理强度目标，因此下一次请求采用所选路由和推理强度，而运行中的步骤保留已组装目标。只有当现有请求头记录一次实际采用该选择的请求后，选择才会持久化；菜单交互不会添加提示词内容。

#### KV Cache 影响

切换路由可能减少提供方侧后续请求的缓存复用，或使其失效；提示词前缀本身不受影响。

## 已知限制与暂缓事项

- **无创建期选择**——两个入口都面向既有会话的 agent（智能体）；没有将草稿阶段的模型选择纳入会话创建的通道（host 的 `targetFor` 中的种子顺序说明了该层未来的落点）。
- **目录名仅供呈现**——选择与持久化使用提供方／模型／推理强度 id；目录查询或具体模型元数据查询失败的提供方以不可选失败行列出，重新加载前保持原样。
- **不能任意输入推理强度**——composer 仅提供具体模型由适配器公布的推理强度；适配器没有推理元数据时不显示 Effort 行。
