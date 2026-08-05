# Web GUI 样式规范

[English](web-styling.md) | 中文

> **【token 体系已换代——§1 表格仅历史参考】** 本文的 `--bg-*`/`--text-*`/`--accent` token 族与其宿主包 `packages/client/web-ui` 已随插件化重构退役。现行 token 唯一来源=`packages/client/ui-theme/src/styles/` 的 `--dsw-*` 体系（static 色阶+alias 语义层，暗色=`body[data-ds-dark-theme]` 覆写），sheet 即权威、组件对账以它为准。**仍然有效**：工程约束（CSS Modules + clsx、无组件库、无 tailwind、组件禁 hardcode 色值）、字号成对写行高、间距 4 倍数、代码字体栈末位不放 monospace。

> 状态：原「活文档」（随 `packages/client/web-ui` 演进）。视觉基线源自对 deepseekchat 前端仓的实测调研。框架决策与工程约束由 [web-styling-system RFC](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md) 拍板，本文不重复论证。

## 1. 设计 token 表（权威定义）

所有 token 住 `packages/client/web-ui/src/style/global.css`：`:root` 亮色实值，`[data-theme='dark']` 块覆盖同名变量（未补全前列为占位）。组件 CSS 只引 token，不出现字面量色值。

### 1.1 颜色（两层：注释里是 base 色板出处，变量名即语义别名）

| token | 亮色实值 | 暗色（占位） | 用途 |
| --- | --- | --- | --- |
| `--bg-base` | `#ffffff` | `#151517` | 页面底 |
| `--bg-layer` | `#ffffff` | `#232324` | 浮层/面板 |
| `--bg-sidebar` | `#f9fafb` | `#1b1b1c` | 侧边栏底 |
| `--text-primary` | `#0f1115` | `#f9fafb` | 正文 |
| `--text-secondary` | `#61666b` | `#cfd3d6` | 次要文字 |
| `--text-tertiary` | `#81858c` | `#adb2b8` | 辅助/说明 |
| `--border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` | 弱分隔（侧边栏右缘） |
| `--border-l2` | `rgba(0,0,0,.1)` | `rgba(255,255,255,.12)` | 常规边框 |
| `--hover-bg` | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` | hover 态底 |
| `--active-bg` | `rgba(38,49,72,.1)` | `rgba(255,255,255,.14)` | 按压/激活态底 |
| `--accent` | `#3964fe` | `#5686fe` | 品牌蓝（deepseek-500；暗提亮一档） |
| `--accent-soft` | `#edf3fe` | `#28313f` | 淡品牌底（强调块） |
| `--accent-item` | `#e4edfd` | `#35363a` | 侧边栏选中条目底 |
| `--bubble-bg` | `#edf3fe` | `#2c2c2e` | 用户消息气泡底 |
| `--ok` / `--error` / `--warn` | `#22c55e` / `#ec1313` / `#f59e0b` | 同值 | 语义状态色 |
| `--text-on-solid` | `#ffffff` | 同值 | 实色底（accent/error 徽标等）上的文字 |
| `--ok-soft` / `--error-soft` | `#e6faed` / `#fee2e2` | `#233c2c` / `#570c0c` | 语义状态软底（徽章）；green-100/red-100，暗为 900 档 |
| `--color-frame-mux` / `--color-frame-host` | `#8250df` / `#0969da` | 同值 | RPC 调试面板方向色（自有，非基线） |
| `--frame-mux-soft` / `--frame-host-soft` | `rgba(130,80,223,.1)` / `rgba(9,105,218,.1)` | 同色 `.24` | 方向色软底（徽章） |
| `--scroll-color` / `--scroll-color-hover` | `rgba(0,0,0,.08)` / `.15` | `rgba(255,255,255,.15)` / `.24` | 滚动条（`.scrollable` 专用） |

### 1.2 非颜色

