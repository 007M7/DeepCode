# web-components vendoring 调研（供圈选）

> 上游：deepsuite-frontend（本机只读，gitlab 私仓）。调研基准 commit：**`d1405c2149fd5ea1058e28ffacbb50911c15a256`**（2026-07-17）。行数均不含 `__tests__`。
> ⚠️ 本文件属 missions 工作记录，可出现上游名称；**入库代码/commit message 一律只写「vendored from a pinned upstream commit \<hash\>」**。

## 一、上游盘点

### 1.1 组织方式

- **monorepo 构型**：Rush 5.175.1 + pnpm；`packages/*` 约 60 个基础包，`apps/chat` 是聊天前端主应用。组件分三层：
  - `packages/ui`（`@deepseek/ui`）：通用组件库约 50 个组件（button/modal/toast/virtualList/scrollArea…），一目录一组件；
  - `packages/md`（`@deepseek/md`）：Markdown 渲染整包；
  - `apps/chat/src/components/*`：业务组件（气泡、输入框、消息列表包装等），直接依赖前两者。
- **构建**：包一律 `tsc` 出 `es/`（ESM，`main: es/index.js`）+ `postcss`（仅 autoprefixer + postcss-nested）把 `src/**/*.css` 拷到 `es/`；应用用 rspack 打包。**没有 CSS Modules**——组件样式是全局 class（`.ds-button`、`.ds-markdown`），靠前缀纪律隔离。
- **依赖栈**：React 18.2（与我们一致）、TS 6.0.3；状态库 zustand（仅 app 层，ui/md 包不碰）；浮层用 `@floating-ui/dom`（自封 floating 层）；工具 lodash-es、clsx、dayjs。
- **主题**：`packages/theme` 全局 CSS 定义 token（`--dsw-alias-*` 语义色、`--dsw-font-*` 字体组、`--ds-*` 基础量），组件 CSS 直接 `var(--dsw-…)` 引用。**与我们 web-ui 的 `--bg-base/--accent/--border-l1` 体系完全是两套命名**。

### 1.2 点名组件 A：Markdown 渲染（packages/md）

**总量：src TS/TSX ≈ 8,664 行 + CSS ≈ 989 行**。其中 `highlight/` 4,146 行（3,062 行是 297 种 Prism 语言的动态 import 注册表，纯机械代码），核心渲染逻辑约 4,500 行。

| 维度 | 结论 |
|---|---|
| 架构 | 两段式：`useMarkdownAst(markdown, loading)` → mdast AST（micromark/mdast 手拼管线，**非 react-markdown**）；`<MarkdownAstRenderer ast>` 经 rehype-react 渲染。AST 层带**流式缓存**（`cacheKey` + 保留 `children.slice(0,-2)` 复用、代码块增量 extend），配套 `useThrottleMarkdownRender`（按渲染耗时动态节流）与 `textPrediction`（流式尾部预测 strong/em/inlineCode 未闭合标记）——流式支持是一等公民，正是我们要的 |
| 代码高亮 | Prism（`prismjs` + 297 个语言异步 loader + 常用语言预载）；高亮在 AST 渲染层做 |
| 公式 | 双引擎：katex 0.16.22（首选 HTML 渲染）+ `@deepseek/latex-wasm`（**gitlab 私仓 git 依赖**，MicroTeX wasm 出 SVG，katex 失败时兜底）。`math/` 仅 396 行，两引擎都是懒加载 |
| GFM | `micromark-extension-gfm` + `mdast-util-gfm`（表格/删除线/任务列表/自动链接） |
| 外部 npm 依赖 | unified/rehype-parse/rehype-react、mdast-util-from-markdown、micromark-extension-gfm、mdast-util-gfm、mdast-util-math、**micromark-extension-llm-math**（第三方包，上游对其打了 2 个 pnpm patch：崩溃修复 + 单行公式懒惰延续）、prismjs、katex、clsx、lodash-es |
| 上游内部依赖（要剥/替） | ① `@deepseek/latex-wasm`（git+ssh 私仓）→ **建议整体剥除，仅留 katex**（`latexWasm.ts` 本身就是懒加载可选路径，摘除面很小）；② `@deepseek/md-shared`（54 行常用语言清单）→ 直接并入；③ `@deepseek/hooks` 只用 `useEventCallback`（16 行）→ 内联；④ `@deepseek/utils` 只用 `copyToClipboard` → 内联或接我们的实现；⑤ `@deepseek/ui` 只有 `renderers/cite.tsx` 引 `AutoLayoutCite`（引用气泡定位）→ cite/深搜引用是 chat 业务功能，**建议整个 cite 渲染器剥除**，连带 `utils/` 里 restoreCiteMarkdown 等约几百行可删 |
| 样式适配 | 全局 class `.ds-markdown*`（约 990 行 CSS，postcss-nested 语法只出现 2 处，易改平）；颜色/字体全走 `var(--dsw-alias-markdown-*, --dsw-font-markdown-*, --ds-*)` 约 30 个 token。适配即做一层 **token 映射表**（`--dsw-alias-label-primary` → 我们的 `--text-primary` 之类）或在 web-components 里保留 dsw 名字、由 web-ui 的 theme 文件赋值。全局 class 与 CSS Modules 不冲突（外来包豁免 CSS Modules 即可） |
| 干净度 | src 内 **零 i18n、零埋点、零硬编码业务 URL**（grep 过），testData.ts 里有外网示例图链接（测试数据，可删）。剥离面主要就是 cite 和 latex-wasm |

