# deepseekchat 样式风格调研报告

参考仓：`/weka-hg/prod/deepseek/permanent/ys/private/workspace/gitlab/deepsuite-frontend`（下文以 `dsf/` 指代），主应用 `dsf/apps/chat`。所有 file:line 均相对 `dsf/`。

## 1. 设计 token 体系

### 1.1 三层命名法：static → alias → specific

全部颜色 token 挂在 `body` 上（不是 `:root`，为了让 `body[data-ds-dark-theme]` 属性选择器天然胜出），前缀 `--dsw-`（deepseek web），由 cssVarLint 门禁约束（`apps/chat/cssVarLint.config.json:9` 只允许 `--dsw` / `--ds` 前缀的变量定义在指定文件中）。

三层结构（`packages/theme/src/newDesign.css`）：

| 层 | 命名模板 | 例 | 语义 |
| --- | --- | --- | --- |
| **static** | `--dsw-static-<hue>-<step>` | `--dsw-static-neutral-bluish-75: rgb(241,243,245)`（newDesign.css:60） | 原始调色板，亮暗两份定义但值几乎相同（palette 本身不随主题变） |
| **alias** | `--dsw-alias-<role>-<slot>` | `--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000)`（newDesign.css:194） | 语义角色层，**组件主要引用这层**；亮暗主题在这层重新映射 |
| **specific** | `--dsw-specific-<component>-<slot>` | `--dsw-specific-sidebar-nav-item-hover: var(--dsw-static-neutral-bluish-75)`（newDesign.css:228） | 组件专属槽位，只给个别高频组件（sidebar/bubble/input/menu）开小灶 |

static 层色相族：`amber / blue / deepseek(品牌蓝) / green / red / neutral / neutral-bluish`。阶梯是 Tailwind 式 50–950，且按需插半档（60/75/450/550/750/875）——**阶梯按视觉需要扩展，不追求等距**。品牌色 `--dsw-static-deepseek-500: rgb(57,100,254)`（newDesign.css:23）。

alias 层的 role 分类（newDesign.css:147-230 亮色全表）：

- `bg-*`：`bg-base` / `bg-layer-1..3`（**海拔分层**：亮色下全白，暗色下逐层变浅，见 §4）/ `bg-mask-1..3` / `bg-overlay` / `bg-skeleton`
- `border-l1..l4`：边框只用**黑/白透明度**（亮 `rgba(0,0,0,0.04)`→`0.16`，newDesign.css:161-165），不用实色灰——叠在任何底色上都成立
- `label-*`：文字五级 `primary / secondary / tertiary / caption / dimmed` + 反相 `primary-inverted` / `primary-foreground`
- `interactive-bg-*`：hover/active 态统一用**带蓝调的透明色** `rgba(38,49,72,0.06)`（hover）/ `0.1`（active）/ `0.14`（hover-accent）（newDesign.css:184-188），保证叠加在不同底色上表现一致
- `button-<variant>-<state>`：primary/ghost/link/floating/elevated/contrast × fill/hover/dimmed
- `state-*`：error/success/warn × primary/secondary/tertiary
- `markdown-*`、`scrollbar-*`、`toast-bg`、`tooltip-bg`：场景专属

### 1.2 非颜色 token：`--ds-` 前缀，住 theme/global.css

`packages/theme/src/global.css:27-87` 挂在 `body, page, .ds-theme` 上：

