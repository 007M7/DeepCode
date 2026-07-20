# 双语文档

[English](README.md) | 中文

本仓库的文档会被公司内外的人和 agent（智能体）阅读，因此 README、Agent Note 与 docs 目录树以英文和简体中文双语维护。本页定义配对契约、强制门禁与推进策略；[translation-rules.md](translation-rules.md) 定义如何翻译；[terminology.md](terminology.md) 是术语真源。仓库内置的 agent 工作流见 [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md)。

## 配对契约

- **两种语言同权。**一篇文档可以先用任一语言撰写和评审——先写中文的 Agent Note 与先写英文的一样正当——另一侧由它翻译而来。两个文件谁也不高于谁；约束它们的是二者必须说同样的话。
- **一对文档是三个同目录文件。**英文 `foo.md`、中文 `foo.zh.md`，加一份一致性记录 `foo.i18n.yaml`，都在同一目录。不用语言目录，不用独立翻译仓库，不用中英混排的单文件。配对整体合入：PR（Pull Request）永远不会只带一种语言而缺其余两个文件。
- **一致性记录。**`foo.i18n.yaml` 保存两侧文件在上一次被确认「说同样的话」时各自的完整 git blob hash：

  ```yaml
  foo.md: 3f786850e387550fdab836ed7e6dc881de23001b
  foo.zh.md: 89e6c98d92887913cadf06b2adb97f26cde4849b
  ```

  用 blob hash 而不是 commit hash，这样同一个 PR 里改动的文件也能算出记录（`git hash-object foo.md`），一致性是纯内容比较。记录的 hash 还能还原任一侧上次确认时的确切文本（`git cat-file -p <hash>`），所以失去同步的配对是「把被改的一侧与其上次确认状态做 diff、再最小化地修补另一侧」——从不整篇重译。两侧对齐后，`pnpm run verify-translation-pairing --write` 重新记录两个 hash；那份 yaml diff 就是「确认一致」这个动作本身，可以被评审。
- **语言切换行。**两个文件在各自 H1 标题之后立即互链：英文文件带 `English | [中文](foo.zh.md)`，中文文件带 `[English](foo.md) | 中文`。
- **结构与另一侧一一对应。**标题深度与顺序、列表类型、有序列表起始编号、列表项数量、表格行列数、链接目标与逐字节一致的代码块在配对两侧一一对应——完整保持规则见 [translation-rules.md](translation-rules.md)。既有 Markdown 门禁对 `.zh.md` 文件原样生效（`verify-md-wrap`、`verify-md-links`）。

## 门禁：verify-translation-pairing

`pnpm run verify-translation-pairing`（`doc-sync`（文档同步门禁）的一环，因此 CI 和 pre-push 钩子都会运行）机械地强制执行这份契约：

1. [scripts/translation-pairing.manifest.json](../../scripts/translation-pairing.manifest.json) 中 `required` 列出的每个文件都有完整配对。
2. 任何已存在的配对——无论是否 required——都完整且一致：三个文件齐全、每一侧的当前 blob hash 等于记录值（改了任一侧而没重新确认配对就变红）、双方都带语言切换行、结构签名按序一致——标题深度、逐字节一致的代码块（信息字符串与内容）、表格行列数、列表类型、有序列表起始编号、列表项数量，以及除切换行之外的每个链接目标。
3. 列为 `excluded` 的文件完全没有 `.zh.md`，也没有 `.i18n.yaml`。
4. 凡文件名符合 `yyyy-mm-dd-*.md` 且日期不早于 manifest（元数据清单）中 `requiredSince` 分界日期的文档，都必须有完整配对——新建的日期命名 Agent Note 从创建起便须配齐中英文。

`pnpm run verify-translation-pairing --list` 打印范围内每篇文档的当前配对状态——missing、out-of-sync 或 ok——是翻译批次的工作清单。它从不失败；它只报告。

这个门禁带来的实际规则是：**当一个 PR 修改了已配对文档的任一侧时，同一个 PR 更新另一侧并重新记录配对**（运行 [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) skill（技能），再 `--write`），与本仓库既有的代码/README doc-sync 规则完全一致。留下失去同步的配对的 PR 会在 CI 变红。

把门禁的边界说白：**门禁绿意味着这对文档曾在当前内容上被确认一致，不意味着这次确认本身是对的。**它检查 hash 和形状；它无法判断两侧是否真的在说同样的话，也无法判断措辞是否准确、术语是否得当、行文是否自然——那是契约中评审者的那一半，见 [translation-rules.md](translation-rules.md)。重新记录了 hash 但另一侧翻得潦草的配对能通过门禁；它不得通过评审。

## 范围、排除与推进

**范围**：根 `README.md`，以及 `.agents/notes/**`、`docs/**` 与 `python/**` 下的全部内容。package README（`packages/**`）在后续批次加入范围。

**排除**（永不配对，门禁拒绝为它们建 `.zh.md` 或 `.i18n.yaml`）：

- `docs/cordis-catalog/`、`docs/tool-catalog/`、`docs/config-catalog.md`、`docs/persistence-catalog.md` 与 `docs/module-graph.md`——生成文件；生成器目前只输出英文，手写译文在每次重新生成时必然陈旧。计划中的后续工作是让生成器同时输出中文，届时这些文件移出排除清单。
- `docs/AGENTS.md` 与 `.agents/notes/**/AGENTS.md`——agent 指令，与根 `AGENTS.md` 一样只以英文维护。
- `docs/i18n/terminology.md` 与 [style-samples.md](style-samples.md)——二者本身即为中英对照文档。
- [translation-prompt.md](translation-prompt.md)——自动翻译流水线的 prompt 模板；正文逐字进入模型请求，配对翻译会改变流水线行为。

**推进**：以日期命名的文档（`yyyy-mm-dd-*.md`，即 Agent Note），只要标注日期等于或晚于 manifest 的 `requiredSince` 分界日期，合入时就必须配齐双语文件。更早日期的文件属于 backlog（待翻清单），包括分界前夜创建的文件。Agent Note 文件名记录首次提出日期，因此倒填日期绕过分界属于评审可见的违规。manifest 中的 `required` 列表是当前执行红线，并非全量覆盖这一最终目标。翻译批次将路径加入 `required`，使门禁只向前收紧。未列入的文档仍可通过 `--list` 查看，而任何已存在的配对都受完整契约约束。后续修改必须同步更新两侧，因此 `required` 的扩展速度不能超过翻译评审的承载能力。

## 分工

对侧译文由运行 [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) 的 agent 生成，再由人评审：在这里推理（inference）很便宜，评审注意力才是稀缺资源。门禁负责检查配对是否完整、记录的 hash、语言切换行以及本文列出的结构签名；翻译质量、术语和签名未涵盖的结构要求仍由评审把关。prompt 契约也有可执行实现：[scripts/translation-prompt.ts](../../scripts/translation-prompt.ts) 会把权威规则渲染到英译中或中译英的 prompt 中，并严格解析包含三个字段的 XML 响应；`doc-sync` 中的 `verify-translation-prompt` 会检查两个渲染方向、仓库内示例与 CDATA 拆分规则。
