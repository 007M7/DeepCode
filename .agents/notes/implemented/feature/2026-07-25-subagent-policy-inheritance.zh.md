# Agent Note: 进程内 subagent 策略继承——子 agent 在父级的沙箱与审批覆盖项下启动

Status: implemented

[English](2026-07-25-subagent-policy-inheritance.md) | 中文

## 问题

会话策略覆盖项是按会话的日志折叠：生效沙箱模式等于 `fold(session's sandbox/mode events) ?? deployment default`（[沙箱 Agent Note](2026-07-06-sandbox.md)），审批策略以同样的方式折叠 `approval/policy`。进程内 subagent 的子 agent（智能体）拿到的是一个全新会话，因此没有任何覆盖项能跨过委派边界：父 agent 已切换到 `read-only` 时，其 spawn 子 agent 却运行在（可能更宽的）部署默认值之下，委派成了绕开用户收紧的旁路通道；fork 子 agent 只能继承恰好落在其已完成轮次种子内的切换，而恰恰漏掉最常见的时机（用户在 agent 空闲时切换，切换落在最后一个 `turn/end` 之后、种子之外）。审批策略为 `'never'`（无头／CI 场景）的父 agent，其创建出的子 agent 同样回退到了会向用户弹出提示的默认策略。被拒的子 agent 看到的升级提示文案（「审批提示会询问用户」）还承诺了一个永远不会有应答器送达的提示。

## 决策

共享的进程内驱动器（`packages/subagent/subagent-inprocess` 中的 `startInProcessRun`）在委派时同步捕获父级的策略覆盖项，并将其作为创建元数据带入子 agent 不可变的会话头——沿用 `delegationDepth` 先例：

- **委派时同步捕获，持久化在创建时的会话头中。**驱动器在自己的第一个 await 之前就为两个策略旋钮读取 `overrideOf(parent.session)`——委派时刻即快照点，因此与异步的子 agent 创建过程赛跑的父级切换属于父级的未来，而非子 agent——并把捕获值盖章写入子 agent 的创建 `meta`（`SessionHeader` 上的 `sandboxMode`/`approvalPolicy`）。该基线从会话存在的那一刻起就具备持久性：任何监听器顺序都不可能饿死它（即便一个作出拒绝的 UserPromptSubmit 钩子否决了第一个提示词，也不会产生任何影响），任何崩溃窗口也不可能丢失它——决定性的场景是空闲时的 SessionStart 式注入在任何提示词轮次开启之前就持久化了一个完整轮次，在那之后第一个轮次内的事件尚不存在，而会话已经看起来可以恢复。
- **只复制覆盖链，且由策略 owner 在读取时校验。**`overrideOf(session)`——即纯函数导出 `sandboxOverrideOf`/`approvalOverrideOf`，以服务方法的形式暴露——解析为 `fold(events past the seed boundary) ?? header baseline`，从不包含部署／配置默认值：未切换过的父级不写入任何基线，因此其子 agent 跨重启继续跟随实时默认值。这两个会话头字段在会话边界上只是中性字符串；每个策略 owner 在每次读取时都无条件按自己的封闭词汇校验（即便自己做出的切换会遮蔽基线，损坏的会话头也会大声失败），遇到词汇之外的值即抛出异常。每一个旋钮消费方都经由同一条链解析——强制执行侧（`resolve()`、pty-local）与权限 preset（`current`/`set`）皆然——因此当选中更窄的 preset 时，继承了更宽基线的子 agent 得到的是真实的旋钮切换，而非静默的空操作。驱动器以可选方式消费这两个服务（`ctx.get`，仅类型导入，`peerDependenciesMeta.optional`）：未挂载它们的组合照旧进行无策略委派，行为不变。
- **fork 陈旧种子的优先级由种子边界自然得出。**fork 种子可能携带父级旧的切换事件；`overrideOf` 只折叠 `header.seedLength` 之后的事件，因此种子携带的历史已被委派时的基线所涵盖，而子 agent 自己做出的切换仍然优先于基线。日志中不含任何合成事件——会话头是基线的唯一存放处，规范写入路径 `setSandboxMode`/`setApprovalPolicy` 仍然只留给真实的运行时切换。
- **嵌套按构造即可组合。**孙代 agent 捕获时解析的是其父级（即上一层的子 agent）的覆盖链（自身折叠 ?? 基线），这条链在每层委派处收拢一级，任意深度均成立。一次性的 `allowed-once` 升级授权从不进入任何日志或会话头，因此永远不可能沿链向下泄漏。

### 被拦住的子 agent 会经历什么

受限子 agent 撞上围栏时得到的是普通拒绝标记；升级重试会经过真实的审批 waterfall（瀑布式事件）解析，而其中没有任何应答器认领进程内子 agent，最终落到那个独立的 fail-closed 原因（`no approval channel is available`）。恢复路径是把拒绝向上汇报：父 agent 由一个能够应答的控制方持有，可以在自己的会话里发起升级，或在用户放宽模式后重新委派。继承来的 `'never'` 连这次注定无效的重试都会省去：子 agent 的第一份系统提示词已经写明不要请求升级。