- **控件高度阶梯**：`--ds-control-height-xl/l/m/s/xs` = 44/40/36/32/28px（global.css:30-34）
- **字号+行高成对阶梯**：`--ds-font-size-l/m/sp/s/xsp/xs` = 16/14/13/12/11/10px，行高 28/25/23/21/19.5/18px（≈1.75 倍率）（global.css:40-62）；`body` 默认 `font-size: var(--ds-font-size-m)`（global.css:92）
- **粗体权重平台自适应**：`--ds-font-weight-strong: 600`，Apple 或 en_US 环境降为 500（global.css:37, 106-111）
- **缓动曲线**：`--ds-ease-in-out/in/out` 三条贝塞尔（global.css:65-69）
- **过渡时长**：`--ds-transition-duration` 0.2s / fast 0.1s / slow 0.3s（global.css:82-86）
- **字体栈**：正文 `--dsw-font-family`（'quote-cjk-patch' + Inter + system-ui 系，global.css:3-5）；代码 `--ds-font-family-code`（Menlo/Consolas/JetBrains Mono 长栈，**末位故意不放 monospace** 防 Windows 中文宋体，global.css:72-79）

**没有间距/圆角 token**——间距和圆角在各组件 CSS 里写死 px 值（见 §2 的节奏归纳），token 化只覆盖颜色/字号/高度/动效。

### 1.3 引用纪律与门禁

- 组件 CSS 只写 `var(--dsw-alias-*)` / `var(--dsw-specific-*)` / `var(--ds-*)`，基本不直接引 static 层（个别渐变特效除外）。
- `cssVarLint.config.json` 声明 token 定义文件白名单（`packages/theme/src/**/*.css`、`apps/chat/src/style/global.css` 等），其余文件定义 `--dsw/--ds` 变量会被 lint 拒绝——**token 单一来源是被工具强制的**。
- 应用侧准入：`apps/chat/src/index.tsx:53-62` 顺序 import `@deepseek/theme/es/global.css` → `newDesign.css` → md/auth 包 CSS → 应用自己的 `style/global.css`（应用级只补 `--scroll-color`、mermaid 高度等少量变量，`apps/chat/src/style/global.css:20-32`）。

## 2. 视觉风格基线（侧边栏 + 会话流重点）

### 2.1 侧边栏

- **宽度**：`--sider-width: 261px`（注释「留了一像素给右边框」，`apps/chat/src/components/animationSider/AnimationSider.module.css:1-4`）。
- **容器**：底色 `--dsw-specific-sidebar-fill`（亮=bluish-50 近白灰，暗=bluish-900），右边框 `1px solid var(--dsw-alias-border-l1)`（4% 黑），内边距 `6px 12px 10px`（`wideSider/WideSider.module.css:10-21`）。
- **条目（会话项）**：高 40px、圆角 **12px**、padding `9px 6px 9px 10px`、字号 14px（`sessionItem/SessionItem.module.css:1-16`）。三态：
  - hover：`--dsw-specific-sidebar-nav-item-hover`（亮=bluish-75），且用 `@media (hover: hover)` 包裹避免触屏误触发（SessionItem.module.css:46-58）；
  - active（当前会话）：`--dsw-specific-sidebar-nav-item-active-accent`（亮=deepseek-100 淡品牌蓝底）+ 文字保持深色（SessionItem.module.css:37-44）——**选中态用品牌淡底而非改文字色**；
  - 条目右端操作按钮：默认 `display:none`，hover/选中时显示，且左侧接一段**同底色渐变遮罩**盖住溢出文字（`--mask-base-color` 按亮/暗/选中三套 RGB 值切换，SessionItem.module.css:59-97）——文字截断不用 ellipsis 而用渐隐。
- **分组小节**：sticky 标题（`top:0`、字号 12px/行高 18px、`label-tertiary` 色、weight 500、底色同 sidebar-fill 遮滚动内容，`sessionList/SectionShared.module.css:1-11`）；节间距 `margin-top: 16px`（SectionShared.module.css:42-48）。列表底部再叠一条 68px 高的渐变遮罩过渡到容器底色（`sessionList/SessionList.module.css:108-124`，暗色下渐变起点色单独覆写）。
- **新建会话按钮**：白底胶囊（圆角 100px、高 40px），**三层组合阴影**造浮起感，hover 换更深的三层阴影；暗色下改用 `inset` 高光 + 单层投影（`newChatButton2/NewChatButton2.module.css:15-70`）。快捷键提示 `⌘ J` 用 `::after` 常驻、hover 淡入（:38-55）。
- **收合动画**：`transform: translateX(-sider-width)` + `max-width` 双过渡，时长用 token `--ds-transition-duration-slow`(0.3s) + `--ds-ease-in-out`；移动端 fixed+mask，桌面端（`--md-viewport`）相对布局压缩 max-width（AnimationSider.module.css:9-92）。

