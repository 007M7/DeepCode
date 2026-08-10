# Agent Note: Child agents join their parent's preset composition

Status: implemented

[English](2026-08-10-child-agents-join-their-parent-preset.md) | 中文

## Problem

工具与提示段的可见性沿 `dsh-scope` 的父链继承，而 agent 的 scope key 铸造出来时没有父。[逐会话 agent preset](../architecture/2026-08-03-per-session-agent-presets.md) 把所有面向模型的行搬到了 agent 平面，并让 `AgentPresets.mount()` 成为绑定那条父链的唯一途径——调用点在 api-proxy 的会话创建、恢复与 fork 路径上。两个进程内 subagent 驱动通过 `applyChildComposition()` 组装子 agent，而它只安装了逐子 agent 的 persona 与工具限制，于是子 agent 的 scope 链长度为一，其注册表视图只能解析到全局层。

在任何配置了 preset roster 的部署里，那一层现在是空的：web-app 补丁层禁用了全部宿主平面工具行。因此一次性子 agent 抵达模型时工具为零，可继续子 agent 只剩宿主平面的 `report`，两者都不带父方的 persona、工作区上下文、plan-mode 段与技能目录。fork 路径此前已因同一理由做过相同处理；委派没有。

子 agent 的持久化 header 让问题更进一步。`childSessionMeta()` 不记录任何 preset，于是冷读一个子会话解析到的是部署默认值——一套该子 agent 从未运行过的工具集，而这正是"模型可见 ⟺ 已记录"规则要杜绝的情形。

## Decision

`AgentPresets.composeFrom(agentCtx, parentCtx)` 让一个 agent 加入另一个 agent 已在运行的常驻组装，并返回所加入的 preset id。它通过 `standingMountFor()` 定位父方的挂载——agent 的 key 认父到其 preset 的常驻 key，正是 `serviceForAgent()` 读取的同一关系——再把子 agent 的 key 绑到同一个常驻 key 上，绑定句柄仍归 roster 独有的重链权威持有。未加入任何 preset 的父方不产生加入、也不报错，那就是无 roster 的部署：它面向模型的行位于宿主组装中，子 agent 已经能通过全局层解析到它们。

这是认父而非挂载，两处差别都要紧。子 agent 拿到的是父方那个确切的代际，因此父方启动后被编辑过的组装文件不可能把与父方历史所产出时不同的另一个代际交给它，此后被删除的 preset 也不可能让一个父方仍在运行的子 agent 失败。它还是同步的，这正是子 agent 创建窗口能够使用它的前提——两个进程内驱动都在同步的 `setup` 中完成组装。

`applyChildComposition(childCtx, parent, composition)` 接收父方，并在应用子 agent 自身注册之前完成加入。这个参数正是要点所在：它让"组装子 agent 却不做该加入"在各调用点无法表达，而不是把第二个步骤留给每个新驱动去记住。`childSessionMeta()` 通过 `AgentPresets.composedPreset()` 记录所加入的 id，该值从父方**活着的** scope 链读取而不是从其 header 读取，因为在空白期切换过 preset 的父方运行在更新的那份组装上，而它的 header 仍写着旧的那个。

`dsh-subagent` 以类型级导入加可选 peer 依赖的方式，通过 `ctx.get('agentPresets')` 触达 roster——这正是它对 `sandboxPolicy` 与 `approval` 已在使用的、有明确文档的机会性消费模式。

## Alternatives considered

**在子 agent 的 setup 里按 id 重新挂载父方的 preset。** 语义与机制两方面都不成立而被否决。它会重读 roster 并重新 stat 组装文件，因此父方启动后的一次编辑就会把子 agent 分叉到另一个代际，而此后被删除的 preset 会让子 agent 失败、父方却照常运行。`mount()` 还是异步的，同步的创建窗口无法在不重构两个驱动的前提下接受它。

**把子 agent 的 key 绑到**父方的** key 而不是常驻挂载上。** 否决，因为这改变了子 agent 继承的内容：父方自己的 scope 层携带其逐 agent 限制，那些限制会就此与每个后代求交，而活得比父方久的子 agent 会挂在一个已 dispose 的 agent key 上。加入常驻挂载给到子 agent 的是父方的组装，仅此而已。

