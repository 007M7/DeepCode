# Web GUI 多语言（i18n）设计

> 状态：完稿待 review。用户点题「Web 多语言」，无附加约束；本文铺开设计空间，分叉点集中在 §7 留用户拍板。零源码改动——本文是纯设计文档。

## 0. 结论速览

- 现状：~50 条中文文案/15 文件，插值普遍但零富文本；host 下发文本三档可译性（RpcError 可本地化/agent-error 不可/tool 卡 title 血辐射大），v1 全不动。
- 参照系（用户钉的口径）：deepseekchat **自研** i18n——zh_CN 基准字典 + `I18n = typeof zh_CN` 编译期 parity、`t.key` 属性访问、preference（`AllLocale | 'system'`）与 resolved locale 分离存 zustand、错误码→key 查字典（file-error-code 先例）。
- 适配：**抄形态裁规模**——它 82 语/codegen/懒加载，我们 2 语/手写/随主包；web-ui 内 `src/i18n/` 手写 ~60 行，**零新增 npm 依赖**（dayjs 不引，两语用平台 Intl）；locale 状态照 chat 进 zustand ui slice，localStorage 键 `dsh.locale`；locale 命名 zh_CN/en_US 与上游 @deepseek/ui 的 LocaleProvider 取值同源（web-components vendor 联动预留）。
- 四个分叉留用户拍（§7：照抄深度/v1 范围/默认语言/状态落点），八条台账三段式在案（§6）。

## 1. 现状盘点

### 1.1 web-ui 静态中文文案：约 50 条，集中在 15 个文件

grep 全部 `packages/client/web-ui/src`（33 个 ts/tsx 文件），产品中文文案分布如下（条数为不同文案串数，同文件重复引用算一条）：

| 文件 | 条数 | 代表文案 |
| --- | --- | --- |
| `utils/formatRelative.ts` | 3+locale | 刚刚 / `${n}s 前` / `${n}min 前`，且 `toLocaleTimeString('zh-CN')` 硬编码 locale |
| `components/ConnectionBanner.tsx` | 1 | 连接已断开，正在重连… |
| `conversation/ConversationView.tsx` | 7 | session 已移除 / 历史视图降级（fold 失败）/ agent 错误：… / 载入历史… / 历史加载失败 / 加载中… / 加载更早 |
| `conversation/InputBar.tsx` | 8 | 发送 / 停止 / 发送失败 / 会话不可用 / 输入消息，Enter 发送，Shift+Enter 换行 / 停止本轮 |
| `conversation/ToolCallCard.tsx` | 6 | 参数 / 结果内容块 / 执行中… / 已中断 / 失败（code）/ 完成 |
| `conversation/PendingCard.tsx` | 4 | 等待审批：/ 等待回答（N 题）/ 问题内容 / 请在原客户端处理 |
| `conversation/AssistantMessage.tsx` | 4 | 思考过程（N 字）/ 调用工具 / 未知内容块 / 已停止 |
| `conversation/MessageItem.tsx` | 4 | 插话 / 附加内容块 / 上下文注入 / 未知 surface 事件 |
| `conversation/toolViewCards.tsx` | 2 | 内容块 / 输入 |
| `conversation/JsonBlock.tsx` | 1 | … 已截断，共 N 字符 |
| `sessions/SessionListView.tsx` | 6 | 刷新列表 / 新建 session / 列表加载失败 / 重试 / 载入中… / 暂无 session |
| `sessions/SessionsScreen.tsx` | 1 | 选择或新建 session |
| `sessions/ThemeToggle.tsx` | 2 | 切换到浅色模式 / 切换到深色模式（title + aria-label 同串） |
| `panels/RpcLog/RpcLogBody.tsx` | 5 | N 条 / 已丢弃 N / 继续 / 暂停 / 清空 / 已暂停跟随 |
| `panels/RpcLog/PayloadJson.tsx` | 1 | … 已截断，共 N 字符（与 JsonBlock 同款、独立实现） |

形态特征（决定选型时的表达力需求）：

