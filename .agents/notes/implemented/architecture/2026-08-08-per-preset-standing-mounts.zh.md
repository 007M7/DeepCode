# Agent Note: Per-preset standing mounts over a scope parent chain

Status: implemented

[English](2026-08-08-per-preset-standing-mounts.md) | 中文

## Problem

按会话挂载 preset 让面向模型的注册面变成按 agent 的，而三个独立的宿主读取方仍然假设它是静态的：冷读 `session.history` 找不到 presenter（每张卡都静默退化成通用渲染器——与「工具本无 presenter」无法区分）、投影块丢掉 preset 注册的键（客户端把缺失键当作能力不存在并**清掉**该行）、TypeRT 网关在宿主根上解析 `goals`（`service-unavailable`）。逐个读取方打补丁只是拿一种静默降级换另一种：为拿到 presenter 而 resume，会把投影折叠从 detached 翻到 live，token 计数随之被抹掉。

## Decision

一个 preset 是**每进程**一份组装，而不是每会话一份。roster 在一个合成常驻 scope 下挂载它一次；每个 agent 通过 `setScopeParent(agentKey, standingKey)` 加入。两条 `dsh-scope` 机制承载了一切：注册视图沿父链解析（`agent → preset → global`，近者遮蔽远者），带作用域的分发对标签为载体键祖先的监听器放行——只向上，兄弟 preset 的监听器保持失聪。

## Consequences

常驻挂载修的是这一类问题而非其中的个例：读取方需要的注册在进程生命周期内始终存在，按 preset id 索引，不需要任何 agent。让它便宜的原因：

- 有状态的 preset 插件（`plan-mode`、`token-meter`、`compact-basic`、`tasks-local`）本就按 `Session`/`Agent` 分键存状态——它们早于 preset 存在。共享一份实例是回归其设计，不是改写。
- preset 的 yml 不变：每 preset 挂一次 = 每 preset 一个 Entry，其 entry 本地 realm（`isolate: <name>: true`）让两个 preset 的同名服务互不相干，正如它从前隔开两个会话。
- 共享 realm label **不是**选项：`provide()` 对同一 realm 符号下的第二次注册直接抛错，label 池化的是 REALM 而非实例——按会话挂载的世界里共享 label 会让第二次挂载崩溃。

## Load-bearing details

- **常驻挂载挂在服务未追踪的 `selfCtx` 上。** 经 traceable 代理调用的方法看到的 `this.ctx` 被重绑到调用方并携带 shadow；从它派生的子树里每个 fiber 的 reflect 解析都从 shadow 的 fiber 起步，entry 会在自己 `inject` 声明的服务上失败（`cannot get property "tools" without inject`，而它的 store 里明明有）。`tasks-local` 的 selfCtx 先例，如今有了第二个消费者。
- **挂载一旦成功即进程级永久。** 运行中会话加入的组装必须在其文件被修改或删除后继续存活；删除与编辑只影响未来的代际（创作层替换 map 指针，绝不 dispose 已被加入的代际），被替代的代际只由整树卸载回收——刻意为之，上限取决于编辑频率，已记入包的 Known Limitations。
- **`peek()` 保持不看链。** 限制与守卫定位的是单个作用域**自己**的贡献；只有注册**视图**沿链继承。链上的限制求交（链上任一作用域都可为嵌套其内的一切遮蔽某个全局面名字）。
- **对活 agent 重新认父（`setScopeParent`）是空白会话 recompose 的路径**——仅当旧父之下的产出一概不被保留时才合法，由调用方保证；该关系看不见会话日志。

## Alternatives considered

冷读时 resume（抹掉 detached 投影）、宿主面 presenter 表加投影块完整性标志（修两个读取方、留下这一类）、每会话模板挂载（为了服务纯函数而复制每一份实例）。留档：面向网关的 `goals` 域无论如何留在宿主平面——Remote 方法的接收者来自生成的 descriptor、在宿主上解析，这正是 `bash-env` 宿主平面判据从消费侧读出的样子。
