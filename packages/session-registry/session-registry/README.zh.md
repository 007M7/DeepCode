# @deepseek-ai/dsh-session-registry

[English](README.md) | 中文

存活会话注册表 seam（`ctx.sessionRegistry`）：定义跨进程「当前正在运行哪些会话」注册表的契约与记录词汇，使 `dsh list-sessions` 这类独立的短生命周期进程能够回答「我正在运行什么」。本包不拥有任何介质——由后端实现该抽象服务（今天是 [`session-registry-file`](../session-registry-file/README.md) 中加锁保护的 JSON 文件，将来可以是数据库）。

## 形状

- `register(registration)`：发布 `{ sessionId, cwd, title? }`，并盖上本进程的 pid、每个 incarnation 独有的 `bootId` 和 `startedAt`。同一会话 id 的既有记录会被替换。返回 `ctx.effect` disposer；await 它即等待移除达到持久性。
- `retitle(sessionId, title)`：替换**本**进程注册的某个会话的已记录标题。标题在注册之后才到达，并且可以修订，因此它是唯一的可变字段。归属于其他 pid 或其他 incarnation 的记录不受影响；未知 id 为空操作，因为标题可能在记录消失之后才解析出来。
- `list()`：返回全部存活记录，按注册时间从旧到新排列。存活性属于契约本身，而非后端的自由裁量：每条返回记录的进程在观察时刻都存在，因此未运行 disposer 就被杀掉的进程不会留下永久的幽灵记录。

后端必须将变更与并发注册方（其他进程，以及本进程内相互重叠的调用）串行化，使记录不会因撕裂的读改写而丢失。

## 记录词汇

`SessionRegistryRecord` 携带 `sessionId`（在存活记录中唯一）、`pid`、`cwd`、`startedAt`、用于区分被复用 pid 与原 incarnation 的 `bootId`，以及可选的 `title`。标题随记录传递而非从会话日志读取，因为日志的位置、格式与压缩是各部署后端的选择，独立读取方无法可移植地解析。

## 模型体验

无。本包不注册工具、不注入提示词、不追加会话事件；它只定义宿主侧的列表契约。

#### KV 缓存影响

与在途请求无关：注册表从不触碰请求前缀，因此这里不会使提供方缓存复用失效。

## 已知限制与后续工作

- **记录以进程为粒度，而非以 agent 为粒度**——只有用户直接启动的顶层界面会发布。进程内 subagent 没有自己的进程，进程外 subagent 后端启动的是 `dsh-jsonrpc-agent` 而非本 CLI，两者都不会出现在列表中。
- **存活性只表示 pid 存在，不表示健康**——挂起或停止的进程仍会被列为运行中；契约刻意不判断会话是否在推进。