一行卡片：`packages/md` ｜ ~8.7k 行 TS（其中 3.4k 机械 loader）+ 1k CSS ｜ npm 依赖 remark 生态 8 个 + prismjs + katex ｜ 内部依赖 5 个（2 个内联、2 个剥除、1 个并入）｜ 样式=token 映射，成本低-中。

### 1.3 点名组件 B：无限滚动列表（packages/ui/src/virtualList）

**总量 ≈ 2,312 行（TS/TSX/CSS，含 finweckTree/scroll/touch/keyboard 拆件）**。

| 维度 | 结论 |
|---|---|
| 方案 | **完全自研虚拟化**（不是 react-virtuoso/react-window 包壳）：FinweckTree（树状数组）做变高行高前缀和，ResizeObserver 测高，滚动锚定（`useAnchorRef`）、iOS 触摸补偿（229 行）、键盘导航、renderThrashing 异常上报钩子。源起 naive-ui 风格（`--dsl-*` 变量、beforeNextFrameOnce）但已深度改造 |
| 上游用法 | chat 的 `SessionMessageList`（1.3k 行包装：滚动上下文、scrollToBottom 容器）、会话搜索结果列表、ScrollNav 均基于它；「无限滚动」= VirtualList + 业务层 onScroll 加载更多，**上游没有独立 InfiniteScroll 组件** |
| 外部 npm 依赖 | 仅 clsx（React/react-dom 之外）——非常干净 |
| 上游内部依赖（要剥/替） | ① `../resizeObserver`（294 行，其中 AutoLayoutCite 116 行不需要；依赖 `@juggle/resize-observer` polyfill——现代浏览器可直接去掉 polyfill 用原生）；② `@deepseek/hooks` 6 个小 hook 共 171 行 → 一起搬；③ `@deepseek/env` 只用 `isIOs` 一行判断 → 内联 |
| 样式适配 | 自带 VirtualList.css 很小，变量是组件私有 `--dsl-*` 运行时变量（transform 值），不吃主题 token——**几乎零适配成本** |
| 干净度 | 零 i18n/埋点/URL；自带 TODO.md（上游已知问题清单，建议一并保留进 vendored 目录当参考） |

一行卡片：`packages/ui/src/virtualList` ｜ ~2.3k 行 + resizeObserver 0.3k + hooks 0.2k ≈ 2.8k 行 ｜ npm 依赖仅 clsx（+可选 @juggle/resize-observer）｜ 内部依赖 3 处全可内联 ｜ 样式零成本。

