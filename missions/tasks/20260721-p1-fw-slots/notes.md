# fw-slots 实现档案（ui-slots → ui-primitives → ui-theme → i18n）

> owner: fw-slots（常驻）。契约=api-contracts v3 §1（ui-slots）/§8（primitives/theme/i18n）。本文=实现计划+进度台账；开工令（T0 完成广播）前不动 packages/。

## 0. 状态

- [x] 权威文档通读（api-contracts v3 / architecture / dispatch v2.1 / conventions / t0-checklist）
- [x] T0 完成广播 → 开工 ui-slots
- [x] ui-slots 真实现 + 测试（b33823486；T1 已回执）
- [x] ui-primitives 第一批：StateDot/Button/Pill/Input/Menu/ConnectionBanner 去 legacy/JsonBlock token 化（f18100b05）
- [x] ui-theme：ThemeService+client 半边+node 空 apply（166f667b9）
- [x] i18n：I18nService+zh/en 空字典+client 半边（a86df5bbd）

### 收尾批（2026-07-22 凌晨，figma-flows 供数到位后）

- [x] StateDot 按 figma 规格重做（28c2f4e18）：实心三态=10×10 同色 10% halo+6×6 实心核（currentColor 双层）；ongoing=SVG 1px inside-stroke 渐变环（handle (0.1,0)→(0.85,1)，figma 无动画定稿→自定 rotate 1s linear infinite）；蓝环无 alias，组件级 `--dsh-state-ongoing: var(--dsw-static-deepseek-450)`。
- [x] 图标族落库（234d4d925）：批 A=43 个 deepsuite JSX 镜像（脚本抽取加 {size,className} props，native size 以 svg 根标签为准——IconWarningOutline16 实为 14px native；IconLoadingOutline16 的 foreignObject conic-gradient 硬编码 rgba 替换为纯 arc path currentColor）；批 B=5 个 figma 提取件（api/personalization/project_add/folder_open/folder_close）。66 测全绿。抽取脚本存 .artifacts/fw-slots-extract-icons.mjs（一次性，不入库）。
- [x] markdown 三件 mv 到 ui-conversation/src/chat/（裁决归 convo-b）——**注**：我的 staged renames 被 f5237d480（他人文档刀）一并带走，rename 已正确入库但没单独成刀；已报备 main。

### 待办：ClientContext 跟改（v3 §4.0 仲裁 42ce863bf；等 rt-core runtime 刀导出 ClientContext 后执行，main 会叫）

- ui-theme src/index.ts：`declare module 'cordis' { interface Context { theme } }` → `declare module '@deepseek-ai/dsh-client-runtime' { interface ClientContext { theme } }`；client/index.ts 的 apply 签名 `ctx: Context` → `ctx: ClientContext`（import type from runtime）。
- i18n 同款两处（服务键 i18n）。
- 两包 package.json 各加 runtime type-only devDep（§4.0 豁免：§0.2 零依赖旁路=零运行时依赖）。
- 跟改后各包 tsc+测试重跑；commit 带 pathspec。

### 暗色走查报告（2026-07-22，W5 M1-M3 牵头；fw-slots=token 体系 owner）

**总判**：figma-flows 猜的「组件引 static 绕过 alias」不成立——全 client 组件 CSS 仅一处 static 引用（StateDot 的 --dsh-state-ongoing，有意为之且已注释，蓝环两主题同值合规）。三偏差真因分三类：