- **插值普遍**：约 1/3 文案带 `${n}`（条数、字数、error.message、code）。中→英需要复数处理的只有个位数（"N 条"、"N 题"类）——zh 无复数，en 需要 `item/items` 级别的简单二分，**用不到 ICU MessageFormat 的全量能力**。
- **落点多样**：JSX 文本节点、`title=`、`aria-label=`、`placeholder=`、以及少量 util 返回值（formatRelative）。即 i18n 面不只在 JSX——**纯 TS util 也要能查字典**，方案不能只提供 React 组件形态（如 `<Trans>`）。
- **零富文本嵌套**：没有一条文案内嵌 React 元素（无「点击<a>这里</a>」类），`<Trans>` 组件级插值能力用不上。
- 另有 `web-runtime/src/fixture.ts` 里一批中文（fixture 历史消息样本），是**测试样本数据不是产品文案**，不进翻译面。

### 1.2 host 侧下发的用户可见文本：三类，语种与可译性各不同

web 是纯呈现层（conventions §18），但呈现的**内容**有三类来自 host 的 wire 文本，当前全部英文，是否进翻译面是本设计的真分叉（→ §7）：

1. **RpcError.message**（`host/apiproxy/src/api/rpc.ts`）：`{ code, message, details }`，code 是**闭合联合**（`bad-request` / `session-not-found` / `agent-busy` / `internal`），message 是 host 现场拼的英文句（如 `session "x" not found (not attached)`）、details 是结构化槽。UI 当前直接渲染 `message（code）`（ConversationView / InputBar / SessionListView 三处）。**结构上已具备 client 端本地化条件**：code 闭合 + details 结构化，client 可按 code 查本地字典重组句子，message 降级为开发者详情。
2. **`host/agent-error` 帧**：`message: String(error)`——任意运行时错误串，**不可枚举、不可译**，只能原样透传展示。
3. **tool 卡 view**（`dsh-tools` presentation 契约）：`TerminalCallView.title` 是**命令原文**（代码，不该译）；`GenericCallView.title` / `TerminalCallView.description` 是 presenter 产的英文短语（如 `Write foo.txt`）。这批文本由 host 端各 tool 的 presenter 决定，**client 无法按 key 重组**（开放集合）；要译只能改 host presenter 契约（加 locale 参数或结构化 title），血辐射大。

### 1.3 既有可对齐的模式

- **主题切换**（`web-ui/src/utils/theme.ts`）：纯前端关注点——localStorage key `dsh.theme` + `html[data-theme]` 属性 + OS 偏好回退（`prefers-color-scheme`），零 RPC 零 store。语言切换可整体照抄该模式：`dsh.locale` + `html[lang]` + `navigator.language` 回退。
- **store 现状**（`web-runtime/src/store.ts`）：zustand vanilla store，`WebStore = { rpcLog, ui, connection }`，ui slice 只有 `rpcLogOpen`。语言态落点有两个可用先例：我们 theme 的店外单例，或照 chat 进 zustand（§3 按 chat 口径取后者，分叉留 §7-4）。
- **构建**：`apps/web` vite + `@vitejs/plugin-react`，workspace 包 alias 到 src 直编。引任何 i18n 运行时库都会进 browser bundle；vite 对 JSON import / 动态 import 分包支持完备，字典按 locale 拆 chunk 无障碍。
- **仓库双语文档体系**（`docs/i18n/`）：`.zh.md` + `.i18n.yaml` 配对是**文档源码翻译流水线**（构建期、面向 docs/ 前缀、走 `dsh-translate-docs`），与 web 产品文案的**运行时 i18n** 完全两套——详见 §5。

## 2. deepseekchat（deepsuite-frontend）i18n 实现侦察

> 用户口径：不做通用选型对比，**读 chat 的实现、照它设计**。侦察对象：`/weka-hg/prod/deepseek/permanent/ys/private/workspace/gitlab/deepsuite-frontend`，核心在 `packages/i18n`（运行时 + ds-i18n 代码生成 CLI）与 `packages/app-kit-web`（locale 状态托管）。

### 2.1 库还是自研 → **自研**

上游不用 react-i18next/intl/lingui。`@deepseek/i18n` 是内部包，两半构成：

- **运行时 ~490 行**（`src/locale.ts` 310 行是 82 语的 locale 常量/BCP47 映射/语言名标签；`utils.tsx` 是 `%s/%d/%r` 占位符格式化器；`load.ts` 32 行是多包字典懒加载注册中心；`transform.ts` 是字典后处理钩子）。**运行时依赖只有 react（peer）**——package.json 里的 @lylajs/node、@vercel/kv 等全是 CLI 侧（从飞书表格拉文案的 codegen 工具链），不进浏览器 bundle。
- **`ds-i18n` 代码生成 CLI**：从飞书 sheet 拉文案，往各业务包 `src/i18n/` 生成每语言一个字典文件 + `state.ts` 运行时接线（app/module 两种模板）。

