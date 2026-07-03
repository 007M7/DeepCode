# 翻译规则

[English](translation-rules.md) | 中文

本文规定如何在本仓库文档配对的两侧之间进行翻译。两种语言同权（见 [README.md](README.md)）：一次变更用任一语言撰写，那一侧就是这次更新的源——本文的规则约束的是产出或更新另一侧。这些规则对人和 agent（智能体）同等生效；应用它们的进仓 agent 工作流是 [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md)。规则级别沿用 RFC 2119 的用法：**必须（MUST）**／**禁止（MUST NOT）**会卡门禁或评审；**应当（SHOULD）**偏离时要说明理由；**可以（MAY）**自行裁量。

## 忠实性

- 另一侧必须说撰写侧所说的话——不添加行为、前置条件、警告、版本声明或示例，也不丢弃任何一项。如果两侧在实质内容上不一致，没有哪种语言默认获胜：改正错的那一侧，并在同一个变更里把另一侧带上。
- 另一侧应当读起来是其语言自然的技术文字，而不是逐词对照。翻译语义，在目标语言语法需要处重组句子，并保持原作者的语域——简练的保持简练。
- 不要翻译不可译的东西：一句话如果依赖源语言的习语而无法自然转换，就翻译它的意思，而不是习语本身。

## 结构保持

配对的两个文件必须在以下方面一一对应：

- 标题层级（相同级别、相同顺序——标题的**文字**要翻译），
- 列表形态与编号，
- 表格（相同的列、相同的行序；表头单元格按术语表翻译），
- 围栏代码块——**逐字节一致，包括注释**；代码属于受验证的范围（` ```ts ` 块要通过 `doc-typecheck` 编译），而被改动的注释是代码块计数门禁看不见的漂移，
- 行内代码（命令、flag、配置键、文件路径、事件名、API 名、版本号）——原样保留，从不翻译或重排，
- 链接与锚点：每个相对链接在两个文件中必须指向相同的目标——按约定是 `.md` 路径而非 `.zh.md` 兄弟文件——这样某对文档先于相邻文件落地时，链接也永不悬空。唯一的 zh 特有链接是语言切换行。链接**文字**翻译；链接目标不翻。

本仓库的 Markdown 约定对 `.zh.md` 文件原样生效：一个段落一个物理行（`verify-md-wrap`）、相对链接必须可解析（`verify-md-links`）、文件末尾恰好一个换行。

## 术语

- [terminology.md](terminology.md) 是双向的术语真源。翻译前先加载它；翻译中，表内的每个术语都必须严格按表规定的译法呈现，包括首次出现的括注（如首现写 `agent（智能体）`，之后写 `agent`）与「不要译作」的禁项。中文先行撰写时，英文另一侧同样按表中英文列使用术语。
- 表中**没有**的技术术语，只有当某个主要中文 OSS 或厂商文档已有成型译法时（K8s／Vue／MDN 中文文档、微软简中风格指南、大厂项目文档）才可以翻译。在 PR 中注明先例出处。
- **没有**成型先例的术语，译文中必须保留英文，并且必须在 PR 描述的「待定术语」下列出、附上建议译法交评审者定夺。禁止就地发明中文译法——无先例的翻译恰恰制造了术语表要防止的歧义。定下来的术语随后在同一个 PR 或后续 PR 进入 [terminology.md](terminology.md)。

## 排版

本节规则约束中文一侧；英文一侧遵循仓库常规的 Markdown 约定（根 `AGENTS.md`）。下面的中西文混排规则遵循 [MDN 简体中文翻译指南](https://github.com/mdn/translated-content/blob/main/docs/zh-cn/translation-guide.md)、[Kubernetes 中文本地化指南](https://kubernetes.io/zh-cn/docs/contribute/localization_zh/)、[Vue.js 中文翻译须知](https://github.com/vuejs-translations/docs-zh-cn/wiki/%E7%BF%BB%E8%AF%91%E9%A1%BB%E7%9F%A5)与[中文文案排版指北](https://github.com/sparanoid/chinese-copywriting-guidelines)的跨项目共识，其根据是 [W3C clreq](https://www.w3.org/TR/clreq/) 与 GB/T 15834—2011：

- 必须在中文与拉丁词之间、中文与数字之间各留一个半角空格：`每个 plugin 注册 3 个 tool`。全角标点与任何字符之间不加空格。
- 中文行文必须使用全角（中文）标点：`，。：；？！（）「」`。半角标点保留在代码内、按原样引用的完整英文句子内、以及数字内（`3.5`、`1,024`）。
- 并列顿开：中文的并列项之间用顿号（、），不用逗号。
- 禁止使用全角数字或全角拉丁字母——永远不写 `１２３`，永远写 `123`。
- 专有名词保持规范大小写：GitHub、TypeScript、DeepSeek——除非引用代码，否则绝不写 `github`／`Github`。
- 第二人称用「你」，不用「您」（与 Vue、Kubernetes 中文约定及本仓库的直接语气一致）。
- 强调标记（`**加粗**`、`*斜体*`）落在与另一侧相同的文字段上；中文没有斜体，渲染效果可能看不出差别——不要用引号或其他装饰替代。

## 质量线

- 一对文档的完成标准：一位双语工程师只读其中任一文件，得到与另一文件读者完全相同的信息——相同的事实、相同的告诫、相同的语气——并且没有任何多余的内容。
- 交付前，对照本文自查一遍，并**只读另一侧**再通读一遍、不看源侧对照；没有源文锚着，别扭的表述更容易被听出来。
- 机械契约（一致性记录、切换行、结构、折行、链接）由 `pnpm run verify-translation-pairing` 和 `doc-sync` 的其余门禁检查——跑门禁；门禁覆盖的不要手工核对。

## 参考资料

本文各规则引用的权威出处，供想了解底层依据的人和 agent 查阅：

- [中文文案排版指北](https://github.com/sparanoid/chinese-copywriting-guidelines)——中西文混排空格与标点的社区事实标准。
- [MDN 简体中文翻译指南](https://github.com/mdn/translated-content/blob/main/docs/zh-cn/translation-guide.md)——与本文同形态的进仓翻译规则文件；空格、标点与术语表实践。
- [Kubernetes 中文本地化指南](https://kubernetes.io/zh-cn/docs/contribute/localization_zh/)——最大的中文本地化团队的术语首现与标点实践。
- [Vue.js docs-zh-cn 翻译须知](https://github.com/vuejs-translations/docs-zh-cn/wiki/%E7%BF%BB%E8%AF%91%E9%A1%BB%E7%9F%A5)——逐术语的译／留决策与语气。
- [zh-style-guide](https://zh-style-guide.readthedocs.io)——社区中文技术文档写作规范，本文借用了它的规则级别分类体系（与 RFC 2119 关键词分级）；它聚合了 GB/T 15834/15835、clreq 与各厂商指南。
- [W3C clreq](https://www.w3.org/TR/clreq/) 与[微软简体中文风格指南](https://learn.microsoft.com/en-us/globalization/reference/microsoft-style-guides)——排版学与厂商本地化的正式基线。
- GB/T 19682-2005《翻译服务译文质量要求》——国家标准；本文「忠实性」与「术语」两节把它的三项基本要求（忠实原文、术语统一、行文通顺）落成可操作规则。
