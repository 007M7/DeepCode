# RFC：能力 seam——接口／实现／消费方拆分

Status: implemented

[English](2026-06-13-capability-seams.md) | 中文

## 问题

harness 具有可替换的能力：目前是 bash 执行，未来会有沙箱／远程执行器和替代模型提供方。一项能力有三个关注点，它们以不同的速率、出于不同的原因变化：*契约*（这项能力是什么）、*实现*（它如何运行）、*消费方接口*（模型和其他插件面对什么来编程）。将三者打包在一个 package 中会耦合这些变化速率：把本地执行器换成沙箱执行器时，模型看到的工具 schema 也会被搅动，尽管面向模型的契约从未改变。

这与「运行时谁提供、谁需要一项能力」是不同的问题，后者 Cordis 已经用 service + `inject` 回答了（提供方注册 `ctx.bash`；消费方声明 `inject: ['bash']`，其 fiber 挂起直到该服务存在）。那套机制是必要的，但它不决定 package 边界；本 RFC 决定。

## 决策

一项可替换的能力拆为**三个 package**：

1. **接口**：一个抽象 service 加词汇类型，拥有 `ctx.<key>`，仅依赖 cordis（例如 `dsh-bash`：`BashExecutor`、`BashRunResult`、`BashTask`）。
2. **实现**：一个具体子类，以插件形式加载（例如 `dsh-bash-local`：子进程、进程组 kill、spill-file 截断）。沙箱／远程后端是实现同一接口的兄弟 package。
3. **消费方**：模型和插件看到的东西（例如 `dsh-tool-bash`：`bash`/`bash_output`/`bash_kill` 工具 schema）。消费方 `inject` 接口 key，从不导入实现类型。

实现与消费方随后独立演进：沙箱执行器替换 `dsh-bash-local` 时无需触碰任何工具 schema。

当各部分确实属于同一关注点时，拆分并非强制：LLM seam 将接口 + 消费方合并为 `dsh-llm`（消费方是 agent loop（智能体循环）本身，而非可替换的 schema 表面），适配器作为实现 package。不要预防性拆分：只有一种可设想的实现和一个消费方的能力保持为一个 package，直到第二个出现。

## 曾考虑的替代方案

- **合并为一个 package**：否决，因为它重新耦合了拆分所要分离的三种变化速率（这正是拆分的全部意义）。
- **`@cordisjs/plugin-capability`**：完全不同的维度。它是一个权限／能力*安全*服务（带继承的命名权限，通过 `ctx.capability.test` 对会话进行检测），是延后的权限／沙箱工作（`tools/pre-execute` deny/ask seam）的候选方案，而**不是**替换实现的机制。混淆这两个「能力」正是本 RFC 所指出的陷阱。

## 后果

每项能力多出更多 package 和更多样板代码（一套 `package.json`/`tsconfig`/README，加上 inject 接线）。换来的是：实现与消费方独立发布和版本化，新后端永远不会波及面向模型的契约。该规则记录在 [AGENTS.md](../../../../AGENTS.md) § Conventions（"Capability seams are three packages"）和 [architecture.md](../../../architecture.md) § "Capability seams" 中；bash 三件套是参考模板。何时合并、何时拆分是一个判断性决策，架构文档已做说明——本 RFC 记录的是*为什么*默认选择拆分。