### 2.2 字典组织

- **每 app/package 一个 `src/i18n/` 目录**，每 locale 一个文件（chat app 有 82 个 `<locale>.tsx`），包级自治（http、auth、chat-sdk、file-error-code 各自带 i18n 目录，`addLocaleLoader` 把 app+各包的字典聚合、可用语种取交集）。
- **zh_CN 是基准字典**：`export const zh_CN = {...}`，`export type I18n = typeof zh_CN`；其余语言钉 `export const en_US: import('./zh_CN.js').I18n = {...}`——**漏译/多译/参数不齐=编译错**，parity 门禁就是 tsc。
- **key 是 flat 驼峰 + 功能前缀**（`chatInputNewChatButton`、`avatarMenuSettingsDialogThemeItemLabel`），无嵌套 namespace；chat app 约 290 key。
- **条目值 = string 或箭头函数**：`dragFileDescGeneral: (arg1: number, arg2: number) => `最多 ${arg1} 个，每个 ${arg2} MB``——插值直接是 TS 函数（codegen 从飞书模板串转出），富文本条目返回 ReactNode。

### 2.3 组件消费形态

`const t = i18n.useTranslate()` → **返回整本当前语言字典对象**，消费是 `t.key` 属性访问（非 `t('key')` 调用）；带参条目直接函数调用 `t.inputLengthTooMuchToast(n)`。富文本另有 `i18n.translateComponent.contactSupport $1={<ContactLink/>}`（Proxy 按需生成组件，`%r` 占位收 ReactNode props）。类型安全满格：key 拼错、参数错全是编译错。

### 2.4 语言切换与持久化

- **preference 与 resolved locale 分离**：存的是 `AppLocalePreference = AllLocale | 'system'`，默认 `'system'`；resolve 时 `'system'` → `chooseBestLocale(navigator.language, availableLocales)`（BCP47 映射表 + 词部交集打分 + en_US 兜底），显式选过就钉住。
- **状态住 zustand app store**（app-kit-web）：`localePreference` 一个字段 + `setLocalePreference` action；localStorage key `__appKit_${appId}_localePreference`（带版本化 storage handle）；`useLocale()` = zustand selector + 按 preference 记忆化 resolve。
- 切换时同步写 `document.documentElement.lang`（BCP47 反查）+ eventbus 广播；82 语的非内置字典按 locale 懒加载（webpackContext 动态 import，500ms 超时回退英文），zh_CN/en_US 两本打进主包。

### 2.5 TS 类型化程度：满格

`I18n = typeof zh_CN` 单点推导一切：其他语言文件钉该类型、`t.key` 编译期检查、插值参数类型来自函数签名、translateComponent 的 props 类型由 `Parameters<T>` 映射生成。**没有任何运行时 key 校验**——全靠编译期。

### 2.6 服务端文案与日期 locale

- **服务端错误 = 错误码→key 映射**：`file-error-code` 包先例——`error${code}` 拼 key 查字典、miss 落 `default` 条目。服务端只下发 code，文案本地化完全在 client 侧。**这正是我们 RpcError（code 闭合 + details 结构化）预埋 formatRpcError 的同构物**（§4/§6-3）。
- **日期用 dayjs**（非 Intl）：app-kit locale 插件维护 82 语→dayjs locale 映射表、按需懒加载 dayjs locale 数据；`date-locale` 包放 locale→format string 表。选 dayjs 是 82 语统一格式控制的需要。
- **`@deepseek/ui` 组件库（web-components 将来要 vendor 的）走 LocaleProvider context**：DatePicker 等收 `Locale`（`zh_CN`/`en_US` 命名）经 `LocaleProvider` 注入，词表（zhCN/enUS 对象）在 ui 包内。**联动点：我们的 locale 状态将来要能直接喂它**。

### 2.7 备考：通用选型对比（已按用户口径砍，压缩存档)

曾做 react-i18next/react-intl/lingui/自研四路对比（结论：按我们 50 条/2 语/零富文本的需求边界，三库差异化能力均用不上，推荐自研查表）。上游 chat 的实现恰好印证：**DeepSeek 自家 82 语生产产品也是自研查表 + `typeof zh_CN` 类型钉**，未引任何 i18n 库。该结论与「照 chat 设计」同向，无冲突；若将来照抄面扩大（如需 `%r` 富文本、82 语级动态加载），直接 vendor `@deepseek/i18n` 即可，不必回头引第三方库。

