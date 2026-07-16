# RFC：动态工作流——脚本驱动的多 agent 编排 seam

Status: implemented

[English](2026-07-05-dynamic-workflows.md) | 中文

## 问题

harness 可以将一个任务委派给一个子 agent（`dsh-tool-subagent`），但需要扇出到多个独立片段的工作——跨多文件审计、迁移、多角度调研、对抗式验证——迫使模型逐轮次编排：每个中间结果都落入父上下文，计划没有持久存放处，每一步的协调都要消耗一次模型往返。Claude Code 以[动态工作流](https://code.claude.com/docs/en/workflows)的形式提供这一能力：模型编写一段 JavaScript 编排脚本，运行时执行它，由脚本（而非对话）持有循环、分支和中间结果。

## 决策

在 `packages/workflow/` 下以 bash seam 的形态（接口／实现／消费方）提供一组工作流能力，加上 subagent seam 上它所需的结构化输出基础。

### 脚本契约（兼容 Claude Code）

一次工作流调用包含 JSON `meta`（`name`、`description`，以及可选的 `whenToUse`/`phases`）和一段支持顶层 `await` 并返回 JSON 值的 JavaScript `script` 正文。元数据作为数据校验，从不被求值。正文接收 `agent(prompt, options)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`phase(title)`、`log(message)` 和 `args`。pipeline 各阶段接收 `(prev, item, index)`，阶段间无屏障；失败的子 agent 和普通阶段错误将受影响的 item 解析为 `null` 并跳过其剩余阶段。Claude Code 的确定性限制通过 journaling 延后处理，因此兼容的脚本正文在将 meta 头移入参数后，可以使用时钟和随机数。

与 Claude Code 的一处刻意**偏离**：钩子误用——未知或延后的选项（`effort`/`isolation`/`agentType`）、格式错误的参数、超出支持子集的 schema、触发上限、seam 启动失败——抛出 `fatal: true` 的 `WorkflowError`，组合器对 fatal 错误**重新抛出**而非将 item 置为 null。如果不这样做，一个拼错的选项会溶解为与子 agent 失败无法区分的 `null`——正是本仓库禁止的「接受后静默忽略」失败模式。一处**新增**：工具的 `args` 参数是 JSON 对象（裸列表会被包装为一个字段），以保持协议格式（wire format）的诚实。

### seam（dsh-workflow）

`ctx.workflows` 是 bash 形态的抽象 `WorkflowService`：每个上下文一个引擎，无命名提供方注册表（引擎是部署级替换，不是共存者）。`start(request)` 对无法启动的脚本同步抛出异常；返回的 `WorkflowRun` 的 `result` 永不 reject（失败解析为 `stopReason: 'error' | 'cancelled'`）。`workflow/*` 事件是仅供观察的 emit，携带数据快照（id + meta；`workflow/end` 不含 result 值），按监听器隔离，与 `subagent/start`/`subagent/end` 对称——控制权留在 run 的持有者手中。词汇细节见 [core-data-structures/workflow.md](../../../core-data-structures/workflow.md)。

### 引擎（dsh-workflow-workerthread）：每次运行一个 worker 线程

**信任前提**：工作流脚本与模型的 bash 访问享有相同信任级别。引擎约束有 bug 的脚本，保证 result 必定 settle、值 JSON 安全、取消后静默；它不防御恶意代码。vm 上下文和 worker 线程不是安全边界：脚本可以逃逸到具有进程级权限的 Node API。沙箱化需要在此 seam 之后放置一个独立进程或 isolated-vm 引擎。

**为何选择 `node:worker_threads`**：每次运行获得一个非池化 worker。vm 上下文限制了文档化的脚本表面，而 message-port RPC 将 `agent()` 桥接到宿主侧的子循环。worker 防止脚本的同步工作阻塞宿主，提供序列化边界，并允许取消后强制终止。`isolated-vm` 因其维护状态和部署要求被否决。

宿主在发布前校验元数据并解析正文。私有枚举键的 payload map 定义协议格式；待启动记录、已发布的子记录、单一取消信号、worker 死亡回收、result 优先级和 dispose 静默在协议两侧维持 subagent run 契约。[agent-scope runtime-design RFC](../architecture/2026-07-12-agent-scope-runtime-design.md#workflow-children-are-pending-starts-or-published-records) 拥有这些竞态算法。

引擎暴露一条进程内 `MessageChannel` 测试路径，因为主进程 V8 覆盖率无法观测 worker 执行。

**Meta 是数据**：经 schema 校验的 `meta` 字段以 JSON 形式到达 seam，仅做形状校验。宿主从不对元数据字面量求值——否则脚本控制的访问器会在 worker 隔离之外运行。

**值边界**：`materializeFromRealm` 复制出站值，拒绝函数、symbol、嵌套 `undefined`、异域原型、循环引用、稀疏数组和非有限数。数据属性复制使 `"__proto__"` 安全；getter 正常读取，抛出异常的 getter 会大声失败。`args` 通过 `workerData` 传入，暴露前再次克隆。realm 函数被调用而非复制，抛出的值使用全量渲染器以确保 `result` 不会 reject。钩子错误是宿主 realm 的 `WorkflowError`，因此脚本按 `name` 或 `code` 分支而非 `instanceof Error`，如引擎 README 所述。并发、total-agent、item、超时和 grace 限制均为经校验的配置。

### 消费方（dsh-tool-workflow）

一个 `workflow` 工具，镜像 `dsh-tool-subagent` 的同步形态：启动、等待、`try/finally` dispose、abort 桥接 `exec.signal`、非 `completed` → `isError`。渲染意图：一张以调用的 `meta.name` 参数为标题的 `generic` 卡片（展示是参数的纯函数）。工具描述即面向模型的编写规范。使用策略作为工具自身的 `tool:<toolName>` prompt 段随工具一起交付（显式请求才使用的指导——工具指导存在于工具插件中，从不放在部署 persona 里）；harness 没有 ultracode 风格的 effort 门控。

### 基础：subagent seam 上的结构化输出

`SubagentStartRequest.outputSchema` 由 `dsh-subagent-inprocess` 为两个进程内后端实现。每个结构化子 agent 在 `child.ctx` 上获得自己的作用域捕获工具、指令和强制注册；并发子 agent 可以使用不同 schema 而不共享可变策略，dispose 子 agent 时整个附件被移除。

输出 schema 使一次 schema 有效的已提交捕获成为子 agent 成功完成的必要条件。作用域运行时呈现捕获工具和指令，仅提交成功的最终结果（包括 SDK 调用的外层 `run_code` 结果），在捕获进入 pending 状态后拒绝后续副作用，并在提交后不再请求模型步骤即停止子 agent。校验失败仍为可重试的工具错误；干净完成但没有已提交捕获的情况 settle 为错误。

`StructuredOutputSchema` 是 `dsh-tools` 中可强制执行的原始 JSON-Schema 子集（单字符串 `type`、`properties`/`required`/`additionalProperties`、`items`、标量 `enum`/`const`），不支持的关键字会大声失败，因为该协议数据会逐字成为捕获工具的 parameters。[agent-scope runtime-design RFC](../architecture/2026-07-12-agent-scope-runtime-design.md#structured-output-commits-only-authoritative-outcomes) 拥有组装、提交、守卫和终止停止的正确性算法。

## 测试

worker 侧逻辑通过进程内 `MessageChannel` 运行，以便 V8 覆盖率能度量它。单元测试覆盖脚本辅助函数、fatal 与 nullable 失败、JSON 边界、上限、取消、子 agent 所有权和通过真实循环的结构化输出。built-bin 冒烟测试在纯 Node 下运行单独打包的 `lib/worker.cjs`，带 key 的 e2e 驱动真实子 agent，面向模型的工作流行为通过其所属示例进行快照覆盖。

## 延后（本轮明确的非目标）

- **后台收集**（启动工具 → run id → 完成通知 → 收集），与 bash/subagent 后台统一一起设计。
- **Journaling + 恢复**（`resumeFromRunId`、缓存的 agent() 前缀）：实现它会将 Claude Code 的确定性禁令作为脚本契约收紧重新引入（脚本今天可以读取时钟）。
- **保存/打包的工作流**（`.deepseek/workflows/` 注册表、斜杠命令界面）和**脚本持久化到 run 目录**（tool-call 事件已经持久记录了脚本）。
- **嵌套 `workflow()`**、**token `budget`**，以及 `effort`/`isolation`/`agentType` agent 选项（每个都以命名延后项的消息大声拒绝）。
- **整体运行的挂钟超时**：取消总能释放调用方（result 在 grace 内 settle），因此总运行时间上限是后台重设计的策略旋钮，不是此处的正确性需求。
- **超越 worker 线程的引擎加固**：在同一 seam 之后放置 isolated-vm 或独立进程引擎（真正的沙箱化；内存限制）。
- **ACP 进度 UI**：基于 `workflow/*` 事件（`/workflows` 风格的视图）；事件已为此存在。
- **ACP 后端结构化输出**和 **`toolFilter`**（两者仍为能力门控 `false`）。

## 曾考虑的替代方案

- **宿主侧的恶意值防御**（无 trap 代理拒绝、从不调用访问器的描述符遍历、realm 侧预渲染抛出值、realm 构建的 promise/array/error 克隆并带结构化 fatal 识别）：否决。每项防御针对的都是信任前提所接受的作者，而线程的序列化边界已经从构造上使跨 realm 值全量化。
- **进程内 `node:vm` 执行**：机制最简——无 RPC、无线程——但 `start()` 会在脚本首段同步切片期间阻塞调用方，首个 await 之后的同步自旋无法在进程内被杀死（vm `timeout` 仅覆盖首段切片），`dispose()` 只能在宿主循环上放弃一个未 settle 的脚本。worker 线程引擎保持相同的 vm 上下文脚本表面，同时解除宿主阻塞并使终止成为现实。
- **后台执行作为默认**（Claude Code 的形态）：延后。前台同步与 `dsh-tool-subagent` 的当前形态一致，后台语义应在 bash/subagent/workflow 之间统一设计一次，而非逐工具各做一套。
- **工作流层为 `agent({schema})` 做 JSON 解析**：在一个消费方重复 seam 的关注点，而 seam 的能力标志仍不诚实地为 `false`。
- **Meta 嵌入脚本内作为 `export const meta = {...}`**（Claude Code 的精确格式）：保持脚本自包含且 Claude Code 脚本可直接使用，但获取 meta 需要在宿主上对模型编写的文本求值。即使是空的限时 vm 上下文，在宿主读取结果对象时也无法约束脚本控制的 getter。JSON 参数消除了扫描器、求值和宿主自旋漏洞；代价是 Claude Code 脚本的 meta 头必须移入参数（正文保持可直接使用）。
- **`SchemaSpec` 作为 outputSchema 类型**：面向作者的 DSL 无法表达以数据形式到达的内容，且无法在不丢失转换精度的情况下对其校验。
- **schema 对象库（zod 或仓库的 schemastery）用于结构化输出子集**：schema 是协议数据——纯 JSON，跨越 `agent({schema})` 中的 vm realm 边界，逐字落入强制工具的 parameters——正是活 schema 对象无法存在的位置；在运行时消费原始 JSON Schema 需要在其上叠加第三方转换器（zod core 只输出 JSON Schema，不做反向），且会在 schemastery 的配置角色之外引入第二种 schema 语言。
- **ajv 做值校验**：它校验完整 JSON Schema，因此子集门控——模块的真正要点，因为每个被接受的关键字都必须是 harness 所强制执行的——无论如何仍需手写；它通过 `new Function` 编译校验器；且它将成为 dsh-tools 的首个运行时依赖，所有这些只为替换约 70 行的值遍历器，而路径限定的、报告每一处违规的错误输出无论如何都是自定义的。
- **提供方 JSON 模式代替捕获工具**：它保证有效 JSON，不保证 schema 一致性，且它与工具调用的交互尚不明确。捕获工具保留了轮次内的校验重试。提供方侧的严格工具 schema 可以在不改变本设计的前提下进一步收窄接受的子集。

## 后果

扇出计划现在存在于可重新运行的脚本中，`outputSchema` 提供权威的结构化子 agent 结果。每次运行付出 worker 启动和 message-port RPC 的开销，但宿主启动保持非阻塞，取消可以终止 worker，序列化强制执行值边界。Worker 线程不是安全边界。无效选项会失败而非退化为 Claude Code 的 `null`；消费方通过 run 句柄保持控制，观察者仅接收快照。