### 2.2 会话流

- **列宽**：`--message-list-max-width: 840px`，水平 padding 44px；`--max-lg-viewport`（<1024px）降为 712px/36px（`routes/session/Session.module.css:1-10`）。消息列 `flex:1` 居中、`max-width:100%`（:52-60）。
- **用户消息（气泡）**：右对齐、底色 `--dsw-specific-bubble`（亮=deepseek-50 极淡品牌蓝，暗=bluish-850），**圆角 22px**、padding `10px 16px`、字号 16px/行高 24px、`max-width: calc(100% - 88px)`（小屏 -68px）（`userMessage/UserMessage.module.css:88-106,115-119`）。
- **助手消息（无气泡）**：透明底直接排版，不加底色（`assistantMessage/AssistantMessage.module.css:1-13`）——**只有用户侧有气泡，助手侧是纯文档流**，这是 deepseekchat 会话流的核心视觉特征。搜索高亮时才用 `::before` 垫一块 12px 圆角的 `bg-multi-select` 底（:39-72）。
- **消息操作条**：默认 `opacity:0`，父块 hover / focus-within 时淡入，时长/曲线走 token（UserMessage.module.css:58-73、AssistantMessage.module.css:75-86）。
- **消息间距节奏**：用户消息块 `padding-bottom: 16px`（UserMessage.module.css:5）；正文 markdown 字号 16px/行高 28px（`--dsw-font-markdown-base`，`packages/theme/src/newDesignGradientShadowText.css:50-55`）。
- **输入框**：大圆角 24px、底色 `--dsw-specific-input-major`、box-shadow 过渡（`chatInputUi/ChatInputUi.module.css:18-38`）；水平居中公式 `padding: 0 calc((100% - var(--message-list-max-width)) / 2)`（`routes/session/InputCompose.module.css:6`）。

### 2.3 字体与字号

- 正文栈：`'quote-cjk-patch', 'Inter', system-ui, ...`（theme/global.css:3-5）；代码栈见 §1.2。
- UI 字号实用阶梯：侧边栏条目/按钮 14px、分组标题/辅助文字 12px、气泡与 markdown 正文 16px。粗体统一 `--ds-font-weight-strong`（500/600 平台自适应）。
- Figma 插件导出的复合字体 token `--dsw-font-<name>: <weight> <size>/<lh> var(--dsw-font-family)` 速记形式 + 拆分字段并存（newDesignGradientShadowText.css:20-56，注释注明由 `@deepseek-figma-plugin/custom-variable-name` 导出）——设计稿→token 有自动化管道。

### 2.4 圆角 / 阴影 / 图标 / 滚动条

