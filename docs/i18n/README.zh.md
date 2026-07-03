<!-- i18n-source: docs/i18n/README.md@e70a1fed0d0e -->

# 双语文档

[English](README.md) | 中文

本仓库的文档会被公司内外的人和 agent（智能体）阅读，因此 README 与 docs 目录树以英文和简体中文双语维护。本页定义配对契约、强制门禁与推进策略；[translation-rules.md](translation-rules.md) 定义如何翻译；[terminology.md](terminology.md) 是术语真源。进仓的 agent 工作流见 [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md)。

## 配对契约

- **英文是唯一真源。**每篇文档都以英文在其现有路径撰写，中文文件由它派生——翻译只沿 EN → ZH 单向流动。内容变更始于英文文件；中文文件永远不携带英文源没有的信息。
- **配对的同目录文件。**`foo.md` 的译文是同目录下的 `foo.zh.md`。不用语言目录，不用独立翻译仓库，不用中英混排的单文件。
- **源指纹。**每个 `.zh.md` 文件的第一行是一条 HTML 注释，记录它翻译所依据的英文源的仓库相对路径和 git blob hash（`git hash-object` 的前 12 位十六进制）：

  ```markdown
  <!-- i18n-source: docs/architecture.md@8a9f0c21d3e4 -->
  ```

  用 blob hash 而不是 commit hash，这样同一个 PR 里改动的英文文件也能算出指纹（`git hash-object docs/foo.md`），过期检测则是纯内容比较。指纹同时也是更新工具：`git cat-file -p <hash>` 能还原过期译文当初依据的确切源文本，`git diff <hash> <当前 blob>` 能隔离出变化的部分，让译文做最小更新而不是整篇重译。
- **语言切换行。**两个文件在各自 H1 标题之后立即互链：英文文件带 `English | [中文](foo.zh.md)`，中文文件带 `[English](foo.md) | 中文`。
- **结构与源一一对应。**标题层级、列表形态、表格列与代码块和英文文件一一对应——完整保持规则见 [translation-rules.md](translation-rules.md)。既有 Markdown 门禁对 `.zh.md` 文件原样生效（`verify-md-wrap`、`verify-md-links`）。

## 门禁：verify-translation-pairing

`pnpm run verify-translation-pairing`（`doc-sync` 的一环，因此 CI 和 pre-push 钩子都会运行）机械地强制这份契约：

1. [scripts/translation-pairing.manifest.json](../../scripts/translation-pairing.manifest.json) 中 `required` 列出的每个英文文件都有 `.zh.md` 配对文件。
2. 每个已存在的 `.zh.md` 文件——无论是否 required——都通过全部检查：其英文源存在（无孤儿）、指纹等于源的当前 blob hash（无过期译文）、双方都带语言切换行、其代码块与标题数量等于源文件。
3. 列为 `excluded` 的文件完全没有 `.zh.md` 配对。

`pnpm run verify-translation-pairing --list` 打印范围内每篇文档的当前翻译状态——missing、stale 或 ok——是翻译批次的工作清单。它从不失败；它只报告。

这个门禁带来的实际规则是：**当一个 PR 修改了已有 `.zh.md` 配对的英文文档时，同一个 PR 更新译文**（运行 [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) skill），与本仓库既有的代码/README doc-sync 规则完全一致。留下过期译文的 PR 会在 CI 变红。

## 范围、排除与推进

**范围**：根 `README.md` 与 `docs/**` 下的全部内容。package README（`packages/**`）在后续批次加入范围。

**排除**（永不配对，门禁拒绝为它们建 `.zh.md`）：

- `docs/cordis-catalog/`、`docs/tool-catalog/`、`docs/module-graph.md` —— 生成文件；生成器只输出英文，译文在每次重新生成时必然过期。
- `docs/AGENTS.md` —— agent 指令，与根 `AGENTS.md` 一样只以英文维护。
- `docs/i18n/terminology.md` —— 术语表本身即是双语构造。

**推进**：manifest 中的 `required` 列表是强制边界，不是目标。目标是范围内的全量双语覆盖。翻译按可评审的批次落地（核心入口文档、cookbook、RFC、postmortem……）；每个批次合入后把其文件加进 `required`，门禁只进不退。尚未进入 `required` 的文档是 backlog——在 `--list` 中可见——但任何已存在的译文无论在不在清单里都按完整契约检查。

## 分工

这里的译文由运行 [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) 的 agent 产出、由人评审——在这里推理（inference）很便宜，评审注意力才是稀缺资源。门禁的存在让 agent 和评审者都不必记住契约：配对、新鲜度和结构由机械检查兜底，评审注意力投向翻译质量与术语——这正是人的判断的用武之地。
