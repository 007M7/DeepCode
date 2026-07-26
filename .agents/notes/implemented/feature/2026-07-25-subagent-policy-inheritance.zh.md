# Agent Note: 进程内 subagent 策略继承——子 agent 在父级的沙箱与审批覆盖项下启动

Status: implemented

[English](2026-07-25-subagent-policy-inheritance.md) | 中文

## 问题

会话策略覆盖项是按会话的日志折叠：生效沙箱模式等于 `fold(session's sandbox/mode events) ?? deployment default`（[沙箱 Agent Note](2026-07-06-sandbox.md)），审批策略以同样的方式折叠 `approval/policy`。进程内 subagent 的子 agent（智能体）拿到的是一个全新会话，因此没有任何覆盖项能跨过委派边界：父 agent 已切换到 `read-only` 时，其 spawn 子 agent 却运行在（可能更宽的）部署默认值之下，委派成了绕开用户收紧的旁路通道；fork 子 agent 只能继承恰好落在其已完成轮次种子内的切换，而恰恰漏掉最常见的时机（用户在 agent 空闲时切换，切换落在最后一个 `turn/end` 之后、种子之外）。审批策略为 `'never'`（无头／CI 场景）的父 agent，其创建出的子 agent 同样回退到了会向用户弹出提示的默认策略。被拒的子 agent 看到的升级提示文案（「审批提示会询问用户」）还承诺了一个永远不会有应答器送达的提示。

## 决策

共享的进程内驱动器（`packages/subagent/subagent-inprocess` 中的 `startInProcessRun`）在委派时快照父级的策略覆盖项，并在子 agent 的第一个轮次内把它们作为普通日志事件盖章写入子会话：

- **委派时同步捕获，首个 `agent/prompt-submit` 时盖章。**驱动器在自己的第一个 await 之前就为两个策略旋钮读取 `overrideOf(parent.session)`——委派时刻即快照点，因此与异步的子 agent 创建过程赛跑的父级切换属于父级的未来，而非子 agent——并在创建事务的 setup 窗口内安装一个一次性的、限定子 agent 作用域的 `agent/prompt-submit` 监听器，且采用前置安装，使得具备否决能力的监听器（会作出拒绝的 UserPromptSubmit 钩子）无法在未盖章的情况下结束第一个轮次。prompt-submit 阶段在 `turn/start` 之后、提示词组装之前运行，因此盖章事件被包围在轮次内（具备持久性：轮次之间的裸事件在重新加载时只是崩溃残留的尾部垃圾），并且对子 agent 的第一次请求可见（继承来的 `'never'` 能进入子 agent 的第一份系统提示词）。由注入触发的第一个轮次（SessionStart 钩子与提示词赛跑）不会饿死该监听器：注入轮次既不派发 prompt-submit 也不发起模型请求，因此盖章仍会落在子 agent 的第一次模型请求之前。
- **只复制覆盖链，且全部走规范写入路径。**`overrideOf(session)` 只是折叠本身——从不包含部署／配置默认值——因此未切换过的父级不盖任何章，恢复后的子 agent 继续跟随实时默认值；`stampOverride(child, value)` 通过 `setSandboxMode`/`setApprovalPolicy` 追加，除非子 agent 已折叠出该值。驱动器以可选方式消费这两个服务（`ctx.get`，仅类型导入）：未挂载它们的组合照旧进行无策略委派，行为不变。
- **fork 陈旧种子的优先级由日志顺序自然得出。**盖章事件落在种子携带的任何切换之后，因此既有的「最后一个事件生效」折叠即可解析出子 agent 的模式，无需新增优先级机制；种子已携带相同覆盖项时会去重，而不会重复盖章。
- **嵌套按构造即可组合。**孙代 agent 盖章时折叠的是其父级（即上一层的子 agent）的日志，而该日志已经包含这个子 agent 被盖章（或自行切换）的覆盖项：这条链在每层委派处收拢一级，任意深度均成立。一次性的 `allowed-once` 升级授权从不进入任何日志，因此永远不可能沿链向下泄漏。

### 被拦住的子 agent 会经历什么