## 3. 适配设计：chat 形态 → 我们仓（「它的 X → 我们的 Y」）

原则：**形态照抄 chat，规模照我们的现实裁**——它 82 语/290 key/多包聚合/飞书 codegen，我们 2 语/50 key/单包/手写字典。裁掉的只是规模件（codegen、懒加载、多包注册中心），**不是形态件**（字典类型钉法、t.key 消费、preference 分离这些全保留）。

### 3.1 适配总表

| chat 的 X | 我们的 Y | 裁剪理由（规模差异） |
| --- | --- | --- |
| `packages/i18n` 运行时（locale 常量/占位符格式化/load 注册中心/transform） | **不 vendor 包，先抄形态**：web-ui 包内 `src/i18n/` 手写 ~60 行（见 3.2） | 82 语 locale 表 310 行、多包聚合 load.ts、`%s/%r` 格式化器服务于飞书 codegen 产的模板串——我们手写 TS 字典直接用箭头函数插值，格式化器整个不需要 |
| `ds-i18n` CLI（飞书 sheet → 82 个字典文件） | **无 codegen，手写 zh/en 两文件** | 50 key 双语手写成本低于维护 codegen；无飞书文案源 |
| 每 locale 一文件：`zh_CN.tsx` 基准 + `en_US: I18n` 钉型 | **原样照抄**：`locales/zh_CN.ts` 基准 + `locales/en_US.ts` 钉 `import('./zh_CN.ts').I18n` | 形态件，零裁剪（文件名跟它的 locale 命名 zh_CN/en_US，为 §2.6 的 @deepseek/ui LocaleProvider 联动省一次映射） |
| `I18n = typeof zh_CN`，条目 = string 或箭头函数 | **原样照抄**（我们的富文本条目为零，v1 全 string/`(n)=>string`） | 形态件；`%r` ReactNode 插值和 translateComponent Proxy 我们没有富文本需求，不抄 |
| `t = i18n.useTranslate()` 返回整本字典，`t.key` 属性访问 | **原样照抄**：`const t = useTranslate()`，`t.sendButton`、`t.rpcLogCount(n)` | 形态件，零裁剪 |
| key flat 驼峰 + 功能前缀（`chatInputNewChatButton`） | **原样照抄**：`inputBarSend`、`sessionListEmpty`…（前缀按功能域不按组件文件，经得起组件重写红线） | 形态件，零裁剪 |
| `AppLocalePreference = AllLocale \| 'system'`，preference 与 resolved 分离 | **原样照抄**：`LocalePreference = 'zh_CN' \| 'en_US' \| 'system'`，默认 `'system'` | 形态件；AllLocale 收窄为两语 |
| `chooseBestLocale`（BCP47 映射 + 词部交集打分） | **裁成前缀匹配**：`navigator.language` 以 `zh` 起头 → zh_CN，否则 en_US | 打分算法服务 82 语近似匹配；两语时前缀判断等价 |
| locale 状态住 zustand app store（`localePreference` 字段 + action） | **进我们 zustand ui slice**（web-runtime store 加 `ui.localePreference`）+ `setLocalePreference` intent | chat 先例压过我们 theme 的「店外单例」先例——照 chat 口径进 store；theme 不动 |
| localStorage `__appKit_${appId}_localePreference`（版本化 handle） | **`dsh.locale`** 存 preference（`'zh_CN'`/`'en_US'`/`'system'`；`'system'` 可不写键位） | 命名对齐我们 `dsh.theme` 惯例；无多 app 共存问题，不需要 appId 前缀与版本化 handle |
| 切换写 `document.documentElement.lang`（BCP47 反查） | **原样照抄**：zh_CN→`zh-CN`、en_US→`en-US` 两行映射 | 形态件 |
| 82 语字典 webpackContext 懒加载 + 500ms 超时回退 | **不做**：zh/en 两本随主 bundle | 两本字典 ~几 kB，懒加载净负收益 |
| 日期：dayjs + 82 语 locale 映射懒加载 | **不引 dayjs**：formatRelative 文案进字典、`toLocaleTimeString(bcp47)` 用平台 Intl | dayjs 服务 82 语统一格式控制；两语用平台 Intl 足够。将来 vendor @deepseek/ui 若其组件内部要 dayjs，那是 vendor 决策的一部分，不由 i18n 先引 |
| 服务端错误：错误码 → `error${code}` key 查字典（file-error-code 先例） | **v1 不做，预埋 `formatRpcError()` 单点**（§4）；将来照 file-error-code 形态实现 | 范围边界（§4），非形态分歧——上游先例恰好确认了预埋方向 |
| `@deepseek/ui` LocaleProvider context | v1 不需要（无 vendor 组件）；**联动预留**：我们的 resolved locale 就是它的 `Locale` 类型取值（zh_CN/en_US 命名已对齐），届时 `<LocaleProvider locale={locale}>` 直接包 | web-components vendor 里程碑的事，本设计只保证取值同源 |

