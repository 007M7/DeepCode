# RFC

[English](README.md) | 中文

这里存放一类设计文档。**RFC** 记录塑造本代码库的决策或提案——代码和文档本身无法承载的*为什么*以及*放弃了什么*。完整列表见生成的 [INDEX.md](INDEX.md)；本文是契约——RFC 放在哪里、何时该写，以及[文件内格式](#the-file-format)。

## 布局与命名

每篇 RFC 有两个轴，都编码在其**路径**中——`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`：

- **生命周期**（顶层文件夹）是 RFC 的状态，RFC 随状态变更在文件夹间移动：
  - **`proposed/`**——实现前评审的提案；尚未构建（或仅部分构建）。
  - **`implemented/`**——决策已交付。文件记录做了什么决定、否决了什么，并**与实际交付的内容保持同步**：当代码后来移动了文件、重命名了包（package）或更改了键/默认值时，RFC 在同一个变更中更新以匹配（仅限事实——路径、名称、结构——不涉及决策本身）。见 [implemented/AGENTS.md](implemented/AGENTS.md)。
  - **`rejected/`**——提案经考虑后被否决。保留以备查阅，避免同一问题被反复争论。
- **分类**（嵌套文件夹）是决策的*类型*——见下方[分类](#classification)。

文件名中的日期是该主题**首次提出**的时间（以 git 历史为准）。RFC 之间的交叉引用使用相对 Markdown 链接（`[topic](../../implemented/architecture/2026-…-….md)`），从不使用纯文字或编号，这样既可机械检查，也能在文件夹间移动时保持有效。

## 分类

每篇 RFC 归属于 `scripts/rfc-index.ts` 中封闭集合里的一个路径编码分类；分类门禁拒绝其他文件夹。[INDEX.md](INDEX.md) 由路径、标题和文件名日期生成，其新鲜度受门禁保护。新增分类需要同时更新规范集合与本节。见[分类 RFC](implemented/process/2026-06-20-rfc-classification.md) 与[索引生成 RFC](implemented/process/2026-07-04-generate-rfc-index-tables.md)。

| 分类 | 涵盖内容 |
|---|---|
| `feature` | 面向用户或模型的新能力。 |
| `bug-fix` | 修正缺陷或填补事后复盘暴露的空白。 |
| `simplification` | 在不增加能力的前提下移除代码、行为或接口面。 |
| `architecture` | 关于**交付源码**的结构性决策——包之间的关系、运行时词汇。 |
| `process` | 围绕代码的工具、政策或工作流——门禁、包管理器、vendor 化——而非运行时行为。 |
| `testing` | 测试基础设施与策略。 |

`architecture` 与 `process` 的分界线：**architecture** 关乎我们交付的源码；**process** 关乎围绕源码的工具与工作流。（`refactor` 被刻意省略——它与 `simplification` 重叠，后者的判别标准「可观测行为是否改变」已覆盖了它。）

## 何时该写

当一个决策**持久**（它塑造代码库的范围超出单个函数或包）、**有争议**（存在一个合理工程师可能选择的真实替代方案）、且**令人意外**（未来读者否则会问「为什么要这样做」）时，请写一篇 RFC。对未来大量工作的提案从 `proposed/` 开始；已做出的决策从 `implemented/` 开始。选择与决策匹配的分类文件夹（见[分类](#classification)）。

以下情况**不要**写 RFC：机械性或局部的选择（变量名、单文件重构）；已由门禁或 AGENTS.md 中的约定强制并解释的事项；代码中标记为 `TODO(...)` 的暂定决策——将其记为 TODO，待尘埃落定后再提升为 RFC。RFC 永远不会被编辑成*另一个决策*：用新 RFC 取代旧的并互相链接。（编辑 `implemented/` RFC 以跟踪其已做出的决策现在*位于何处*——移动的文件、重命名的包——不是另一个决策，是必须做的，而非禁止的；见 [implemented/AGENTS.md](implemented/AGENTS.md)。）

## 文件格式

每篇 RFC 遵循统一的文件内格式，由 `pnpm run verify-rfc-format`（[scripts/verify-rfc-format.ts](../../scripts/verify-rfc-format.ts)，doc-sync（文档同步门禁）的一环）强制执行；该格式的设计动机及其否决的替代方案见[统一格式 RFC](implemented/process/2026-07-05-uniform-rfc-format.md)。

### 头部块

每篇 RFC 的前三行严格为：

```markdown
# RFC: <title>

Status: <status>
```

后接一个空行。`Status:` 的值有三种形式，且必须与文件所在的生命周期文件夹一致——门禁会交叉检查：

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <why, in one line>`

状态行不带日期、不带括号补充说明：文件名承载首次提出日期，git 承载其余一切，「以修订形式接受」之类的说明属于正文内容（在陈述决策的地方说明修订）。否决原因是唯一带内容的状态行，因为读者查阅被否决 RFC 时要的就是结论。

### 正文骨架

每篇 RFC 的正文以 `## Problem` 开头——动机，写法应独立于解决方案。后续内容取决于生命周期；重复出现的章节使用以下规范名称且仅限这些名称，而真正特有的技术章节（包拓扑、协议格式（wire format）、schema）在必需章节之间自由编排。

#### `proposed/`

```markdown
## Problem
## Proposal
…bespoke sections…
## Alternatives considered
## Acceptance criteria
## Risks
```

`## Proposal` 是拟议的变更，可以正当地使用将来时——计划、迁移步骤和未决问题在工作尚未构建时属于此处。`## Acceptance criteria` 说明什么可观测状态意味着完成。`## Risks` 涵盖可能出错的事项以及变更有意放弃的东西。

#### `implemented/`

```markdown
## Problem
## Decision
…bespoke sections…
## Alternatives considered
## Consequences
```

`## Decision` 以现在时描述已交付的现实，整个文件按 [implemented/AGENTS.md](implemented/AGENTS.md) 的要求与之保持同步。`## Consequences` 记录权衡的代价**与**收益。提案阶段的标题在这里属于规格用语，门禁会拒绝：`## Proposal`、`## Plan`、`## Migration plan` 和 `## Acceptance criteria` 不得出现在 implemented RFC 中（[slop 检查清单](../AGENTS.md)说明了原因）。`## Testing`、`## Deferred` 或 `## Related` 章节在陈述现在时事实时是允许的。

#### `rejected/`

被否决的 RFC 是冻结的提案：保留其提案时的所有章节（包括 `## Acceptance criteria` 或 `## Plan`），结论写在 `Status:` 行。仅头部块、`## Problem` 开头、`## Proposal` 章节，以及下方的「曾考虑的替代方案」强制要求适用。

### 曾考虑的替代方案——强制要求

每篇 RFC 都必须有一个 `## Alternatives considered` 章节：每个真实的替代方案及其落选原因，每个替代方案一段（加粗引导），或对争议较大的方案使用 `### Why not <X>?` 子章节。记录决策却不记录它击败了什么，就是在邀请反复争论——正是 RFC 存在的目的所要防止的。

替代方案是记录下来的，而非凭空编造的。日期早于 2026-07-05 的 RFC，如果其替代方案无法从记录中重建，则在该章节位置放置以下精确注释，门禁仅对格式前文件接受此注释：

```markdown
<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
```

### 在生命周期间移动

将文件在生命周期文件夹间移动意味着在同一个变更中更新 `Status:` 行并满足目标文件夹的骨架要求——否则门禁会失败。具体而言，`proposed/` → `implemented/` 将 `## Proposal` 改写为现在时的 `## Decision`，将 `## Acceptance criteria` 和 `## Risks` 折叠进 `## Consequences`（或一个现在时的 `## Testing`/`## Verification` 章节，用于说明现在什么在固定该行为），并用实际交付的内容替换计划——即 [implemented/AGENTS.md](implemented/AGENTS.md) 要求的改写，使之机械化。`proposed/` → `rejected/` 仅在 `Status:` 行添加原因并冻结文件。

### 中文对侧文件

`.zh.md` 对侧文件按 [i18n 契约](../i18n/README.md)逐章节镜像其英文兄弟文件的结构；机器检查的头部标记（`# RFC: ` 和 `Status:` 行）保持英文原样不变。格式门禁跳过 `.zh.md` 文件——配对门禁负责它们的一致性。