| token | 值 | 说明 |
| --- | --- | --- |
| `--font-ui` | `Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` | 正文栈 |
| `--font-mono` | `Menlo, Monaco, Consolas, 'JetBrains Mono', 'Courier New', sans-serif` | 代码栈；**末位不放 monospace**（防 Windows 中文回退宋体） |
| `--fw-strong` | `600` | 粗体统一权重 |
| `--ease` | `cubic-bezier(.4,0,.2,1)` | 唯一缓动曲线 |
| `--dur` / `--dur-fast` / `--dur-slow` | `.2s` / `.1s` / `.3s` | 过渡三档 |
| `--radius-s` / `--radius-m` / `--radius-l` / `--radius-bubble` / `--radius-xl` | `8px` / `12px` / `16px` / `22px` / `24px` | 圆角语义档：小控件 / 列表条目与面板内块 / 浮层 / 气泡 / 输入卡片（基线 inputWrapper 同值）；胶囊直接写 `999px` |
| `--shadow-panel` | `0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08)` | 浮层阴影（基线 lv3） |
| `--shadow-float` | `0 0 1px rgba(0,0,0,.24), 0 4px 12px rgba(0,0,0,.06), 0 16px 48px rgba(0,0,0,.16)` | 强浮动面板（lv3 加强档，如 RPC 调试浮层） |
| `--shadow-card` | `0 4px 10px rgba(0,0,0,.02), 0 2px 4px rgba(0,0,0,.04)`；暗色 `none` | 输入卡片微阴影（基线：亮色同底靠边框+微影区分，暗色靠提亮底、阴影关闭） |

字号与间距**不 token 化**（基线仓同款决策）：字号在组件里写 px 且**成对写行高**，常用对 16/24（气泡）、14/22（UI 默认）、12/18（辅助）；间距用 4 的倍数。

## 2. 视觉基线（源自 deepseekchat）

- 侧边栏：宽 `260px + 1px` 右边框（`--border-l1`）；底色 `--bg-sidebar`。
- 侧边栏条目：高 `40px`、圆角 `--radius-m`、字号 14px；hover 底 `--hover-bg` 或 sidebar 专属灰、**选中底 `--accent-item` 且不改文字色**。
- 侧边栏分组标题：12px / weight 500 / `--text-tertiary` / sticky 顶部（底色同侧边栏遮滚动内容）。
- 会话列：`max-width: 840px` 居中，<1024px 降 712px。
- 消息流：**仅用户侧有气泡**——`--bubble-bg` 底、圆角 `--radius-bubble`、padding `10px 16px`、字号 16px/24px、`max-width: calc(100% - 88px)`；**助手侧纯文档流无底色**。
- 消息操作条：默认 `opacity: 0`，父块 hover/focus-within 淡入（`--dur` + `--ease`）。
- 输入卡片：与会话列同宽（840px，<1024px 降 712px)居中悬浮（距底留白带）；圆角 `--radius-xl`、边框 `--border-l2`、底 `--bg-base`、阴影 `--shadow-card`；内部上下两段=textarea（16px/24px，min 2 行 max 14 行=336px，镜像 div 自增高）+ 操作行（右下嵌 34px 主圆钮）；focus 无边框/阴影变化（基线同款）。
- 输入主按钮（拍板 2026-07-20 三连，视觉参照 Codex App）：32px 实心正圆图标钮（内联 SVG）——空闲=`--accent` 底白↑箭头「发送」，运行中原地变 `--accent-soft` 底 accent ■「停止」（同色系不告警、不用红）。**运行中锁输入**（拍板 3，取代早先 hover 菜单方案）：textarea disabled（灰、草稿内容保留可见）、无任何排队/插话菜单，停止是唯一动作；turn 结束解禁并 refocus。键盘 Enter=发送、Ctrl/Meta+Enter=换行（运行中键盘路径随锁失效）。
- 滚动条：近隐形、hover 加深、`scrollbar-gutter: stable` 不占布局（统一走 `.scrollable`，见 §3-9）。
- RPC 四象限方向符（官方视觉词汇，空间隐喻：上=去 server、下=来自 server；单线=客户端发起的交互、双线=服务端发起的交互）：