### 3.2 落点与形态（适配后的最终样子）

```
packages/client/web-ui/src/i18n/
  locales/zh_CN.ts   ← 基准：export const zh_CN = {...}; export type I18n = typeof zh_CN
  locales/en_US.ts   ← export const en_US: import('./zh_CN.ts').I18n = {...}
  index.ts           ← LocalePreference 类型、resolve(preference)、useTranslate/useLocale
```

- **`useTranslate()` 内部**：从 zustand ui slice 读 `localePreference`（web-ui 已直接 `useStore(store, selector)`，同 rpcLogOpen 的消费线），resolve 成 `'zh_CN' | 'en_US'`，返回对应字典对象。resolve 结果按 preference 记忆化（照抄 chat 的 memoizedLocaleResult，两语场景就是个两键 cache）。
- **`setLocalePreference(p)` intent**（web-runtime intents.ts 惯例）：写 store + localStorage `dsh.locale` + `document.documentElement.lang`。
- **非 React util（formatRelative）**：显式收 resolved locale 参数，由调用组件 `useLocale()` 后传入（不偷读 store——LogRow/SessionListItem 按 tick 重渲染，偷读会让切语言的旧文案残留到下一 tick）。文案串从字典取；`toLocaleTimeString('zh-CN')` 硬编码换成按 locale 的 BCP47。
- **切换控件**：sessions 侧栏头部挨着 ThemeToggle 加 LocaleToggle。chat 的设置项是三态下拉（跟随系统/中文/English，LOCALE_LABELS 做展示名）；我们 v1 没有设置页，先做二态循环按钮（zh↔en，点击即离开 system 态），设置页出现时再对齐三态下拉（§6 台账）。

### 3.3 新增依赖清单（给用户过目）

**零新增 npm 依赖。** 照抄的是 chat 的形态不是它的包：@deepseek/i18n 运行时的浏览器侧依赖本来就只有 react（peer，我们已有）；我们裁掉 codegen/82 语/懒加载后，剩余形态件（字典钉型 + useTranslate + resolve）手写 ~60 行进 web-ui，dayjs 不引（两语用平台 Intl）。将来若 vendor @deepseek/i18n 包本体（触发条件见 §6-5'），届时再按 vendor 流程报依赖。

## 4. 范围边界

**v1 做**：web-ui 全部静态文案（§1.1 那 ~50 条）中/英双语；`dsh.locale` 持久化 + navigator 检测 + `html[lang]`；LocaleToggle；formatRelative 的 locale 化。

**v1 不做（host 下发内容三档，对应 §1.2）**：

- **RpcError**：v1 照现状渲染英文 `message（code）`。预埋一条：三处渲染点收拢过一个 `formatRpcError(error, t)` helper（v1 它就是拼串），将来 code→字典本地化只改这一个函数（§6-3）——实现形态照上游 file-error-code 先例（`error${code}` 拼 key 查字典、miss 落 default，§2.6）。
- **agent-error 帧**：永久透传，不属于翻译面（任意运行时错误串）。
- **tool 卡 view.title/description**：不译。开放集合，本地化要动 host presenter 契约（dsh-tools presentation + 所有 presenter），血辐射进 host 属地；明确记录不预埋（§6-4）。
- **日期/相对时间**：v1 即做（就在那 50 条里），格式化能力只用平台 `Intl`，不引数据包。
- **cordis 插件文案（一句预留）**：将来 `ctx.ui.registerSlot()` 线落地后，插件 UI 文案由插件自带字典、经 DSHClientProxy 注册面挂进同一 i18n 运行时——上游 `addLocaleLoader` 多包字典聚合（app+packages 交集可用语种）就是这个问题的现成形态（§2.2）；v1 字典保持 flat key 不排斥前缀避撞，不实现任何注册面。

## 5. 与仓库双语文档体系的关系