- **圆角实用值普查**（apps/chat 全部 module.css）：12px（侧边栏条目、高亮垫底）> 16px > 8px（小控件）> 100px/999px 胶囊 > 22-28px（气泡、输入框）。无圆角 token，按组件语义取值：**小控件 8、列表条目 12、大容器/气泡 22-28、胶囊 100px**。
- **阴影 token**：`--dsw-shadow-lv1/lv1-blur/lv2/lv3` 三级海拔（多层低透明度黑，如 lv3 = 1px 描边影 + 4px 近影 + 32px 远影，newDesignGradientShadowText.css:5-9）；组件特殊阴影（如新建按钮）直接写字面量。
- **图标**：无 iconfont、几乎无 .svg 资产文件（apps/chat 仅 1 个 qrcode.svg）。主方案是 **手写 TSX 内联 SVG 组件库**：`packages/ui/src/icons/index.tsx` 94 个 `IconXxx{Outline|Fill}{16|20|24}` 导出，`fill="currentColor"` 吃 CSS `color`；配套 `<Icon>` 包装组件控制盒尺寸（`packages/ui/src/icon/Icon.tsx`）。rspack 同时配了 @svgr/webpack（`apps/chat/rspack.config.ts:231-235`）作零散兜底。命名带尺寸后缀（16/20/24）对应 viewBox。
- **滚动条**：两套并存——通用元素用 `.scrollable` 全局类：`scrollbar-color: var(--scroll-color) transparent` + `scrollbar-gutter: stable`，hover 才加深（`apps/chat/src/style/global.css:24-41`）；重滚动区用自研 `ScrollArea` 组件画 gutter，颜色接 `--dsw-alias-scrollbar-*` token，带 1s 延迟淡出（`packages/ui/src/scrollArea/ScrollArea.css`）。**共同点：滚动条默认近隐形、hover 激活、永不占布局**。
- **过渡尺度**：几乎所有交互过渡走三档 token（0.1/0.2/0.3s）+ 三条贝塞尔；opacity/transform 为主，配 `will-change`；不做大型 keyframe 动画（骨架屏 shimmer 除外）。

## 3. 样式工程编码模式

### 3.1 CSS Modules 纪律

- **类命名 camelCase**（`.sessionItem` `.actionButtonMask` `.menuContainer`），状态类用简单形容词（`.active` `.collapsed` `.show` `.editing`），无 BEM 残留。
- **`composes` 零使用**（全仓 grep 无一处）——复用靠 token 变量和组件封装，不靠类继承。
- **`:global` 只用于两类**（apps/chat 共 67 处）：① 穿透 UI 库前缀类（`.ds-focus-ring` `.ds-modal` `.ds-select` 等 `ds-*`）；② 穿透 markdown 渲染类（`.md-code-block`）。**从不**用 :global 定义新全局类——全局类只在非 module 的 global.css 里定义（如 `.scrollable`）。
- **`.module.css` 之外的 css 只有四类**：token 表（theme 包）、应用 global.css、markdown 覆写、第三方覆写（cookieBanner）。

### 3.2 PostCSS 特性面

构建链只有 4 个插件（`shared/rspack-postcss-rule/index.ts:12-19`）：`@csstools/postcss-global-data`（注入 media.css）→ `postcss-custom-media` → `postcss-nested` → `autoprefixer`。

- **nested**：全面使用 `&:hover` `&.active` 及子类嵌套，但嵌套层级实践上 ≤3 层。
- **custom-media**：断点表集中在 `packages/viewport/media.css`，Tailwind 式命名 `--sm/md/lg/xl/2xl/3xl-viewport`（min-width 440/768/1024/1280/1536/1920）+ 对偶 `--max-*-viewport`（`not all and (min-width:)` 写法），由 postcss-global-data 注入所有 css 免 import。注释明确「sm 440 是设计师定的」。
- **响应式组织**：断点内联在各组件 css 尾部（媒体查询贴着被覆盖的规则），不搞集中式响应式文件；变量级响应式直接在 `:root` 里嵌 `@media` 重设 token 值（Session.module.css:1-10 的做法）。

### 3.3 className 组合与类型