受限子 agent 撞上围栏时得到的是普通拒绝标记；升级重试会经过真实的审批 waterfall（瀑布式事件）解析，而其中没有任何应答器认领进程内子 agent，最终落到那个独立的 fail-closed 原因（`no approval channel is available`）。恢复路径是把拒绝向上汇报：父 agent 由编辑器持有，可以在自己的会话里发起升级，或在用户放宽模式后重新委派。继承来的 `'never'` 连这次注定无效的重试都会省去：子 agent 的第一份系统提示词已经写明不要请求升级。

## 考虑过的替代方案

- **在 `SessionHeader` 的 meta 中放 `sandboxMode`/`approvalPolicy` 基线（沿用 `delegationDepth` 先例）**：不予采纳。它确实能扛住事件方案唯一丢失的边角场景（子 agent 在第一个 `turn/end` 前被强制杀死、随后又被恢复时会丢失盖章），但那样的子 agent 尚未完成任何工作，恢复毫无价值；而该会话头字段的代价是一次会话格式扩展、一条持久边界上的校验路径、每个折叠消费方（`resolve()`、pty-local、权限展示）里的种子切片优先级逻辑，以及策略状态的第二个存放处。事件方案不改动任何折叠、任何格式、任何消费方。
- **在子 agent 创建时（任何轮次之外）盖章**：不予采纳。持久化契约在轮次边界提交，因此轮次开始前的裸事件在重新加载时会被当作撕裂尾部截断；会话不变量测试套件会直接判这种追加失败。
- **每次调用时沿 `parentSession` 实时解析**：不予采纳。这会打破「两个会话永远看不到彼此状态」的隔离不变量，要求父会话在子 agent 的整个生命周期内保持加载，还会让父级在子 agent 运行途中做的切换追溯性地改变一个正在运行的子 agent。委派时快照才是本设计的语义：子 agent 保持它被交付时的策略；取消后重新 spawn 即可拿到收紧后的策略。
- **给每个进程内子 agent 强制设置 `approvalPolicy: 'never'`**：不予采纳。这在今天是事实（没有应答器认领它们），但它会静默排除未来能够服务子 agent 的应答器，并搅浑继承语义；只继承父级的覆盖项既保住 fail-closed 结果，又让每次请求的拒绝原因保持诚实。
- **把子 agent 的审批请求路由给根会话的编辑器**：继续延后，结论与[审批 seam Agent Note](2026-07-06-approval-seam.md) 相比没有变化：ACP 提示必须附着在一个流式工具调用上，后台子 agent 的发起调用早已返回，而且桥接器还需要父链所有权以及 start 请求上携带发起 spawn 的 `callId`。在此记录，以免这些障碍被再次推导。

## 后果

- 父级收紧后的沙箱模式与 `'never'` 审批立场现在会约束 spawn 子 agent、fork 子 agent（无论种子时机如何）与孙代 agent；委派旁路在每一层深度都已封死。该行为由 `packages/subagent/subagent-inprocess/tests/inheritance.spec.ts` 中的真实围栏测试套件钉住（脚本化模型驱动的子 agent 通过真实 `write` 工具撞上真实的 `dsh-fs-sandbox` 围栏，按落盘状态与拒绝标记断言——其中包括委派与延迟切换之间的竞态用例，以及一个具备否决能力的 prompt-submit 监听器用例），并由两个服务各自测试套件中的 `overrideOf`/`stampOverride` 契约测试钉住。
- 盖章写入的覆盖项是子 agent 自己的持久记录：恢复时它像任何一次切换一样被回放；子 agent 之后仍可被独立切换，驱动器不会重新盖章覆盖它（一次性监听器加折叠去重）。
- 已接受的限制：子 agent 已在运行时父级再做的切换不会传播（快照语义）；子 agent 在第一个 `turn/end` 前被强制杀死后，恢复时会丢失盖章（恢复无价值的边角场景，上文已记录）；进程外后端（`subagent-acp`、子进程形态的子 agent）在这里不继承任何内容：它们的策略归子 harness 自身的部署所有，属于沙箱 Agent Note 中延后的阶段。
- `dsh-subagent-inprocess` 现在将 `dsh-sandbox-policy` 与 `dsh-user-approval` 声明为对等依赖（peer dependency），以支撑 `ctx.get` 的类型；两者在运行时仍然可选。
