# T0 骨架刀执行清单（预起草 2026-07-21 深夜；等用户开工令后照单执行）

> 依据：dispatch §0 + api-contracts v3（含 2026-07-21 两处修订：§3.1 纯度附注✅已落、immediately=先行装载组✅已落）。执行者=主会话。验收=全仓 `pnpm run typecheck` 绿。
> 已拍板前提：旧版不再合并、不看别的 worktree（四件基建按契约全新实现）、未映射旧文件挪 `.artifacts/legacy-web/`（gitignored=git 层删除）、cssdesign 两份 CSS 搬进 ui-theme、8 包全带 dshClient（基建四包 immediately:true）。

## 0. 前置已完成

- [x] v3 §3.1 apiproxy 纯度附注（commit 1d86c08b1）
- [x] immediately 语义修订两轮+architecture 对齐（121d5a11d/4ffc2b62e）：先行装载组=动态 bundle 并行先装，全组就位再装 layout 等；loader 机件壳静态持有；bundle 导出面登记模块表

## 1. 刀序（conventions #4 分刀）

1. **刀1 骨架新建**：12 包 package.json/tsconfig/src/index.ts 契约桩/README + tsdown preset 模板 + workspace 依赖
2. **刀2 纯 git mv**：v3 §11 映射 + apps/web→packages/client/web（不改内容，保 rename 检测干净）
3. **刀3 机械改写+接线**：import specifier 改写、.legacy 降级、tsconfig.base paths、vitest 清理
4. **刀4 attic 清场**：未映射件磁盘拷入 .artifacts/legacy-web/ 后 git rm；删空的 web-runtime/web-ui 包壳

## 2. 十二包骨架表

目录=packages/client/<dir>；包名=@deepseek-ai/dsh-client-<dir>；全部 private、ESM、license BSD-3-Clause，样式照抄现有 client 包（main/types/exports/files 结构）。