## 考虑过的替代方案

- **在子 agent 的第一个轮次内，把继承的覆盖项作为 `sandbox/mode`/`approval/policy` 事件盖章写入（已合入的第一版实现）**：已被取代。它保住了「日志即存储」的惯用法，零格式变更，但评审发现了一个轮次封闭契约无法修补的持久性漏洞：空闲时的 SessionStart 式注入会在任何提示词轮次开启之前就持久化一个完整的一次性轮次，在该窗口内崩溃会留下一个看似可恢复、却没有任何继承策略的子 agent，而且不存在更早的事件锚点（创建时的追加只是崩溃残留的尾部垃圾，注入轮次不派发任何 waterfall，`session/event` 监听器也无法重入追加）。会话头基线一举关闭所有时序窗口，并删除了事件方案所需的监听器／前置安装／去重机制。
- **在子 agent 创建时（任何轮次之外）盖章**：不予采纳。持久化契约在轮次边界提交，因此轮次开始前的裸事件在重新加载时会被当作撕裂尾部截断；会话不变量测试套件会直接判这种追加失败。
- **每次调用时沿 `parentSession` 实时解析**：不予采纳。这会打破「两个会话永远看不到彼此状态」的隔离不变量，要求父会话在子 agent 的整个生命周期内保持加载，还会让父级在子 agent 运行途中做的切换追溯性地改变一个正在运行的子 agent。委派时快照才是本设计的语义：子 agent 保持它被交付时的策略；取消后重新 spawn 即可拿到收紧后的策略。
- **给每个进程内子 agent 强制设置 `approvalPolicy: 'never'`**：不予采纳。这在今天是事实（没有应答器认领它们），但它会静默排除未来能够服务子 agent 的应答器，并搅浑继承语义；只继承父级的覆盖项既保住 fail-closed 结果，又让每次请求的拒绝原因保持诚实。
- **把子 agent 的审批请求路由给根会话的控制方**：继续延后，结论与[审批 seam Agent Note](2026-07-06-approval-seam.md) 相比没有变化：ACP 提示必须附着在一个流式工具调用上，后台子 agent 的发起调用早已返回，而且桥接器还需要父链所有权以及 start 请求上携带发起 spawn 的 `callId`。在此记录，以免这些障碍被再次推导。

## 后果

- 父级收紧后的沙箱模式与 `'never'` 审批立场现在会约束 spawn 子 agent、fork 子 agent（无论种子时机如何）与孙代 agent；委派旁路在每一层深度都已封死，且不存在任何第一轮次的时序窗口（否决、注入、崩溃）。该行为由 `packages/subagent/subagent-inprocess/tests/inheritance.spec.ts` 中的真实围栏测试套件钉住（脚本化模型驱动的子 agent 通过真实 `write` 工具撞上真实的 `dsh-fs-sandbox` 围栏，按落盘状态与拒绝标记断言——其中包括委派与延迟切换之间的竞态用例、一个具备否决能力的 prompt-submit 监听器用例，以及子 agent 任何轮次开始前的会话头持久性用例），并由两个服务各自测试套件中的 `overrideOf` 契约测试钉住（基线读取、种子边界优先级、封闭词汇拒绝）。
- 基线随 `SessionHeader` 通过两个持久化后端存储（JSONL 头部行字段；SQLite `sessions` 表中的列，`SCHEMA_VERSION` 提升到 11——预发布阶段，无迁移），因此恢复时它像 `delegationDepth` 一样被还原；子 agent 之后仍可被独立切换，其自身种子之后的事件优先于基线。
- 已接受的限制：子 agent 已在运行时父级再做的切换不会传播（快照语义）；进程外后端（`subagent-acp`、子进程形态的子 agent）在这里不继承任何内容：它们的策略归子 harness 自身的部署所有，属于沙箱 Agent Note 中延后的阶段。
- 快照覆盖只运行在部署强度上：已录制的 `subagent-sandbox-inheritance` 场景经由组装后的 ACP 应用，证明了一个被委派的子 agent 被约束在只读的部署级策略之下，但这个仅面向自动化的协议没有会话作用域的切换，因此仅父级的覆盖项（更宽的默认值、收紧的父级、被拒的子 agent）在该协议上无法表达。待接手时，其形态沿用 headless 套件的语义检查点先例：预置一份携带真实 `sandbox/mode` 切换的已持久化父级日志，经由一个恢复用的 fixture（测试前置数据）插件在 Loader 启动的 cli-demo 应用中恢复它，再让它发起委派——这是一次场景 harness 的扩充（headless 套件尚无 subagent+沙箱 overlay），而非新机制。
- `dsh-subagent-inprocess` 将 `dsh-sandbox-policy` 与 `dsh-user-approval` 声明为对等依赖（peer dependency），以支撑 `ctx.get` 的类型；两者在运行时仍然可选。`SessionHeader` 新增两个中性的可选字符串字段；`SESSION_FORMAT_VERSION` 保持为 0（仅新增字段，预发布阶段）。