- **clsx 为唯一组合器**（89 处 import），模式统一：`clsx(styles.item, cond && styles.active, className)`（如 `avatarMenuSettingDialog/AvatarMenuSettingDialog.tsx:503`）；组件一律接受外部 `className` 合入。
- **typed-css-modules 工作流**：`tcm -p src/**/*.module.css` 生成 `.css.d.ts`（`apps/chat/package.json:28-29`），dev 时 `tcm --watch` 与 dev-server 并跑（package.json:9）；**`.css.d.ts` 提交进仓**（.gitignore 只排 `.css.d.ts.map`），typecheck 前先跑 tcm（package.json:32）。d.ts 形如 `declare const styles: { readonly "sessionItem": string; ... }; export = styles`。非 module css 靠 `declare module '*.css' {}`（`apps/chat/src/css.d.ts`）。
- **应用级 global.css 边界**：只放 ① 少量应用私有变量（--scroll-color、mermaid 高度）② body 级排版/字体平滑 ③ 极少数工具类（`.scrollable` `.pointer-events-none`）（`apps/chat/src/style/global.css`）。**没有 reset/normalize 文件**——靠 body margin:0 + 组件自理。
- **动态样式走 CSS 变量桥**：TSX 里 `style={{'--dsl-icon-svg-height': h}}`（Icon.tsx:25-27）、CSS 里 `--mask-base-color` 按主题覆写（SessionItem.module.css:60,90-97）、focus ring 用 `--on: 1` 开关（SessionItem.module.css:18-22）——**JS 只写变量，规则始终在 CSS**。

## 4. 暗色主题实现

**机制**：`body[data-ds-dark-theme]` 属性选择器整表覆盖。亮色表 `body {...}`（newDesign.css:147），暗色表 `body[data-ds-dark-theme] {...}`（newDesign.css:232）重定义**同名 alias/specific 变量**。组件零感知——组件 CSS 里没有任何 `[data-theme]` / `prefers-color-scheme` 分支（全仓组件 module.css 无一处主题选择器）。

**切换器**：`packages/app-kit-web/src/plugins/theme.ts:44-61` `handleThemeChange()`——设/删 `document.body.dataset['dsDarkTheme']`，同时维护 `body.light/.dark` class（`.dark` 主要用来设 `color-scheme: dark` 让 Safari 原生滚动条变暗，theme/global.css:115-118）。主题偏好三态 light/dark/system，system 态用 `matchMedia('(prefers-color-scheme)')` 双监听（theme.ts:106-121）。

**防闪烁细节**：切换瞬间给 `body.change-theme` 注入 `* { transition: none !important }`（theme.ts:5-17, 45-60），setTimeout(0) 后移除——避免每个带 transition 的元素在换主题时各自渐变造成撕裂。

**暗色映射规律**（我们做暗色表时直接套用）：

- 底色海拔：亮色 `bg-base/layer-1/2/3` 全白；暗色 = bluish-950/875/850/800（newDesign.css:233-236）——**越浮起越亮**。
- 文字：亮 `label-primary` = bluish-1000 → 暗 = bluish-50；secondary 700→300；tertiary 600→400（**围绕 500 轴对称翻转**）。
- 边框/hover：黑透明度 → 白透明度，且暗色下透明度略调高（border-l2 亮 0.1 → 暗 0.12；interactive-bg-hover 亮 0.06 → 暗 0.08）。
- 品牌色暗色下提亮一档：brand-primary 500 → 450，brand-text 500 → 400（newDesign.css:252-253）。
- 侧边栏：亮 bluish-50 → 暗 bluish-900（比 bg-base 950 浮一层）。

## 5. 可移植资产清单 + 阶段二建议

### 5.1 可直接搬的 token 值

**颜色**（deepseekchat 实值，直接进我们 global.css）：

- 品牌蓝 `rgb(57,100,254)`（≈我们现有 `--color-accent: #4d6bfe` 的正源，建议改成 deepseek-500 实值 `#3964fe`；hover 提亮档 `#5686fe`=450）
- 淡品牌底：气泡 `#edf3fe`（deepseek-50）、选中 accent `#e4edfd`（deepseek-100）
- neutral-bluish 灰阶（我们只需 8 档）：`#ffffff`(00) `#f9fafb`(50) `#f1f3f5`(75) `#ebeef2`(100) `#61666b`(700) `#232324`(875) `#1b1b1c`(900) `#151517`(950)
- 文字：primary `#0f1115`(bluish-1000) / secondary `#61666b`(700) / tertiary `#81858c`(600) / caption `#adb2b8`(400)
- 边框透明度制：l1 `rgba(0,0,0,.04)` l2 `.1` l3 `.12`；hover 透明度制：`rgba(38,49,72,.06)`，active `.1`
- 语义：error `#ec1313`(red-600) / success `#22c55e`(green-500) / warn `#f59e0b`(amber-500)

