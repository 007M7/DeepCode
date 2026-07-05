# 翻译语体样例（style samples）

本文件是翻译语体的校准锚点：每组样例是一段英文原文与一段人工定稿的中文译文，覆盖本仓库文档的主要文体。**译文的语体以这些样例为准**——它们的效力高于任何对语气的文字描述。翻译或评审时对照最接近的文体样例；样例与规则冲突时，样例胜出。本文件中英对照、自成双语，不参与配对（见 [README.md](README.md) 排除清单）。

维护方式：人工评审校准出新的金标段落后追加到对应文体；样例只增不改，改动需评审人签字（PR 评审即签字）。

## ① 架构叙述

> This document describes the architecture of the DeepSeek Harness — the foundation of **DeepSeek Code**. The governing principle, from the microkernel design discussion: **everything is a plugin**. The core is deliberately tiny — a handful of abstract services plus one concrete loop plugin (`dsh-agent-loop`) — and every product feature is a plugin against the extension surface described here, without modifying the loop.

本文介绍 DeepSeek Harness 整体架构，它是 **DeepSeek Code** 的底层基座。微内核设计讨论中确立了核心设计准则：**一切皆插件**。内核刻意做得极精简，仅包含少量抽象服务，外加一个实体循环插件 `dsh-agent-loop`。所有产品功能均基于本文定义的扩展接口开发为独立插件，无需改动主循环逻辑。

> Dependency rule: extension plugins depend on interfaces, never on `dsh-agent-loop` (the loop is swappable); the sanctioned exception is the composition bundle `dsh-agent-core`, whose job is assembling the concrete spine.

依赖约束规范：各类扩展插件仅依赖抽象接口，严禁直接依赖 `dsh-agent-loop`（该主循环支持替换实现）；唯一允许的特例是组合包 `dsh-agent-core`，它的职责是组装整套实体主干。

## ② 防御模式规则

> Hard-won bug-class rules: each pattern below is a class of defect that actually shipped or nearly shipped here, stated as the rule that prevents its recurrence. Read this before writing lifecycle, concurrency, subprocess, or teardown code.

这些都是踩坑总结得出的缺陷分类规范：下文每种范式都对应一类曾上线、或险些流入线上的问题，每条规范旨在杜绝同类问题复现。编写生命周期、并发、子进程、资源销毁相关代码前，请务必阅读本文档。

## ③ 测试政策清单

> **Coverage gate** (`pnpm run test:coverage`): the gating run, per-file 100% on `packages/*/*/src`. An uncovered line is often dead code the gate is correctly flagging for deletion, not a missing test to bolt on. Line coverage is necessary, never sufficient — it proves lines ran, not that the feature works as shipped.

覆盖率门禁（`pnpm run test:coverage`）：作为合入门禁校验，要求 `packages/*/*/src` 目录下每个文件行覆盖率达到 100%。未覆盖代码行大多是无用死代码，门禁标记这类代码是提示删除，而非单纯补充测试。行覆盖率是必要条件，但远不充分：它仅能证明代码被执行过，无法保证功能符合线上预期。

## ④ 机制描述

> Blob hashes, not commit hashes, so the record is computable for files edited in the same PR (`git hash-object foo.md`) and consistency is a pure content comparison. The recorded hash also recovers the exact last-confirmed text of either side (`git cat-file -p <hash>`), so an out-of-sync pair is updated by diffing the edited side against its last-confirmed state and patching the counterpart minimally — never by re-translating whole files.

系统采用文件 blob 哈希而非提交哈希记录状态。同一 PR 内修改文件时，可通过 `git hash-object foo.md` 直接算出对应哈希，仅对比文件内容即可判断双语文档是否同步。通过记录的哈希值，可使用 `git cat-file -p <hash>` 还原上次确认对齐时两侧的原文。当双语文档不一致时，只需对比修改版本与上次确认版本的差异，最小幅度同步修改另一侧译文，无需全文重新翻译。

## ⑤ 政策声明

> The gate's limit, stated plainly: a green gate means the pair was confirmed consistent at these exact contents, not that the confirmation was sound. It checks hashes and shape; it cannot judge whether the two sides actually say the same thing — that is the reviewer's half of the contract. A re-recorded pair with a sloppy counterpart passes the gate; it must not pass review.

明确门禁校验边界：门禁校验通过，仅代表两份文档哈希与结构完全匹配，不代表译文内容准确无误。门禁仅校验哈希与结构，无法判断双语表意是否统一——译文质量把关是评审人的责任。即便译文粗糙、表意偏差，只要哈希匹配，门禁就会放行，但这类 PR 绝不能通过人工评审。

## ⑥ RFC 论证

> Comparing git timestamps of the pair (no record) — rejected: formatting-only edits would false-positive, and a counterpart committed after an unrelated edit would false-negative; content identity is the only signal that means what the gate claims.

对比双语文件的 git 时间戳（无哈希记录方案）——不予采纳：仅调整格式的改动会触发误报，无关修改后再提交译文又会造成漏检。只有文件内容完全一致，才能作为门禁可信的校验依据。

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