| dir | dshClient | 初始内容 | 依赖（workspace 除注明外） | v3 节 |
|---|---|---|---|---|
| ui-slots | — | 契约桩（SlotMap/SlotCore/ScopedSlots 类型族） | react(type-only devDep) | §1 |
| ui-primitives | — | 桩 index + 刀2 接收 components/ markdown 族 | react、clsx | §8 |
| web-react | — | 契约桩（store 子路径+主入口） | ui-slots、zustand、immer、react；cordis peer | §2 |
| connection | immediately | 刀2 接收 wire 消费层六件（不 import cordis） | dsh-host-apiproxy、dsh-session、dsh-llm、dsh-tools | §3 |
| runtime | immediately | 契约桩（SlotsService/SessionsService/ClientLoader/scopeOf）+ 刀2 接收 session/* → src/sessions/、boot.ts → src/kernel/ | ui-slots、web-react、connection；cordis peer+dev | §4 |
| ui-layout | ✓ | 契约桩（LayoutService/AppFrame 空组件/SlotMap merge 三坑） | runtime、web-react、ui-slots、ui-primitives、react | §5 |
| ui-sidebar | ✓ | 契约桩（SidebarRoot 空组件） | 同上 | §6 |
| ui-conversation | ✓ | 契约桩（ConversationService/ToolViewRegistry/ViewMap）+ 刀2 接收 sessiontabs/conversation/* | 同上 + i18n | §7 |
| ui-trajectory | ✓ | 契约桩（ViewMap merge 两条+占位组件；零 service） | ui-conversation、web-react、react | §8 |
| ui-theme | immediately | 契约桩（ThemeService）+ **cssdesign/ 两份 CSS 拷入 src/styles/**（missions 原件留作设计档案）。⚠figma-flows 预热发现两坑：①`--dsw-font-family`/`--ds-font-family-code` 被两份 CSS 引用但未定义（上游住 theme/global.css）——T0 拷入时补一份 base 定义文件；②比上游少 `--dsw-alias-button-link-fill/hover` 与亮色 `--dsw-alias-state-success-tertiary` 三变量，组件用到链接色/成功浅底前先问 figma-flows 补值 | — | §8 |
| i18n | immediately | 契约桩（I18nService/Translate） | web-react（locale store） | §8 |
| web | — | 桩壳（boot 骨架/AppRoot loading 页占位）+ 刀2 接收 apps/web 的 vite/index.html | 12 包中的基建+纯库、react-dom、vite devDep | §9.3 |

桩纪律：v3 对应节接口全文照抄成类型+类骨架，方法体 `throw new Error('P-I stub')`；README=一句话职责+v3 节号。dshClient 写进 package.json（inject 按 v3 §0.2 依赖向：四 UI 包 inject 基建 service 提供者；基建四包 immediately:true）。UI 插件八包补 `"exports": { "./client": "./dist/client.js" }` 与空 node 半边 apply。

## 3. 刀2 git mv 映射执行表

| 源 | 去向 | 备注 |
|---|---|---|
| web-runtime/src/{connection,api,events,intents,web-api-client,fixture}.ts | connection/src/ | 同批同居，相对导入天然存活 |
| web-runtime/src/session/* + store.ts | runtime/src/sessions/ | store 并入评估归 rt-core，先随迁 |
| web-runtime/src/boot.ts | runtime/src/kernel/boot.ts | 「改造」归 rt-core |
| web-ui/src/sessiontabs/conversation/* | ui-conversation/src/ | PendingCard 保留现状挂 chat 流 |
| web-ui/src/components/* | ui-primitives/src/ | markdown 族等 |
| apps/web/{index.html,vite.config.ts,src,tsconfig.json} | packages/client/web/ | 包名换 dsh-client-web；apps/cli 依赖跟改 |

## 4. 刀3 机械规则

1. **import specifier 改写**：跨包相对导入 → 新包名导入（如 session/* 引 ../connection.ts → @deepseek-ai/dsh-client-connection）；只改路径不改逻辑。
2. **.legacy 降级**：改写后仍编译红的迁入文件（预期：boot.ts、引用旧 hooks/shell 的容器件）改名 `<name>.legacy.ts(x)` + 包 tsconfig exclude `**/*.legacy.*`——历史连续、typecheck 绿、owner 重做时改回。降级清单记入本文件 §7 台账。
3. **tsconfig.base.json paths**：删旧两条 + 增 12 条；根构建引用图按 §2 依赖列 references。
4. **vitest.config.ts**：删指向 web-ui/web-runtime 旧路径的 coverage 排除条目；test:gui 范围 `packages/client packages/host` 不变（迁移后旧 spec 已入 attic，红名单自然清零；新增桩包无测试=不出现在 coverage 门里也无妨，免门禁期）。
5. rpc-log.ts（D18 删除）与 index.ts（旧聚合出口）不迁——直接进刀4 attic。

## 5. 刀4 attic 清单（.artifacts/legacy-web/，gitignored）

web-ui：shell/、leftmenu/、hooks/、App.tsx、App.module.css、mount.tsx、style/、utils/、use-web.ts、css-modules.d.ts（新包各自带）、index.ts、全部 tests；web-runtime：index.ts、rpc-log.ts、全部 tests。拷入后 `git rm` 源与两包残壳（package.json 等）。「参考重写」的参考源=attic 磁盘件+git log。

## 6. 附属工程件

- **tsdown client preset 模板**：packages/client/tsdown.client.ts——export 工厂（入参 {id}），产出闭包工厂 banner/footer 包装（window.DSHClientProxy.loadPlugin 形状照 v3 §9.1）、external=模块表清单、CSS 内联；四 UI 包 tsdown.config.ts 引用之 + `"watch": "tsdown --watch"` 脚本。T0 只保证模板存在+桩包能跑通一次 tsdown（产物形状对）；DSHClientProxy 运行时实现归 rt-core。
- **verify-client-closure**：T0 落最小版脚本（逐 UI 插件包独立 tsc 其 client 编译单，断言看不见 node 半边 merge）挂 scripts/，不进门禁序列（免门禁期）；完整版归 rt-core 随收编刀。
- 依赖版本：zustand 沿用 ~4.4.7（fw-react 如要升 v5 走契约仲裁）、immer ^10 新增、react 18.2 沿用。

## 6b. 双入口拆分同型修正（T0 后追加,ui-layout 4315d2040 为模板）

T0 骨架桩是单入口；每个 UI 插件包 owner 接手时照 ui-layout 模板拆：实现 git mv 进 `src/client/`（client/index.ts 含 apply+declare merge+导出面）、`src/index.ts`=node 半边空 apply、package.json `./client` 加 types 指 lib/types/client、tsconfig.base 加 `/client` paths 条目、tests 改从 /client 导入。现状：ui-layout✅ ui-theme✅ i18n✅（fw-slots 已随包做）;connection/runtime=rt-core 在途应吸收;sidebar/conversation/trajectory=批次2/ui-traj 任务书已注明。tsdown preset entry=src/client/index.ts 与此对齐;CLIENT_EXTERNALS 用 /client 子路径。

## 7. 执行台账（2026-07-21 深夜执行完毕；四刀=05756560b/db77581da/7258588bb，全仓 typecheck 绿）

- **.legacy 降级清单**（tsconfig exclude `**/*.legacy.*`，owner 重做时改回或删除）：
  - connection/src/intents.legacy.ts（旧 store+manager 单例接线，rt-core 对账后删）
  - runtime/src/kernel/boot.legacy.ts、runtime/src/sessions/store.legacy.ts（rt-core 改造参考）
  - ui-conversation/src/chat/{AssistantMessage,ConversationContainer,ConversationView,InputBar,MessageItem,PendingCard}.legacy.tsx（convo-a/b 平移改注入取数）
  - ui-primitives/src/{ConnectionBanner.legacy.tsx,markdown/{ToolCallCard,toolViewCards}.legacy.tsx,markdown/toolCardRegistry.legacy.ts}（fw-slots 改造；JsonBlock/MessageText 已存活导出）
  - web/src/kernel-boot.legacy.ts（旧 vite main，ui-shell 重写 boot）
- **attic**：.artifacts/legacy-web/{web-runtime,web-ui,apps-web}（磁盘参考；git rm 于 7258588bb——shell/leftmenu/hooks/utils/style/App/mount/rpc-log/index 及全部旧 tests 均在内）
- 接线清理：tsconfig 三件/vitest.config coverage 排除段/vitest.web include→packages/client/web/tests/build:web filter→dsh-client-web/apps-cli 依赖与 resolve/readme-model-experience 12 条目。
- 附带裁决：apps/web 整包并入 packages/client/web（dsh-frontend 名字退役）；ConversationViewMap 的 chat 条目改为接口内联声明（自包 declare-merge 在 tsc -b 下触发 TS6305，convo-a 实现时再定形态）。