**非颜色**：

- 字号/行高对：16/28（正文长文）、14/25（UI 默认）、13/23、12/21（辅助）
- 控件高度：40/36/32/28
- 动效：0.1/0.2/0.3s + `cubic-bezier(0.4,0,0.2,1)`（in-out）
- 圆角语义档：8（小控件）/ 12（列表条目、面板内块）/ 16（浮层）/ 22（气泡）/ 999（胶囊）
- 阴影三级：lv1 `0 2px 4px rgba(0,0,0,.05)`、lv2 `0 4px 12px rgba(0,0,0,.02), 0 2px 8px rgba(0,0,0,.04)`、lv3 `0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08)`
- 代码字体栈整条照抄（§1.2，注意末位 sans-serif 防宋体的细节）
- 侧边栏几何：宽 260+1px 边框、条目高 40/圆角 12、分组标题 12px/500/sticky
- 会话列宽 840px（<1024 降 712）；用户气泡圆角 22px/padding 10px 16px/max-width calc(100% - 88px)

### 5.2 我们的 token 表草案（亮色实值 + 暗色占位）

规模对齐我们的体量：**两层不三层**（palette 直接内联进语义层注释；specific 层只留 sidebar/bubble 两组），前缀沿用无前缀 `--color-*` 或换 `--ui-*` 由阶段二拍板。挂 `:root`，暗色用 `[data-theme='dark']` 覆盖（我们已有占位约定，等效 deepseekchat 的 body 属性方案）。

```css
:root {
  /* 表面（海拔）*/
  --bg-base: #ffffff;          /* dark: #151517 */
  --bg-layer: #ffffff;         /* dark: #232324  浮层/面板 */
  --bg-sidebar: #f9fafb;       /* dark: #1b1b1c */
  /* 文字 */
  --text-primary: #0f1115;     /* dark: #f9fafb */
  --text-secondary: #61666b;   /* dark: #cfd3d6 */
  --text-tertiary: #81858c;    /* dark: #adb2b8 */
  /* 边框/交互态：透明度制，双主题只换黑白 */
  --border-l1: rgba(0,0,0,.04);       /* dark: rgba(255,255,255,.06) */
  --border-l2: rgba(0,0,0,.1);        /* dark: rgba(255,255,255,.12) */
  --hover-bg: rgba(38,49,72,.06);     /* dark: rgba(255,255,255,.08) */
  --active-bg: rgba(38,49,72,.1);     /* dark: rgba(255,255,255,.14) */
  /* 品牌 */
  --accent: #3964fe;           /* dark: #5686fe */
  --accent-soft: #edf3fe;      /* dark: #28313f 近似 deepseek-900 */
  --accent-item: #e4edfd;      /* 侧边栏选中；dark: #35363a */
  /* 语义 */
  --ok: #22c55e;  --error: #ec1313;  --warn: #f59e0b;
  /* 专属槽位 */
  --bubble-bg: #edf3fe;        /* dark: #2c2c2e */
  /* 字体 */
  --font-ui: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono: Menlo, Monaco, Consolas, 'JetBrains Mono', 'Courier New', sans-serif; /* 末位不放 monospace */
  --fw-strong: 600;
  /* 动效 */
  --ease: cubic-bezier(.4,0,.2,1);
  --dur: .2s;  --dur-fast: .1s;  --dur-slow: .3s;
  /* 圆角语义档 */
  --radius-s: 8px;  --radius-m: 12px;  --radius-l: 16px;  --radius-bubble: 22px;
  /* 阴影 */
  --shadow-panel: 0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08);
}
```

