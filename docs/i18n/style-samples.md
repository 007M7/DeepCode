# 翻译语体样例（style samples）

本文件是翻译语体的校准锚点：每组样例是一段英文原文与一段人工定稿的中文译文，覆盖本仓库文档的主要文体。**译文的语体以这些样例为准**——它们的效力高于任何对语气的文字描述。翻译或评审时对照最接近的文体样例；样例与规则冲突时，样例胜出。本文件中英对照、自成双语，不参与配对（见 [README.md](README.md) 排除清单）。

维护方式：人工评审校准出新的金标段落后追加到对应文体；样例只增不改，改动需评审人签字（PR 评审即签字）。

## ① 架构叙述

> This document describes the architecture of the DeepSeek Harness — the foundation of **DeepSeek Code**. The governing principle, from the microkernel design discussion: **everything is a plugin**. The core is deliberately tiny — a handful of abstract services plus one concrete loop plugin (`dsh-agent-loop`) — and every product feature is a plugin against the extension surface described here, without modifying the loop.

本文介绍 DeepSeek Harness 整体架构，它是 **DeepSeek Code** 的底层基座。微内核设计讨论中确立了核心设计准则：**一切皆插件**。内核刻意做得极精简，仅包含少量抽象服务，外加一个实体循环插件 `dsh-agent-loop`。所有产品功能均基于本文定义的扩展接口开发为独立插件，无需改动主循环逻辑。

> Dependency rule: extension plugins depend on interfaces, never on `dsh-agent-loop` (the loop is swappable); the sanctioned exception is the composition bundle `dsh-agent-core`, whose job is assembling the concrete spine.

依赖约束规范：各类扩展插件仅依赖抽象接口，严禁直接依赖 `dsh-agent-loop`（该主循环支持替换实现）；唯一允许的特例是组合包 `dsh-agent-core`，它的职责是组装整套实体主干。

> This document covers **behavior**; type shapes live in [core-data-structures/](../core-data-structures/core.md), the per-event/service reference in the [generated catalog](../cordis-catalog/events.md), per-package contracts in the package READMEs ([map](../../packages/README.md)).

本文档描述整体行为逻辑；类型定义存放于 [core-data-structures/](../core-data-structures/core.md)；各类事件、服务的详细参考见[生成目录](../cordis-catalog/events.md)；各 package 对外约束协议写在对应包的 README（[索引](../../packages/README.md)）。

## ② 防御模式规则

> Hard-won bug-class rules: each pattern below is a class of defect that actually shipped or nearly shipped here, stated as the rule that prevents its recurrence. Read this before writing lifecycle, concurrency, subprocess, or teardown code.

这些都是踩坑总结得出的缺陷分类规范：下文每种范式都对应一类曾上线、或险些流入线上的问题，每条规范旨在杜绝同类问题复现。编写生命周期、并发、子进程、资源销毁相关代码前，请务必阅读本文档。

> **Dispose must reach quiescence, not just request it** — A teardown that issues kills/aborts but returns before the work stops leaves orphans. Make cleanup async and await the children's exit (kill → await `done`), and close listener/notification registries BEFORE killing so late completions stay silent. Tests prove disposal waited (pid gone right after `await fiber.dispose()`), not merely that the process eventually dies.

**销毁操作必须等待所有任务完全停稳，不能仅下发终止指令就返回**——若销毁逻辑仅发送终止、中断信号，但不等任务停止就直接退出，会产生孤儿进程。清理逻辑需设为异步，等待所有子任务彻底退出（先下发终止信号，再等待执行完成）；在执行终止操作前先关闭监听器与通知注册表，让延迟到达的完成事件不再触发任何通知。测试要验证销毁流程确实完成等待：执行完 `await fiber.dispose()` 后进程 PID 立即消失，不能仅校验进程最终会自行消亡。

