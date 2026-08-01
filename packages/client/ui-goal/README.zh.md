# @deepseek-ai/dsh-client-ui-goal

[English](README.md) | 中文

Goal 表面插件（浏览器半件）：`GoalBar` 条带是 `conversation.input.dock` composer 上下文堆栈中的第一张独立卡片（order 0，位于 Todo 和 Queue 之前）。活值经 `useProjection('goal')` 到达——host 计算的全量值由历史尾页播种、由 `session/projection` 帧更新——因此本插件不持有领域 store、不设刷新链、不挂事件监听。slot 注入面只携带四个变更动词（edit / pause / resume / clear，走 `goal.*` 协议域——active 的 goal 提供暂停动作，paused 的提供恢复）；每个动词在调用时从会话当前投影值读取 CAS ref，并把结算后的 RPC 错误内联呈现。由于 React 的 pending 渲染无法拦住同一帧内的点击，横条会同步为变更建立 single-flight 防护；清除成功后，会立即抑制该 goal id 对应的目标显示，直到权威的 null 投影追上。goal 的创建仍归 `/goal` host 命令；加载中、无 goal、已完成和已成功清除的 goal 一律不渲染。

`/client` 出口面为插件本体（`apply`/`inject`）、`GoalBar`/`GoalDock` 组件与注入动词面类型。

## Model Experience

间接影响：条带动词提交的 `goal.edit`/`goal.pause`/`goal.resume`/`goal.clear` RPC 每次被接受后，会向会话追加一条模型可见的 `goal/change` 上下文消息（与投影折叠的正是同一条持久事件），模型在下一轮即可看到更新后的 goal 状态。条带自身不添加任何提示词内容。

#### KV Cache effect

除 goal 变更自身的上下文事件（如同任何消息一样追加在日志尾部）外无额外影响。

## Known Limitations and Deferred Work

- **只反映持久 phase** —— 投影值有意省略进程本地的 activation（armed/disarmed），条带无法区分 active-but-disarmed 与 armed 状态；resume 经 RPC 侧重新武装。host 活值通道待出现真实消费方后再议。
