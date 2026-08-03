# Agent Note：会话的 agent 由一份 preset cordis.yml 组装而成

Status: implemented

[English](2026-08-03-per-session-agent-presets.md) | 中文

## 问题

一个 `dsh` 进程服务多个会话，但决定 agent（智能体）究竟是什么的那套组装——它的工具、人设、提示词段落、委派后端——由启动器所引导的 `cordis.yml` 一次性固定给整个进程。若某个部署希望一个 benchmark 精简 agent 与一个完整编码 agent 并存，就必须跑两个进程；而现有的变通方案（`apps/cli/config/core-web.cordis.yml`，一个用来禁用工具行的 `--config` 覆盖层）会一次性改变所有会话。

对"让会话自选组装"最直觉的理解，是 loader 需要新增一层。其实不需要。[`dsh-tools`](../../../../packages/core/tools/README.md) 与 [`dsh-system-prompt`](../../../../packages/core/system-prompt/README.md) 本就按调用方上下文的 scope 分层归档注册，而且 [agent 本身就是一个注册 scope](2026-07-08-agent-scope-contexts.md)。此前缺的只是一种把整份 `cordis.yml` 指向某一个 agent scope 的办法。

## 决策

**preset** 是一个目录，其中放置一份 `agent.cordis.yml`。agent 工厂的 `setup(agentCtx)` 把它作为 Cordis `include` 子树，挂载到该 agent 的 scope 上下文之下。entry 上下文沿原型链连到子树被挂载时所在的上下文，因此 preset 内部的每一次注册都落进该 agent 的分层，并随 agent 一起卸载。没有任何注册表新增分层，也没有任何已在运行的会话被触及。

组装划分为两个平面，依据是什么必须共享，而不是什么感觉上与 agent 有关：

| 平面 | 实例数 | 内容 |
|---|---|---|
| 宿主 | 一份 | 注册表本身（`tools`、`systemPrompt`、`agents`、`agent-loop`、`sessions`）、跨会话设施（持久化、查询、投影、存储、设置、凭据、遥测），以及 web 宿主 |
| agent | 每会话一份 | 单个 agent 对这些注册表的贡献：工具插件、人设与提示词段落、委派后端、压缩策略 |

模型路由不进 preset。`installAgentLlmTarget` 已经是 provider、model 与 reasoning effort 的按 agent 可替换点；而挂在 preset 内部的 LLM 适配器永远不会被 `agent-loop` 解析到，因为后者位于宿主平面。

挂载默认按会话进行。实测一份十二行组装每会话约 3ms、约 600KB，因此隔离比任何共享方案都更划算；而由用户或 agent 写出的 preset 也因此拥有尽可能小的影响面。确实自带昂贵单例的 preset，可以用 Cordis 自身的 `isolate` 词汇显式选择共享：命名 realm 的 label 是进程级全局的，因此两棵子树只要写同一个 label 就解析到同一个实例。

## 后果

**直接挂载的子树对启动审计不可见。** 它不会把自己关联到 `Entry`，因此不在 `ctx.loader.entries()` 中，`assertEntriesActivated` 也看不到它。改由挂载过程自行校验各行，通过一个会公开自身 tree 的 `Include` 子类读取。

**preset 不得把服务发布进根 realm。** 这类服务是进程级全局而非按会话的，因此第二个挂载同一 preset 的会话会与第一个相撞——而这次相撞表现为 `setup` 永远观察不到的未处理 rejection，留下一个看起来健康、实则组装到一半的 agent。挂载改为直接拒绝它；本包的运行时不变量还会在每次服务通知时复查，因为从定时器或异步续体中发布的行会绕过一次性审计。

**失败会让 agent 回滚。** `setup` 在发布之前运行，因此挂载被拒绝会让 `ctx.agents.create()` 失败且不留残留。这正是 `setup` 是唯一受支持调用点的原因。

**fiber 归属判定用对象同一性，而非 `uid`。** `uid` 是按 registry 计数的序号，因此两个不同根下的 fiber 会在它上面撞号；按 `uid` 比较曾导致一个运行时的子树为另一个运行时中发布的服务背锅。`ctx.plugin()` 返回的是 thenable 的 `Object.create(fiber)` 包装对象，与父链中出现的 fiber 永远不同一，因此子树在构造时捕获自己的 fiber。

**preset id 对模型可见，必须写入日志。** 它决定工具集与提示词，因此被恢复的会话必须还原同一份组装；记录它属于会话事实，而非运行时状态。

## 考虑过的替代方案

**在 scope 注册表中新增 preset 分层。** `ScopedLayers.merge()` 把全局层与恰好一个精确 scope 层合并。新增中间层可以让多个会话共用一份已挂载的组装，但它要改动 `dsh-scope` 及每个 scope 感知的注册表，换来的只是毫秒级的开销节省，而且会让 preset 的注册获得一个没有任何 agent 拥有的生命周期。

**把 agent 的 scope 键设为 preset。** 同一 preset 上的会话就能免费共享一层，但按 agent 的注册——`installAgentLlmTarget`、按 agent 的工具限制——会跨会话相撞。

**把每个 preset 作为子进程运行。** [`subagent-dsh-sdk`](../../../../packages/subagent/subagent-dsh-sdk/README.md) 已经证明完整的子 harness 可行，隔离性也会是绝对的。但这同时意味着要按会话代理流式输出、审批与投影，那是一个传输层项目，而非组装问题。