> **Async state is not synchronous state** — `agent.send()` does not flip status before returning; a background task's completion races turn boundaries; `reader.close()` fires for both EOF and disposal. Never gate control flow on a status you only just requested — drive lifecycle off the events/promises that actually fire (`agent/status`, `task.done`), and observe the transition (saw `running` THEN `idle`) rather than counting actions you assume map 1:1 to turns.

**异步状态不等同于同步瞬时状态**——调用 `agent.send()` 不会在返回前同步更新状态；后台任务完成时机与轮次边界存在竞态；调用 `reader.close()` 既可能是读到文件末尾，也可能是资源销毁触发。切勿仅凭刚查询到的状态来阻断流程；生命周期逻辑应基于真实触发的事件与 promise 驱动（`agent/status`、`task.done`），观测完整状态切换（先 `running`、再 `idle`），而非主观认定操作和执行轮次一一对应（主循环会批量处理排队消息）。

## ③ 测试政策清单

> **Coverage gate** (`pnpm run test:coverage`): the gating run, per-file 100% on `packages/*/*/src`. An uncovered line is often dead code the gate is correctly flagging for deletion, not a missing test to bolt on. Line coverage is necessary, never sufficient — it proves lines ran, not that the feature works as shipped.

覆盖率门禁（`pnpm run test:coverage`）：作为合入门禁校验，要求 `packages/*/*/src` 目录下每个文件行覆盖率达到 100%。未覆盖代码行大多是无用死代码，门禁标记这类代码是提示删除，而非单纯补充测试。行覆盖率是必要条件，但远不充分：它仅能证明代码被执行过，无法保证功能符合线上预期。

> We are DeepSeek — do not ration real-API tests. A no-key test proves the plumbing; only a with-key run proves the agent works against a real model. Write many: real prompts that write files, multi-turn conversations, tool use, cancellation mid-stream. Cheapest and highest-value are **smoke tests** that boot the real example, send one real prompt, and check the world — they catch the "green unit tests, broken product" class that mocks structurally cannot. The self-skip exists only so secretless CI and keyless contributors aren't blocked; it is not a cost signal.

我们是 DeepSeek：真实接口相关测试不得刻意缩减用例数量。无密钥测试仅能验证底层通路；只有携带有效密钥执行的用例，才能确认 agent 可正常对接真实模型。请大量编写此类测试：包含文件写入类真实提示词、多轮对话、工具调用、流式中途取消等场景。

成本最低、收益最高的是**冒烟测试**：拉起完整真实示例，发送一条真实提示并校验整体运行状态。这类用例能捕获一类问题——单元测试全部绿灯，但产品实际运行故障，单靠 mock 完全无法发现这类缺陷。

自带自动跳过逻辑，仅用于保障无密钥 CI 环境、无权限贡献者不会被流程拦截，不代表可以以此为由削减真实接口测试投入。

> **Prefer the real implementation over a mock** — Mock only the genuinely expensive or non-deterministic boundary (the LLM adapter, the network, the clock); keep everything downstream real. A hand-rolled stand-in proves the bridge moves bytes, not that the shipping tool behaves as asserted — the two drift while the test stays green.

**优先使用真实实现，而非 mock 替身**——仅对开销极大、结果不确定的边界模块做 mock（LLM 适配器、网络、时钟），其余下游组件全部使用真实实现。手写的 mock 替身只能验证数据通路能传输字节，无法保证线上工具符合预期逻辑；长期下来业务逻辑与 mock 实现会出现偏差，但测试仍会显示通过。

## ④ 机制描述

> Blob hashes, not commit hashes, so the record is computable for files edited in the same PR (`git hash-object foo.md`) and consistency is a pure content comparison. The recorded hash also recovers the exact last-confirmed text of either side (`git cat-file -p <hash>`), so an out-of-sync pair is updated by diffing the edited side against its last-confirmed state and patching the counterpart minimally — never by re-translating whole files.

