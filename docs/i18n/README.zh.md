# 双语文档

[English](README.md) | 中文

本仓库的文档会被公司内外的人和 agent（智能体）阅读，因此 README 与 docs 目录树以英文和简体中文双语维护。本页定义配对契约、强制门禁与推进策略；[translation-rules.md](translation-rules.md) 定义如何翻译；[terminology.md](terminology.md) 是术语真源。进仓的 agent 工作流见 [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md)。

## 配对契约

- **两种语言同权。**一篇文档可以先用任一语言撰写和评审——先写中文的 RFC 与先写英文的一样正当——另一侧由它翻译而来。两个文件谁也不高于谁；约束它们的是二者必须说同样的话。
- **一对文档是三个同目录文件。**英文 `foo.md`、中文 `foo.zh.md`，加一份一致性记录 `foo.i18n.yaml`，都在同一目录。不用语言目录，不用独立翻译仓库，不用中英混排的单文件。配对整体合入：PR 永远不会只带一种语言而缺其余两个文件。
- **一致性记录。**`foo.i18n.yaml` 保存两侧文件在上一次被确认「说同样的话」时各自的完整 git blob hash：

  ```yaml
  foo.md: 3f786850e387550fdab836ed7e6dc881de23001b
  foo.zh.md: 89e6c98d92887913cadf06b2adb97f26cde4849b
  ```

  用 blob hash 而不是 commit hash，这样同一个 PR 里改动的文件也能算出记录（`git hash-object foo.md`），一致性是纯内容比较。记录的 hash 还能还原任一侧上次确认时的确切文本（`git cat-file -p <hash>`），所以失去同步的配对是「把被改的一侧与其上次确认状态做 diff、再最小化地修补另一侧」——从不整篇重译。两侧对齐后，`pnpm run verify-translation-pairing --write` 重新记录两个 hash；那份 yaml diff 就是「确认一致」这个动作本身，可以被评审。
- **语言切换行。**两个文件在各自 H1 标题之后立即互链：英文文件带 `English | [中文](foo.zh.md)`，中文文件带 `[English](foo.md) | 中文`。
- **结构与另一侧一一对应。**标题深度与顺序、列表类型、表格列、链接目标与逐字节一致的代码块在配对两侧一一对应——完整保持规则见 [translation-rules.md](translation-rules.md)。既有 Markdown 门禁对 `.zh.md` 文件原样生效（`verify-md-wrap`、`verify-md-links`）。

## 门禁：verify-translation-pairing

`pnpm run verify-translation-pairing`（`doc-sync` 的一环，因此 CI 和 pre-push 钩子都会运行）机械地强制执行这份契约：

1. [scripts/translation-pairing.manifest.json](../../scripts/translation-pairing.manifest.json) 中 `required` 列出的每个文件都有完整配对。
2. 任何已存在的配对——无论是否 required——都完整且一致：三个文件齐全、每一侧的当前 blob hash 等于记录值（改了任一侧而没重新确认配对就变红）、双方都带语言切换行、结构签名按序一致——标题深度、逐字节一致的代码块（信息字符串与内容）、表格列数、列表类型，以及除切换行之外的每个链接目标。
3. 列为 `excluded` 的文件完全没有 `.zh.md`，也没有 `.i18n.yaml`。

`pnpm run verify-translation-pairing --list` 打印范围内每篇文档的当前配对状态——missing、out-of-sync 或 ok——是翻译批次的工作清单。它从不失败；它只报告。

这个门禁带来的实际规则是：**当一个 PR 修改了已配对文档的任一侧时，同一个 PR 更新另一侧并重新记录配对**（运行 [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) skill（技能），再 `--write`），与本仓库既有的代码/README doc-sync 规则完全一致。留下失去同步的配对的 PR 会在 CI 变红。

把门禁的边界说白：**门禁绿意味着这对文档曾在当前内容上被确认一致，不意味着这次确认本身是对的。**它检查 hash 和形状；它无法判断两侧是否真的在说同样的话，也无法判断措辞是否准确、术语是否得当、行文是否自然——那是契约中评审者的那一半，见 [translation-rules.md](translation-rules.md)。重新记录了 hash 但另一侧翻得潦草的配对能通过门禁；它不得通过评审。

## 范围、排除与推进

**范围**：根 `README.md` 与 `docs/**` 下的全部内容。package README（`packages/**`）在后续批次加入范围。

**排除**（永不配对，门禁拒绝为它们建 `.zh.md` 或 `.i18n.yaml`）：

- `docs/cordis-catalog/`、`docs/tool-catalog/`、`docs/module-graph.md`——生成文件；生成器目前只输出英文，手写译文在每次重新生成时必然陈旧。计划中的后续工作是让生成器同时输出中文，届时这些文件移出排除清单。
- `docs/AGENTS.md`——agent 指令，与根 `AGENTS.md` 一样只以英文维护。
- `docs/i18n/terminology.md`——术语表本身即是双语构造。

**推进**：manifest 中的 `required` 列表是强制边界，不是目标。目标是范围内的全量双语覆盖。配对按可评审的批次落地（核心入口文档、cookbook、RFC、postmortem……）；每个批次合入后把其文件加进 `required`，门禁只进不退。尚未进入 `required` 的文档是 backlog——在 `--list` 中可见——但任何已存在的配对无论在不在清单里都按完整契约检查。给一篇文档配对是一份承诺：此后对任一侧的每次修改都必须带上另一侧，所以边界的扩张要跟上翻译评审的实际投入节奏，不要抢在前面。

## 分工

这里的对侧译文由运行 [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) 的 agent 产出、由人评审——在这里推理（inference）很便宜，评审注意力才是稀缺资源。门禁的存在让 agent 和评审者都不必记住契约：配对完整性、一致性和结构由机械检查兜底，评审注意力投向翻译质量与术语——这正是人的判断的用武之地。
