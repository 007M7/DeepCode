# RFC：Markdown 交叉链接有效性 lint

Status: implemented

[English](2026-06-18-markdown-cross-link-lint.md) | 中文

## 问题

本仓库的文档通过相对路径互相链接：`[topic](../implemented/2026-…-….md)`、`[the cookbook](adding-a-tool.md)`、`[architecture.md](../../architecture.md)`。此前没有任何机制验证这些目标是否存在。一次重命名或移动会悄无声息地打断所有入站链接，直到读者点击时才会发现。[Doc-sync 强制](2026-06-11-doc-sync-enforcement.md)已经将两类文档漂移机械化了（不可编译的代码块、陈旧的事件分类体系表），[verify-md-wrap](2026-06-11-doc-sync-enforcement.md) 处理了第三类（硬换行的行文段落），但死链接是第四类同样可机械检查的问题，此前仍靠肉眼验证。

直接触发本门禁的案例是引入它的那次 RFC 目录重组：将 `docs/adr/` + `docs/rfc/` 统一为一个 `docs/rfc/`，下设 `proposed/`、`implemented/`、`rejected/` 子目录，手动改写了约四十条文档间链接。任何一条路径的手误都会让断链随代码一起合入，而没有任何东西能拦住它。

## 决策

新增第四道 `doc-sync` 门禁 `verify-md-links`（`scripts/verify-md-links.ts`），风格与 `verify-md-wrap` 一致（tsx ESM、基于 AST、只验证不生成）：

- 用 `mdast-util-from-markdown` + GFM 解析范围内的每个 Markdown 文件，遍历所有 `link`、`image` 和 `definition` 节点。
- 仅当目标是**相对路径**时才检查。跳过带协议的 URL（`https:`、`mailto:` 等）、协议相对路径（`//host`）、根绝对路径（`/path`——在 checkout 中没有稳定基准）以及纯页内锚点（`#section`）。去除 `#fragment`/`?query`，相对于链接所在文件的目录解析路径，并断言该路径在磁盘上存在。
- 只报告，不改写；发现第一条断链即以非零状态退出。

范围与其他门禁一致，另加 AGENTS.md 对和 `.agents/skills/` 下仓库自有的 agent skill Markdown（这些 skill 文件交叉链接到 docs 目录树，因此本次重组也改写了其中的链接）：`README.md`、`docs/**/*.md`、`packages/*/README.md`、`AGENTS.md`、`packages/AGENTS.md`、`.agents/skills/**/*.md`，按真实路径去重（`CLAUDE.md` 符号链接解析到 AGENTS.md 文件）。该门禁接入 lefthook pre-push 钩子和 CI 都会运行的 `doc-sync` 脚本，因此断链在推送前就会在本地失败——与[机械质量门禁](2026-06-11-quality-gates.md)保持一致。

本门禁检查的是**文件存在性**，而非锚点有效性：链接到一个真实文件但带有 `#wrong-heading` 片段的仍然通过（文件可解析；片段被剥离）。

## 曾考虑的替代方案

**锚点级有效性检查**：更重且价值更低；实际造成问题的是文件级死链接。这一范围裁剪是有意为之：作者在链接到某个锚点时自行验证 `#fragment`。

## 后果

- 重命名或移动导致交叉链接悬空时，pre-push 钩子和 CI 会立即失败，而不是等读者点击死链接才发现。这使得引入本门禁的 RFC 重组具有自验证性：同一个 PR 既改写了四十条链接，也加入了证明无一悬空的检查。
- `doc-sync` 链中多了一个快速 tsx 脚本；无新增依赖（mdast/GFM 技术栈已在 devDependencies 中供 `verify-md-wrap` 使用）。
- 本门禁强制的约定——通过可机械检查的相对链接交叉引用文档，而非裸文字或编号——记录在 [docs/AGENTS.md](../../../AGENTS.md) 中，让作者知道这道门禁的存在及其原因。