## 二、候选清单扩展（未来大概率要抄的高封装组件）

> 行数不含测试。「适配」= 与我们 CSS Modules + token 体系的对接成本（低=改个 token 映射；中=要剥内部依赖；高=业务耦合深）。

### packages/ui（通用组件，全是全局 class + `--dsw-*` token，React 之外基本只依赖 clsx/floating-ui）

| 组件 | 行数 | 说明 | 适配 |
|---|---|---|---|
| `scrollArea` | 1,111 | 自绘滚动条容器（chat 全站在用） | 低 |
| `modal` + `dialog` + `modalContent` | ~800 | 弹窗全家桶，react-focus-lock + react-transition-group | 中（拖 2 个 npm 依赖） |
| `toast` | 501 | Provider + createWithToast API | 低 |
| `tooltip` / `dropdown` / `dropdownMenu` | ~570 | 都压在 `floating`（693 行，@floating-ui/dom 封装）上 | 中（要连 floating 一起搬，floating 是这批浮层组件的公共地基） |
| `select` | 848 | 组合 floating + menu | 中 |
| `input` / `textArea` | ~1,030 | 输入框（含自动高度） | 低 |
| `button` | 1,272 | 全变体按钮 | 低（但我们可能自己写更划算） |
| `menu` / `segmented` / `tabs` / `skeleton` / `banner` | ~1,300 | 杂项小件 | 低 |
| `enhancedText` | 428 | 轻量 markdown 文本（粗体/链接/邮箱识别，不走完整 md 管线） | 低 |
| `animatedSizeList` | 314 | 列表增删动画容器 | 低 |
| `icons`（packages/icon + ui/icons） | 28 个 svg | 图标集 | 低 |

### packages/hooks（201 行的 `smoothText/useSmoothedGrowingText` 值得单点：流式文本平滑打字机效果；`useThrottleMarkdownRender` 已算在 md 卡片里）

### apps/chat/src/components（业务层，普遍耦合 chat-sdk/i18n/tracker，抄壳不抄芯）

| 组件 | 行数 | 说明 | 适配 |
|---|---|---|---|
| `sessionMessageList` | 1,318 | VirtualList 的消息列表包装（滚动锚定/scrollToBottom 容器/上滚加载）——**建议当参考实现读，不直接 vendor**（耦合消息 store） | 高 |
| `ScrollNav` | 790 | 消息间快捷导航条（贴 VirtualList） | 中 |
| `chatInputUi` | 3,199 | 输入框增强（模型开关/思考按钮/拖拽粘贴/字数） | 高（chat-sdk 深耦合，抄交互思路） |
| `imageThumbnail` + `packages/fancy-box` | 1,515 + 3,200 | 图片缩略图 + 灯箱查看器 | 高（fancy-box 拖 i18n/tracker/protocol） |
| `mermaid` + `packages/mermaid-toolkit` | 1,047 + toolkit | mermaid 图渲染（接 md 的 code block 扩展点） | 中（mermaid 依赖 ~2MB，宜懒加载） |
| `preview`（pdfPreview/imagePreview） | 1,580 | 文件预览 | 高（pdfjs 巨依赖） |
| `dotLoading` / `shimmerText` / `scrollArrows` | ~450 | 加载点/微光文字/滚动箭头小件 | 低 |
| `assistantMessage` | 5,698 | 气泡本体——**参考实现**（思维链折叠/分支切换都在这），耦合太深不 vendor | 高 |

上游**没有** diff 视图、文件树、代码编辑器类组件（grep 无），这几样未来要么自研要么另找来源。

## 三、落地形态建议

### 3.1 包骨架（按 lib 构型直接设计，不导出 src）

