# RFC：文档分层、预算与上限门禁

Status: implemented

[English](2026-07-04-doc-tiers-and-budgets.md) | 中文

## 问题

尽管已有写作指导，常设文档仍然积累了重复的规则、重述的事件、重复的 package 地图和陈旧的 RFC 摘要。由于仅靠评审无法阻止这种膨胀，仓库需要在文档分类体系之外再加一道机械化的预算。

## 决策

- **分层分类体系，每条事实只有一个归属。** [docs/AGENTS.md](../../../AGENTS.md) 是文档标准：它为每个 Markdown 层级指定唯一职责（常设指令、系统地图、类型目录、决策记录、事件故事、实操手册（cookbook）、package 契约、生成目录、工作流），禁止在归属层级之外重述事实（应改为链接），并附带一份在撰写或评审任何文档时使用的冗余检查清单。
- **窄范围、硬约束的预算门禁。** [scripts/verify-doc-budgets.ts](../../../../scripts/verify-doc-budgets.ts) 加入 doc-sync：凡列入 [scripts/doc-budgets.manifest.json](../../../../scripts/doc-budgets.manifest.json) 的文档都必须低于其字数上限（`wc -w` 语义，整个文件），且已设预算的文件若缺失也会使门禁失败，防止重命名时预算被静默遗留。范围有意仅限于容易膨胀的常设文档：根目录与子树的 `AGENTS.md`、`architecture.md`、`packages/README.md`，以及它们将内容分流到的常设策略文档（`docs/testing.md`、`docs/defensive-patterns.md`）。参考文档、RFC 和 package README 不设预算：当每一行都是事实时，长度是合理的，由评审加冗余检查清单管控。
- **上限是只进不退的执行红线。** 上限设定在文档当前大小的至少 5% 以上（留出操作余量，使日常措辞修改不会触发门禁，而真正的膨胀仍会被拦截），并随着文档被压缩到目标预算（根 `AGENTS.md` ≤ 1,500 词；`architecture.md` ≤ 1,800；子树 `AGENTS.md` ≤ 600；`packages/README.md` ≤ 600）而保持该余量向下收紧——与[翻译配对 `required` 清单](2026-07-02-bilingual-docs-and-pairing-gate.md)的推进机制相同。门禁变红时，修复方式是按分类体系迁移或精简内容；只有在 PR 描述中给出明确理由时才允许提高上限，manifest diff 本身即为可评审的动作。
- **轻量工作流 skill，契约在文档中。** [.agents/skills/dsh-doc-standards](../../../../.agents/skills/dsh-doc-standards/SKILL.md) 承载归位/审计/红灯修复工作流，并将文档标准作为真源——与 [dsh-translate-docs](../../../../.agents/skills/dsh-translate-docs/SKILL.md) 对 i18n 契约的分工方式相同。

## 曾考虑的替代方案

- **仅靠 skill 与评审纪律，不设门禁**：否决。上述膨胀正是在既有的现状规则和评审者注意力下发生的；一条没有机械后盾的行文规则在这里已被证明守不住，而本仓库自身的[质量门禁立场](2026-06-11-quality-gates.md)说的是：值得保持的不变式就值得编码。
- **对所有文档层级设置宽泛门禁**：否决。一刀切的上限恰恰惩罚了那些正当的长文档（如功能矩阵或类型目录，每一行都是事实，例如 `packages/ui/acp/acp-feature-support.md`），并产生逐文件的例外修改，训练贡献者无脑批准上调。
- **将标准放在 skill 内部**：否决。契约放在文档中，工作流放在 skill 中；如果标准被塞进 SKILL.md，那些不调用该 skill 而直接编辑文档的 agent 就看不到它，而 `docs/AGENTS.md` 已经作为子树指令被加载给所有在 `docs/` 下工作的人。

## 后果

- 向已设预算的文档添加内容现在需要置换：将新增内容迁移到其分类归属处并留下指针，或精简既有行文为其腾出空间。只增不减会导致 CI 失败。
- 将文档压缩到目标预算的重写以堆叠的后续 PR 落地，每个合并时都将 manifest 中的上限向下收紧；在各自落地之前，文档的冻结上限仅阻止进一步膨胀。
- 字数是一个粗糙的代理指标，这是有意接受的：它无法判断质量，但它恰好在内容被添加的那一刻强制触发迁移决策——而那正是作者拥有足够上下文来正确归位内容的时刻。