| # | 真因 | 证据 | 修法 | 属地 |
|---|---|---|---|---|
| M1a | **暗色截图时选中态已丢**：w5-11 里 details 面板是空态提示（「点击消息流中的工具行查看详情」），根本没有选中行可描边；且 header 会话名在 shot10→11 间从裸 id 变成正式标题（list 刷新到达），疑似 per-scope selection 被重建/清空 | w5-10 vs w5-11 逐像素；probe 步骤序（选中发生在 shot09 前，10 仍在 11 已空） | 交互 bug 复现排查（list 更新→scope/SessionProvider 是否重建） | convo-a/rt-core |
| M1b | **选中描边 token 不随主题翻**：ChatView .callRow[data-selected] 用 --dsw-alias-state-business-primary=deepseek-500 亮暗同值 #3964FE；figma 暗屏 54:42085 stroke=#679EFE=deepseek-400 | design-platform.css L214/L302 | 换 --dsw-alias-button-info-fill（唯一 500→400 翻转的 alias，precisely #3964FE 亮/#679EFE 暗）；或 figma-flows 给上游 stroke 绑定的正名 token | convo-b（ChatView.module.css:42） |
| M2 | **composer 用错 alias**：InputBar .card 底=--dsw-alias-bg-base（暗=950 #151517=页面底）；sidebar 搜索框用 --dsw-specific-input-major（暗=850 #2C2C2E）才是定稿 token。亮色两 token 同为白所以只暗色露馅 | InputBar.module.css:40 vs SidebarRoot.module.css:120；design-platform.css L228/317 | 一行换 token：bg-base→specific-input-major | convo-a（skeleton/InputBar.module.css:40） |
| M3 | **疑为幻影，随 M1a 塌缩**：--dsw-alias-markdown-code-block 暗值=bluish-900 #1B1B1C 正是定稿值（L292 映射存在，壳 dist CSS 与插件 bundle 都含），DetailsPanel .code 用的也是它；而 w5-11 details 是空态没有代码块——报告测到的 #151517 应是面板底(bg-base)。M1a 修复重拍后复核；若仍偏再查注入序 | design-platform.css:292；DetailsPanel.module.css:80；w5-11 空态 | 无需改 token；重拍验证 | 判定组重测 |

**走查副产物（token 审计，全 client CSS used-vs-defined 差集）**：
1. `--dsw-alias-border-l` **未定义**（表里只有 border-l1..l4），5 处引用全在 ui-conversation/skeleton（ConversationRoot:17/DetailsPanel:10,20/EmptyState:40/InputBar:38）——未定义 var 使 border-color 塌回 currentColor（文字色描边，恰好可见所以一直没炸）。应改 border-l1 或 l2（convo-a）。
2. `--dsw-font-family-code` 未定义（base.css 定义的是 **--ds**-font-family-code 无 w），web/AppRoot.module.css:62 引用（带 fallback 栈故未坏）——ui-shell 改字名即可。
3. web/AppRoot.module.css:10 `var(--dsw-alias-bg-base, #f9fafb)` 带硬编码 hex fallback（boot 先于 token 的权宜？ui-shell 自裁）。

### 精调波次·两件低档落点判定（2026-07-22）

| 件 | 现状 | 定稿 | 落点与修法 | 属地 |
|---|---|---|---|---|
| L2 搜索框亮底 | ui-sidebar 自家 .search（SidebarRoot.module.css:120）用 --dsw-specific-input-major（亮=bluish-00 #FFFFFF，暗=850 #2C2C2E）；**未用 primitives Input 组件** | 亮 #F1F3F5（=bluish-75）+黑@10% 描边；暗 #1B1B1C（=bluish-900）+白@12% | 表内无「亮75/暗900」alias 对；最近的 specific-login-input 暗端精确 #1B1B1C、亮端 #F9FAFB 差一档。需 figma-flows 给上游搜索框绑定的正名 token（或确认 login-input 从宽） | ui-side 改用法+figma-flows 供名 |
| L3 发送钮 | InputBar .primary（skeleton/InputBar.module.css:133）用 button-primary-fill=brand-primary=亮黑 #0F1115（disabled op.4 over 白 ≈ 实测 #9E9FA0 灰）| 恒品牌蓝 #3964FE、空文本 op0.4、暗 #679EFE | fill→--dsw-alias-button-info-fill（亮 deepseek-500 #3964FE/暗 400 #679EFE 双端精确），hover→button-info-hover；disabled op0.4 已对不动。顺带修掉暗色发送钮 #43454A 偏差 | convo-a（InputBar） |

primitives 自查：Button primary 变体用 button-primary-fill 是通用主按钮正色（New Session 白/黑体系），不动；Input 原子件 fill=bg-layer-1，待 style-spec 对账定论。

### 未决尾巴（挂账）