系统采用文件 blob hash 而非 commit hash 记录状态。同一 PR 内修改文件时，可通过 `git hash-object foo.md` 直接算出对应 blob hash，仅对比文件内容即可判断双语文档是否同步。通过记录的 blob hash，可使用 `git cat-file -p <hash>` 还原上次确认对齐时两侧的原文。当双语文档不一致时，只需对比修改版本与上次确认版本的差异，最小幅度同步修改另一侧译文，无需全文重新翻译。

## ⑤ 政策声明

> The gate's limit, stated plainly: a green gate means the pair was confirmed consistent at these exact contents, not that the confirmation was sound. It checks hashes and shape; it cannot judge whether the two sides actually say the same thing — that is the reviewer's half of the contract. A re-recorded pair with a sloppy counterpart passes the gate; it must not pass review.

明确门禁校验边界：门禁校验通过，仅代表两份文档哈希与结构完全匹配，不代表译文内容准确无误。门禁仅校验哈希与结构，无法判断双语表意是否统一——译文质量把关是评审人的责任。即便译文粗糙、表意偏差，只要哈希匹配，门禁就会放行，但这类 PR 绝不能通过人工评审。

## ⑥ RFC 论证

> Comparing git timestamps of the pair (no record) — rejected: formatting-only edits would false-positive, and a counterpart committed after an unrelated edit would false-negative; content identity is the only signal that means what the gate claims.

对比双语文件的 git 时间戳（无记录方案）——不予采纳：仅调整格式的改动会触发误报，无关修改后再提交译文又会造成漏检。只有基于内容本身的标识（每侧文件的 blob hash 与伴随记录比对），才能承载门禁所声称的语义。

## ⑦ 推进策略（长段拆分示范）

> **Rollout**: new documents don't wait for a batch — a date-named document dated on or after the manifest's `requiredSince` cutoff must merge with its pair, so everything new is bilingual from birth. For the back-catalog, the `required` list in the manifest is the enforcement frontier, not the goal. […] Pairing a document is a commitment: every later edit to either side must carry the counterpart along, so grow the frontier at the pace translation review is actually resourced, not ahead of it.

**推进**：新增文档不再走批量分批翻译流程。以日期命名的文档，若其标注日期等于或晚于 manifest 里 `requiredSince` 分界时间，提交合入时必须配套对应的双语译文文件——所有新文档从创建起就要求中英双语齐备。针对存量旧文档：manifest 内的强制翻译列表只是当下执行红线，并非最终目标。（……）文档完成双语配对等同于一份长期约束承诺：后续只要修改任一版本，就必须同步更新对应另一语种文件。因此强制翻译范围的推进节奏，要匹配翻译评审实际可投入人力，切勿超前铺开。

## 从样例提炼的要点

- 语体是规范制度文：完整主谓、确定语气；不口语化，也不学术腔。
- 给句子补显式执行主体：英文的被动句和抽象主语，中文写成「系统／门禁／工具／评审人」做主语。
- 用中文工程惯用语替换直译：false positive/negative→误报／漏检、enforcement frontier→执行红线、ratchet→只向前收紧不倒退放宽、reviewable act→评审凭证。
- 隐喻本地化而非移植：bilingual from birth→从创建起就要求双语齐备；grandfathered→历史存量遗留。
- 类别名词说中文并在首现括注英文：实操手册（cookbook）、事故复盘（postmortem）；指目录或路径时保留代码体英文。
- 长段按语义单元拆段，一段一件事；名词短语展开为动词句。
- 母语重写不等于删减：原文每个语义成分都要落地。
- 样例与 [terminology.md](terminology.md) 冲突时，以术语表为准：收录样例前按表修正术语（例如 agent、mock、LLM 保留英文，cancellation 译「取消」）。
- 代码体标识符（事件名 `agent/status`、状态值 `running`、包名 `dsh-bash-local` 等）在译文中保留 code span 原文，不得口语化改写——这是行文规则的硬边界，Pass 2 逐句核验的重点。