（字号沿用「组件里写 px、成对写行高」的 deepseekchat 实践，不 token 化；间距同样不 token 化——参照仓也没做，见 §1.2。）

### 5.3 样式编码规范草案（10 条）

1. 颜色/圆角/动效/字体栈**只准引 token**，组件 css 不出现字面量色值（渐变遮罩等特效除外，须注释）。
2. 暗色适配只在 token 表做：组件 css 禁止出现 `[data-theme]` 选择器；确需按主题换非 token 值（如渐变端点）时，用「CSS 变量桥」——组件定义局部变量、主题块只覆写变量。
3. 类名 camelCase；状态类用单形容词（`.active` `.show`）由 clsx 条件挂载：`clsx(styles.x, cond && styles.active, className)`；组件必须透传 `className`。
4. 不用 `composes`；复用靠 token 与组件抽取。
5. `:global` 仅用于穿透第三方/跨包类名，禁止用它定义全局类；全局工具类只住 global.css 且总数个位数。
6. 交互过渡一律 `var(--dur*) var(--ease)`，只过渡 opacity/transform/背景色/阴影；hover 展示型元素配 `@media (hover: hover)`。
7. hover/active 底色优先用透明度制 token（`--hover-bg`），保证叠加在任意海拔底色上成立。
8. 文字五级色阶按语义取用（primary 正文 / secondary 次要 / tertiary 辅助说明），不新造灰色。
9. 滚动条统一 `.scrollable` 工具类（`scrollbar-color` + `scrollbar-gutter: stable` + hover 加深），不各自写 `::-webkit-scrollbar`。
10. 媒体查询贴着被覆盖规则写在组件 css 尾部；断点先只设一档 1024px（列宽降档），有第二个消费者再扩表。

### 5.4 现有三个 css 文件改造要点

- **`style/global.css`**：① 按 §5.2 重排 token 表（现 `--color-hover: #ececee` 实色灰 → 换透明度制；`--color-accent: #4d6bfe` → `#3964fe`；补 radius/dur/ease/强调弱底/气泡槽位；`--color-frame-mux/host` 调试方向色保留）；② 补 `[data-theme='dark']` 覆盖块（值照 §5.2 注释）；③ body 字体栈换 `--font-ui` 并补 `-webkit-font-smoothing: antialiased`；④ 新增 `.scrollable` 工具类。
- **`App.module.css`**：`.app` 拆出侧边栏骨架时直接用 `--bg-sidebar`/`--border-l1`；`.blank` 的 `28px` 标题字号无碍保留，次要文字色改 `--text-tertiary`。
- **`RpcLog/RpcLog.module.css`**：① 硬编码 `#fff`（.unread 文字）→ token；② `.actions button:hover` / `.rowLine:hover` 的 `--color-hover` 换透明度制 `--hover-bg`；③ 圆角 4px/8px 归到 `--radius-s/m` 档；④ `.list` 加 `.scrollable` 行为；⑤ `.badge`/`.panel` 的 `border-radius: 999px`/`8px` 分别对齐胶囊档与 `--radius-m`；面板阴影已是 lv3 风格，接 `--shadow-panel` 即可。改造为纯替换，不动布局。

### 5.5 阶段二遗留决策点

- token 前缀要不要学 `--dsw-` 加命名空间（我们建议 `--ui-` 或维持无前缀，等 lead 拍板）。
- 暗色触发选 `[data-theme='dark']`（已有占位）还是学 body dataset——建议维持现约定，语义等价。
- tcm（.css.d.ts 生成）我们已有 `css-modules.d.ts` 通配声明，体量小可不上 tcm；若组件数过 20 再引入。
- postcss-nested/custom-media：Vite 内置 postcss 支持，加两个插件成本低；但当前无嵌套需求，阶段二可先不加，写平铺 css。