1. **theme computed 变量断言**：jsdom 不算 CSS 级联，留壳级 playwright（W5）。
2. ~~MessageText 旧字号~~ 已结（convo-a 跨属地修 89e3ca091，我 review 认可）：改 font-size/line-height inherit——通用文本原语不钉字号，字级归消费容器（气泡 16/24、assistant 流 16/28）；正是 L1 气泡 3px 残差真凶。
3. 图标补充位：session 树「└」已落（IconTreeCorner8x10，15d2790e0）；鱼 logo 已落（FishLogo，1dc719078——首 path 系提取脚本对非整数 frame 的 bounds 漏网，playwright 三变体实证后删除，figma-flows 复核确认并重写源文件，重写版与落库 path 逐字节一致）；Others 工具行 sparkle 字形在 .artifacts 已有件，要用时再包组件。
4. OwnerProps P-I 形态（Partial<Omit<props,'useSession'>>，inject 键类型层不可知）——README Known Limitations 待补一行（免门禁期宽松）。

## 1. ui-slots（最先，fw-react 阻塞在它）

零依赖包；React 仅 `import type { FC, ReactNode }`。T0 桩=契约照抄，我删桩换真实现，导出面不得偏离 v3 §1。

### 文件清单（顺序即落盘序）

| # | 文件 | 内容 |
|---|---|---|
| 1 | `src/types.ts` | SlotMap（空 interface 供 merge）/SlotKind/SlotScope/SlotEntryDef/SessionBinding/RootBinding/SessionAccess/InjectFactory/SlotSpec/SlotOptions/SlotEntry/ScopedSlots/RenderOpts/OwnerProps |
| 2 | `src/core.ts` | SlotCore 类（全部行为逻辑） |
| 3 | `src/index.ts` | re-export 两件；无实现代码 |
| 4 | `tests/core.spec.ts` | 三型语义矩阵 + 订阅合批 + disposer |
| 5 | `tests/types.spec.ts` | 类型负样本（@ts-expect-error） |

### SlotCore 内部结构

```
Map<key, { spec, entries: SlotEntry[], version: number, listeners: Set<() => void> }>
mutateListeners: Set<(key) => void>          // onMutate 桥（runtime SlotsService 挂 ctx.emit）
pending: Set<key> | null                      // 微任务合批缓冲
```

- `define(key, spec)`：重复 define 同 key=throw（single/keyed/list 一律——契约未写但「单占冲突 throw」是全项目基调，若 fw-react 有异议走 main 仲裁）。返回 disposer：删条目+其 entries+bump 通知。
- `register(key, component, options)`：未 define=throw；kind=single 且已有 entry=throw；kind=keyed 且 options.key 重复=throw；kind=list 按 options.order 稳定排序（entries() 时排或插入时排——插入时排，entries() 保持 O(1) 返回缓存数组引用）。返回 disposer=移除该 entry+bump。
- `entries(key)`：返回**缓存的 readonly 数组引用**（uSES 契约：getSnapshot 恒返缓存引用、调用中不计算）——每次 mutation 重建数组并缓存，entries() 纯读。
- `spec(key)`：查 Map，无则 undefined（渲染方判坑是否存在）。
- `getVersion(key)`：未 define 的 key 返回 0（订阅可先于 define——渲染侧可能早于注册侧装载；version 从 1 起跳即可区分）。
- `subscribe(key, fn)`：按 key 挂 listeners；返回退订。**通知=微任务合批**（见下）。
- `onMutate(fn)`：全局 mutation 流（同步逐 key 发，不合批——它是 Service 的 ctx.emit 桥，事件语义要求逐次；合批只属于渲染订阅面）。

### 微任务合批实现思路

镜像仓内 Notifier 模式（architecture §5），但更薄——SlotCore 无「快照重建」，只有 version bump：

```ts
private scheduled = false
private dirty = new Set<string>()

private markDirty(key: string) {
  bump version(key)                    // 同步:getVersion 立即可见新值(uSES 撕裂防护)
  for (const fn of this.mutateListeners) fn(key)   // onMutate 同步逐条
  this.dirty.add(key)
  if (!this.scheduled) {
    this.scheduled = true
    queueMicrotask(() => this.flush())
  }
}
private flush() {
  this.scheduled = false
  const keys = [...this.dirty]; this.dirty.clear()
  for (const k of keys) notify listeners(k)        // listener 快照副本遍历,防退订自打
}
```