```
packages/client/web-components/            @deepseek-ai/dsh-client-web-components
├── package.json      # main: lib/index.js, types: lib/types/index.d.ts
│                     # exports: "." + "./markdown" + "./virtual-list"（每组件一个子路径出口）
│                     # sideEffects: ["*.css"]（CSS 靠 JS import 副作用带入，vite 会收）
│                     # files: lib/**（不含 src——直接按新口径）
├── README.md         # 包级 PROVENANCE 总表（见 3.2）
├── src/
│   ├── index.ts      # 或者干脆无桶文件，只留子路径出口（组件间互不依赖时更干净）
│   ├── markdown/     # ← 上游 packages/md/src 整目录（剥 cite/latex-wasm 后）
│   │   ├── PROVENANCE.md
│   │   └── …
│   ├── virtual-list/ # ← 上游 packages/ui/src/virtualList + resizeObserver + 6 个 hook 内联
│   │   ├── PROVENANCE.md
│   │   └── …
│   └── _shared/      # 多组件共用的内联小件（useEventCallback 等），同样带 PROVENANCE
└── tsconfig.json     # build 出 lib/ + CSS 原样拷贝（上游就是 tsc + postcss 拷贝，我们 vite 场景可以更简单：tsc 之外加一步 cp --parents src/**/*.css lib/）
```

- **CSS 策略**：保持上游「组件内 `import './x.css'` 全局 class」形态不改写成 CSS Modules（改写=大面积动源码，违背最小微调原则）。全局 class 有 `.ds-markdown`/`.ds-*` 前缀自隔离，与 web-ui 的 CSS Modules 并存无冲突。web-components 包内豁免 CSS Modules 约定，README 说明即可。
- **token 对接**：新建一个 `src/_shared/upstream-tokens.css`，把组件吃的 `--dsw-*`/`--ds-*` 变量逐个赋值为我们的 token（`--dsw-alias-label-primary: var(--text-primary)` 式映射表，md 一个组件约 30 行）。**不改组件 CSS 里的变量名**——升级 re-vendor 时 diff 干净。
- **web-ui 与 web-components 的边界**：web-components 只放「高度封装的外来件」；web-ui 引它、包装它（如消息列表 = web-ui 自写包装 + web-components 的 VirtualList）。web-components **不得反向依赖 web-ui**。

### 3.2 PROVENANCE 模板（每组件子目录一份 PROVENANCE.md + 包 README 总表一行）

⚠️ README/PROVENANCE 也是入库文本：**只写 commit hash + 上游包内路径，不写上游仓库名/URL**。

```markdown
# PROVENANCE

Vendored from a pinned upstream commit.

- Upstream commit: `d1405c2149fd5ea1058e28ffacbb50911c15a256` (2026-07-17)
- Source paths: `packages/md/src` (upstream monorepo-relative)
- Sync policy: manual re-vendor; diff against the pinned commit before pulling newer upstream.

## Local modifications

1. Removed the private-registry wasm math fallback (`math/latexWasm.ts` and its call sites in `math/useMathHtml.ts`); KaTeX is the only math renderer.
2. Removed the citation renderer (`renderers/cite.tsx`, `utils/restoreCiteMarkdown.ts`) and its exports — upstream-app-specific feature.
3. Inlined `useEventCallback` (was an internal workspace hook package).
4. Inlined the frequently-used-highlight-language list (was an internal shared package).
5. Replaced `copyToClipboard` import with the local implementation.
```

- **记 hash 口径**：上游是 gitlab 私仓，无公网可查——所以 hash 必须带**日期**（如上例），并在包 README 总表里维护「组件 → vendored commit」一列；不同组件允许 pin 不同 commit（分批抄必然如此），总表一眼看清谁新谁旧。当前上游 HEAD 即 `d1405c2149fd5ea1058e28ffacbb50911c15a256`（2026-07-17 19:45 +0800），建议第一批全部 pin 这个。
- **微调记录颗粒度**：按用户口径——源码级改动逐条记（剥内部引用、URL/host 替换、i18n/埋点剥离）；tsconfig/构建适配、纯格式化不记。判据：**re-vendor 时需要重放的改动才记**。

## 四、依赖策略（供用户拍板）