一句话划清：`docs/` 的 zh/en 配对（`.zh.md` + `.i18n.yaml`，dsh-translate-docs 流水线，doc-sync 门禁）是**构建期的文档源码翻译**；web 字典是**运行时的产品文案资源**——生命周期、工具链、门禁三不同，互不引用互不复用。唯一的交集是术语：web 文案写 en 版时**查 `docs/i18n/terminology.md` 对齐既有译法**（如 session 不译），只作参考不挂门禁。

## 6. 妥协台账（三段式）

| # | 触发条件（具体到事件） | 返工点 | 预埋要求 |
| --- | --- | --- | --- |
| 1 | 语种扩到第 3 语及以上（尤其复数复杂语系） | 手写字典/前缀检测不够：resolve 换回 chat 的 `chooseBestLocale` 全量算法、字典可能需懒加载 | 字典文件名/locale 命名已照 chat（zh_CN/en_US 制），扩语种=vendor `@deepseek/i18n` 包本体接回它的 82 语基建，形态零迁移 |
| 2 | 字典条目破 ~200，或出现非开发者译员/文案外部源（如飞书表格） | 手写双文件不可持续，需接 codegen | 字典保持 chat 生成物同构（flat key、string/箭头函数值），ds-i18n 的模板产物可直接替换手写文件 |
| 3 | 用户反馈英文错误不可读，或产品化验收要求错误本地化 | RpcError 渲染改 code→字典查表（code 闭合 + details 结构化，client 端即可完成；形态照 file-error-code 先例） | v1 三处渲染点收拢过 `formatRpcError()` 单点（不散内联拼串） |
| 4 | 产品决定 tool 卡对非英语用户完整本地化 | host presenter 契约改造（dsh-tools presentation 加 locale 面或结构化 title），跨属地 | **明确不预埋**——代价记录在案：届时是 host 属地的契约变更，先改契约文档再实现（conventions §5） |
| 5 | `ctx.ui.registerSlot()` 插件线落地且首个带 UI 的插件出现 | i18n 运行时加插件字典注册面 + 生命周期（插件卸载即撤）——上游 `addLocaleLoader` 多包聚合就是这个问题的现成答案 | v1 字典保持 flat key（插件届时用前缀避撞或走 addLocaleLoader 式聚合）；此外零实现 |
| 6 | vendor `@deepseek/ui` 组件（web-components 里程碑）落地 | 其组件文案/日期格式走它的 LocaleProvider；若组件内部拖 dayjs，vendor 决策一并裁 | resolved locale 取值已与其 `Locale` 类型同名（zh_CN/en_US），届时 `<LocaleProvider locale={...}>` 直接包，零映射 |
| 7 | 设置页出现 | LocaleToggle 二态循环按钮换成 chat 式三态下拉（跟随系统/简体中文/English） | preference 三值（含 'system'）v1 即建模，UI 只是换控件 |
| 8 | 切换语言瞬间，仅消费 formatRelative 的行未即时刷新被用户感知 | 相关组件补 `useLocale()` 订阅 | v1 已按显式 locale 参数接线（§3.2），此条实际已消化，列此备查 |

## 7. 分叉清单（留用户拍，均给推荐但不替拍）

1. **照抄深度**：A 抄形态不抄包——web-ui 内手写 ~60 行，零新依赖（§3 推荐）｜B 直接 vendor `@deepseek/i18n` 包本体（82 语基建即刻可用；代价是拖进 `%s/%r` 格式化器、load 注册中心等我们当前用不上的面，且 vendor 流程成本现在就付）。
2. **v1 范围**：A 仅 web-ui 静态文案（推荐，host 内容三档全按 §4 处理）｜B 连带做 RpcError code 本地化（file-error-code 先例现成、结构已具备；代价是首刀就伸进错误语义面）。
3. **默认语言**：A 照 chat 的 `'system'` 默认（navigator 检测，zh 前缀→中文否则英文；推荐——preference 三值建模 v1 即含 system 态）｜B 固定默认中文（当前用户群单一；system 态仍建模只是不当默认）。
4. **locale 状态落点**：A 照 chat 进 zustand（我们 web-runtime store 的 ui slice + setLocalePreference intent；§3 推荐——chat 先例压过 theme 店外先例）｜B 照我们 theme 模式店外单例 + useSyncExternalStore（与 dsh.theme 完全同构；代价是与上游形态分道）。
5. **key 命名制**：照 chat flat 驼峰 + 功能前缀（`inputBarSend`）——chat 唯一制，无分叉，仅确认。