要点：
- **version 同步 bump、通知微任务合批**——uSES 的 getSnapshot（fw-react 侧= getVersion）必须在通知到达时已读到新值；同一微任务内 N 次 register 对同一 key=1 次通知。
- flush 中 listener 抛错不吞其他 listener：逐个 try/catch？——**不**，仓规「An empty catch names what it swallows」；采用复制集合遍历+让错误自然冒泡到微任务边界（单 listener 抛错中断同 key 剩余通知是可接受语义，ErrorBoundary 在渲染层兜；若 fw-react 实测有问题再议）。
- flush 期间新 mutation：dirty 已 clear，新 mutation 重新 schedule——无丢通知。
- disposer 幂等：二次调用 no-op（cordis effect 语义,disposer 可能被收两次）。

### 类型要点

- `SlotOptions` 条件类型按 kind 分三支（keyed 必填 key / list 必填 id / single 仅 inject）——负样本：single 传 key、keyed 缺 key、list 缺 id 各一条 @ts-expect-error。
- `InjectFactory<E>`：scope 条件分发 SessionBinding/RootBinding——负样本：session 坑 inject 里取 RootBinding-only 结构。
- `OwnerProps<E>`：v3 留白「E['props'] 去掉 inject 键与标配注入键」。P-I 实现=`Omit<E['props'], 'useSession'>` 不可行（inject 键 per-注册项动态,类型层不可知）——**采用宽松形**：`Partial` 不对；初版 `OwnerProps<E> = Partial<E['props']> & object`？——不。**决定**：`OwnerProps<E extends SlotEntryDef> = Omit<E['props'], 'useSession' | 'slots' | 't'>`（标配注入键=框架已知白名单，inject 私有键归 owner 不传即可，多传不报错的宽松度靠 Omit 后的 Partial 化避免——具体以 fw-react renderSlot 消费面联调为准，类型不满足处走 main 仲裁）。先按 Omit 白名单版落，负样本盯 useSession 不可由 owner 传。
- runtime 校验只做 define/register 冲突这类注册表自身不变量；不校验 props 形状（同进程 typed seam，仓规禁冗余 runtime 验证）。

### 验收对照（任务书）

- define 前 register throw ✓（矩阵）
- single 重复 throw ✓
- keyed 重 key throw ✓
- disposer 生效（register disposer 后 entries 消失+version bump+通知；define disposer 级联清 entries）✓
- 合批：同微任务 3 次 register=1 通知；跨微任务=2 通知 ✓
- 类型负样本 expect-error ✓

## 2. ui-primitives（零 cordis 纯 React）

T0 刀2 会把 `web-ui/src/components/*`（ConnectionBanner + conversation/{MessageText,JsonBlock,ToolCallCard,toolViewCards,toolCardRegistry}）git mv 进来，我接手改造。

文件计划：
1. `src/StateDot.tsx` + `.module.css`——四态 `state: 'ok' | 'warn' | 'ongoing' | 'error'`（绿/琥珀/蓝环/红——**颜色一律 var(--dsw-*)**,具体变量名问 figma-flows,不 hardcode #22C55E 等）。ongoing=环形（figma:蓝环）其余实心点。
2. `src/icons/`——ic_ds_* SVG 族:问 figma-flows 要节点数据后生成;统一 `<Icon name size>` 或逐图标组件（待拿到数据定,倾向逐组件+index 桶,tree-shake 友好）。
3. `src/{Button,Pill,Menu,Input}.tsx` + module.css——原子件,只吃 props+token vars;Menu 无 portal 依赖（纯 CSS 定位,P-I 够用;不引组件库）。
4. markdown 族改造：迁入件逐个过——去掉旧 token（--bg-* 等）换 --dsw-*;去掉对旧 hooks/registry 的 import（若有→改 props 注入或 .legacy 待 convo-b 认领,以 T0 降级台账为准）。
5. `tests/state-dot.spec.tsx`——四态渲染断言（class/attr 断言,不截图）。