**扩展可继续 activation setup 注册表以覆盖一次性子 agent。** 否决，因为该注册表的贡献类型是同步的 `(childCtx) => () => void` 并带有逐次安装的撤销，建模的是会来会走的部署能力，而 preset 加入是一次性认父、自身没有撤销可言。扩展它反而会让任何绕过该注册表的驱动重新具备遗漏的可能。

**让 `dsh-subagent` 导入 `resolveSessionPreset` 并按解析出的 id 挂载。** 否决，因为这会给一个必须在没有 roster 时也能工作的包引入硬模块边，而且最终仍落回上述的重新挂载语义。

**只修活着的加入，不动持久化 header。** 否决，因为那样活着的子 agent 与冷读同一个子 agent 会对"哪份组装产出了这段历史"给出不同答案——同一类缺陷，只是被搬了个地方而不是被修掉。

## Testing

`packages/preset/agent-presets/tests/mount.spec.ts` 用真实 fixture 组装覆盖该加入：子 agent 看到父方的工具与提示段、不会挂载出第二个代际、加入在父方 dispose 后依然成立（活得比父方久的后台子 agent）、上报的 id 一致、没有 preset 的父方不产生加入、以及无 scope 的上下文被拒绝。

`packages/subagent/subagent-inprocess/tests/preset-inheritance.spec.ts` 在一个不含任何面向模型行的宿主组装上，通过 `startInProcessRun()` 断言模型可见的结果：子 agent 自身请求中的 schema、父方的提示段、记录下来的 header preset，以及在空白期切换过 preset 的父方——切换到**另一个** preset，这样断言才能区分"读父方活 scope 链"与"读父方创建 header"。

组装记录这一层用的是真实 shipped Web 组装的 e2e，而不是无密钥快照。本仓库所有可运行 example 都不组装 preset roster，因此该缺陷在快照 harness 里根本不可观察：要做快照场景，得先有一个既挂载 roster 又发起委派的 example。Web e2e 启动的是真实的 `base` + `web-app` 补丁层与两个 shipped preset，这正是测试政策要求的组装证据；Web 浏览器 lane 的 subagent golden 承载了可见后果——记录了 preset 的子 agent 现在会显示与其父方相同的 preset 徽标。

## Consequences

委派现在的成本是每个子 agent 一次 scope 认父，再无其他——没有额外的插件实例、没有 roster 读取、没有新的失败模式。子 agent 的能力恰好等于父方的能力——逐子 agent 的 `toolFilter` 并不能收窄它，原因见下方另行跟踪的那条；逐 subagent 的 preset（"agent 类型"）仍未构建，那会是一个新的请求字段，而不是对这次加入的改动。

`applyChildComposition()` 的形态变了，因此将来任何仓库外的进程内驱动都必须提供父方。这是刻意付出的代价：此前的签名允许调用方组装出一个毫无能力的子 agent 而不报任何错。

冷恢复的可继续子 agent 加入的是父方**当前**的组装，而不是它自己 header 所记录的那份。窗口很窄——父方必须先建子、保持空白、切换 preset，之后才唤醒它；驻留中的子 agent 不会重新加入，一次性子 agent 也不会恢复——而替代方案更糟：按子 agent 自己记录的 id 解析会重读 roster，把这次认父刻意规避掉的"preset 已删除"失败模式又请回来。子 agent 的 header 仍记录它启动时的那份，因此这处分歧是可观察的而非静默的。

`toolFilter` 约束不住已加入组装的子 agent，因为 `ToolRegistry` 只按全局层的名字编译限制，随后把 scope 链上的工具无过滤地叠加进来。这不是本次改动带来的——在组装了 roster 的部署里，`tools.restrict()` 本就把每个名字都判为未知全局工具，因此带过滤器的子 agent 在本次改动前后同样起不来——但它是搬到 agent 平面所引入的回归，而非长期存在的限制：同样这批工具注册在全局层时，过滤器能正常校验并生效。现在子 agent 有了父方的全套工具需要被限制，它变得更要紧。该问题另行跟踪；本次改动既未引入也未修复它。