| 符号 | 象限 | 徽章配色 |
| --- | --- | --- |
| `↑` | client-request（unary 出站） | `--accent` / `--accent-soft` |
| `↓` | server-response（unary 回包） | ok `--ok`/`--ok-soft`，error `--error`/`--error-soft` |
| `⇟` | server-request（下行流） | mux `--color-frame-mux`/`--frame-mux-soft`，host `--color-frame-host`/`--frame-host-soft` |
| `⇞` | client-response（对 server request 的回应） | `--accent`/`--accent-soft` 降透明度 |

## 3. 样式编码规范（review 对照打勾）

1. 颜色/圆角/动效/字体栈只引 §1 token；组件 CSS 出现字面量色值即打回（渐变遮罩等特效除外，须注释说明）。
2. 组件 CSS 禁止出现 `[data-theme]` 选择器；暗色差异只在 global.css token 表做。确需按主题换非 token 值（渐变端点等），组件定义局部 CSS 变量、主题块只覆写变量（变量桥）。
3. 类名 camelCase；状态类用单形容词（`.active` `.show`），由 clsx 挂载：`clsx(styles.x, cond && styles.active, className)`。
4. 对外组件必须透传 `className` 并合入根元素。
5. 禁用 `composes`；复用靠 token 与组件抽取。
6. `:global` 仅用于穿透第三方/跨包类名；禁止用它定义新全局类。
7. 交互过渡一律 `var(--dur*) var(--ease)`，只过渡 opacity / transform / 背景色 / 阴影；纯 hover 展示型元素包 `@media (hover: hover)`。
8. hover/active 底色优先用透明度制 token（叠任意海拔底色都成立），不新造实色灰。
9. 滚动容器统一挂 global.css 的 `.scrollable` 工具类；组件内禁写 `::-webkit-scrollbar`。
10. 媒体查询写在组件 css 尾部、贴着被覆盖规则；断点当前仅 1024px 一档（会话列降档），加第二档需先记入本文档。
11. 动态样式 JS 侧只写 CSS 变量（`style={{'--x': v}}`），规则留在 CSS；禁止在 TSX 里拼接样式对象做主题/状态分支。
12. 文字灰阶只用 `--text-primary/secondary/tertiary` 三级，不新造灰色。

## 4. 文件组织

- `src/style/global.css` 固定分区顺序：① token 表（`:root` + `[data-theme='dark']`）② 全局基础（box-sizing、body、button reset）③ 全局工具类（`.scrollable` 等，总数保持个位数）。
- `*.module.css` 与组件同目录同名；一个组件一个 module 文件。
- 类型声明用现有 `css-modules.d.ts` 通配；组件数超 20 再评估引入 tcm 生成精确 `.css.d.ts`。
- PostCSS 特性白名单：当前**零插件**（平铺 CSS + 原生嵌套按需）；引入 nested/custom-media 需先记入本文档。

## 5. 演进规则与偏离记录

- **加新 token**：先进 §1 表（含暗色占位列）再在组件使用；review 见到未入表的 `--` 新变量即打回（组件局部变量桥除外）。
- **偏离基线**：与 §2 任一常数不一致的实现，须在下方偏离表记一行（日期/项/理由）。
- **暗色表补全验收**：`[data-theme='dark']` 覆盖 §1 全部占位列后，用 RPC 面板 + 侧边栏 + 会话流三个界面人工/截图核对一遍，无组件级主题选择器即达标。

| 日期 | 偏离项 | 理由 |
| --- | --- | --- |
| （空） | | |

## 6. 相关文档

- [web-styling-system RFC](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md)（框架五条与工程约束的裁决记录）
- 客户端消费架构与分层协议：[Web 客户端架构 RFC](../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md)、[GUI 分层与 RPC 协议 RFC](../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)