顺序：StateDot（ui-side 要）→ Button/Pill/Input → Menu → icons（等 figma-flows 供数,可与前面并行发问）→ markdown 族改造（最重,放最后;convo-b T2 才用到）。

## 3. ui-theme

- T0 已把 cssdesign 两份 CSS 拷入 `src/styles/`（design-platform.css 326 行 + gradient-shadow-text.css 224 行;dark=body[data-ds-dark-theme] 三段覆写块）。
- `src/theme-service.ts`：`ThemeService { register(id, tokens): ()=>void; apply(id): void; current(): string }`
  - 内置两主题 id：`light`/`dark`（P-I 唯二;register 供第三方=覆写 alias 变量,P-I 只实现注册表账本+重复 id throw,变量注入面到用时再展开——契约只要 register 存在且单占 throw）。
  - `apply(id)`：dark→`document.body.setAttribute('data-ds-dark-theme','')`;light→removeAttribute。未注册 id=throw（fail loud）。`current()` 返回账面值（初始 light）。
  - cordis 插件半边：client apply 挂 `ctx.theme`（Service;immediately 组）。**注意**:两份 base CSS 由 web 壳直接引入（v3 §8）,不归我注入——我只管属性切换与注册表;与 ui-shell 的对界=styles/ 文件住我包,壳 import。
- **两坑处理**（t0-checklist 钉的）：
  1. `--dsw-font-family`/`--ds-font-family-code` 缺 base 定义——T0 说「拷入时补一份 base 定义文件」,先查 T0 是否已补 `src/styles/base.css`;没补则我补（变量值问 figma-flows,代码字体栈末位不放 monospace——architecture §15）。
  2. 少三个 alias 变量（button-link-fill/hover、亮色 state-success-tertiary）——不主动补;组件用到前问 figma-flows。
- `tests/theme.spec.ts`：apply('dark') 后断言 body 属性存在+某 alias 变量 computed 值翻转（jsdom 不算 CSS 级联——**改为**:属性断言 + register 重复 throw + current() 演化;computed 变量断言留给壳级 playwright,记台账）。

## 4. i18n

- `src/i18n-service.ts`：`I18nService { register(ns, locale, dict): ()=>void; bind(ns): Translate; locale: SnapshotStore<string> }`
  - `locale` 用 web-react 的 `createSnapshotStore<string>('zh')`（t0 表:i18n 依赖 web-react 正为此）。
  - 字典账:`Map<ns, Map<locale, dict>>`;register 返回 disposer;同 (ns,locale) 重复 register=throw（单占基调）。
  - `bind(ns)` 返回**引用恒定**的 Translate（架构 §15:可进注入面）——闭包读 locale store 当前值+fallback 链（locale→zh→key 原样返回）;params 插值 `{name}` 形。
  - locale 切换整树重渲染由消费侧订 locale store 实现,Translate 本体不订阅。
- zh/en 空结构起步:`src/locales/{zh,en}.ts` 空字典+类型位。
- `tests/i18n.spec.ts`：register/bind/fallback/params/locale 切换后 t 输出翻转。

## 5. 横向纪律自查单（每包收尾过一遍）

- 注释英文、只留非显然契约;不引 missions。
- CSS 零 hardcode 色值/阴影/渐变;禁 :global。
- commit pathspec 只圈 `packages/client/{ui-slots,ui-primitives,ui-theme,i18n} missions/tasks/20260721-p1-fw-slots`;`--no-verify`;无 co-auth 尾注;不 push。
- 每个可编译单元落盘即回执 main。

## 6. 待问/待仲裁记录

| # | 事项 | 对象 | 状态 |
|---|---|---|---|
| 1 | StateDot 四色的 --dsw-* 变量名 | figma-flows | 待开工时问 |
| 2 | ic_ds_ 图标族节点数据 | figma-flows | 待开工时问（提前批量要） |
| 3 | OwnerProps 的标配注入键白名单终形 | fw-react 联调/main | ui-slots 落桩后同步 |
| 4 | --dsw-font-family base 定义值（若 T0 未补） | figma-flows | 开工 ui-theme 时查 |