### 4.1 点名组件拖的 npm 运行时依赖

| 依赖 | 谁要 | 体量（min+gz 量级） | 许可证 | 评估 |
|---|---|---|---|---|
| unified + rehype-parse + rehype-react | md | 三件套 ~30KB | MIT | 核心管线，必收 |
| mdast-util-from-markdown / mdast-util-gfm / micromark-extension-gfm / mdast-util-math | md | 合计 ~60KB | MIT | 必收 |
| micromark-extension-llm-math | md | ~10KB | MIT（第三方个人包，建议入库前复核一眼 LICENSE 文件） | 必收；⚠️ 上游对它打了 pnpm patch×2（崩溃修复+单行公式），**建议跟 patch**（pnpm patchedDependencies 我们仓也能做），否则流式公式有已知崩溃 case |
| prismjs | md 高亮 | core ~7KB，语言包按需懒加载 | MIT | 必收 |
| katex | md 公式 | JS ~77KB gz + 字体/CSS ~300KB（懒加载路径已有） | MIT | 必收；latex-wasm 兜底剥除后它是唯一引擎 |
| clsx | md + virtualList | <1KB | MIT | 我们 web-ui 已在用，零增量 |
| lodash-es | md（少量函数） | 按需 tree-shake 后很小 | MIT | 可收；若想零依赖也可内联那几个函数（re-vendor 成本↑，不推荐） |
| @juggle/resize-observer | virtualList 的 polyfill | ~6KB | Apache-2.0 | **不收**：现代浏览器原生 ResizeObserver 即可，vendor 时把 compat 层改成直用原生（记入微调清单） |
| @deepseek/latex-wasm | md 公式兜底 | git+ssh 私仓 | — | **禁止**：私仓 git 依赖不可进我们 lockfile，整路径剥除 |
| react-focus-lock + react-transition-group | 未来 modal 一族 | ~15KB | MIT | 到抄 modal 时再拍，不预收 |
| mermaid | 未来 mermaid 组件 | ~2MB | MIT | 到时候再拍，必须懒加载 |

### 4.2 与「不加依赖」惯例的边界建议

此前被否的 concurrently 是**开发工具依赖**（能用 shell 替代）。web-components 的情况是**vendored 组件的运行时依赖**——组件本体我们抄进来了，它的直接运行时依赖不抄进来就得连生态一起 vendor（remark 生态几十个包，不现实）。建议边界三条，供拍板：

1. **可收**：vendored 组件的直接运行时依赖，条件=宽松许可证（MIT/BSD/Apache）+ 在 npm 公网有源 + 组件功能非它不可（remark 生态/prismjs/katex/clsx 属此类）。收进 `packages/client/web-components` 自己的 `dependencies`，不上提根目录。
2. **不收，改内联/剥除**：polyfill（原生已覆盖）、上游内部 workspace 包（逐个内联并记 PROVENANCE）、单用一两个函数的工具包（视 re-vendor 成本个案拍）。
3. **禁止**：git/私仓直连依赖、带电话回家（埋点/上报）的 SDK 类依赖。

### 五、不做清单（本调研范围外，按妥协台账三段式）

- **不 vendor `sessionMessageList`/`assistantMessage` 等业务包装**：触发条件=web-ui 消息列表需要滚动锚定/分支切换等具体交互时；返工点=届时读上游对应实现抄交互逻辑（作参考不作源）；预埋=本报告已记其路径与行数。
- **不跟上游 pnpm patch 体系整体走**：触发条件=vendor md 后流式公式出现崩溃/丢内容 case；返工点=把上游 5 个 patch 中 micromark 系 3 个移植成我们的 patchedDependencies；预埋=patch 文件路径 `common/pnpm-patches/`（上游），本报告 4.1 已标记。
- **不做 CSS Modules 化改写**：触发条件=全局 class 与未来第三方样式实际冲突；返工点=对冲突组件加 layer/scope 包裹而非改写源码；预埋=全部外来 CSS 保持 `.ds-*` 前缀不动。

