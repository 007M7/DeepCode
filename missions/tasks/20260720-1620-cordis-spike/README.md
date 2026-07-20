# 20260720-1620 cordis-spike：类型强隔离 spike + 双端包形态 PoC

## 任务理解

验证 blueprint-v2 第 2 点（cordis 类型体系在 browser 半边的强隔离）的工程方案。产出是**可行性结论 + 最小 PoC**，不是产品代码。零 commit。

核心命题（用户已定理论框架，本 spike 实证）：

- `declare module 'cordis'` 的 merge 污染是 **program 级**：增补文件一旦进入 tsconfig program 的传递闭包，整个 program 所有文件都看得见（如 node-only 的 `ctx.sessions` 在浏览器代码里"合法"）。
- 拦法 = browser 半边用独立 tsconfig program（file-set 从 browser 入口出发）+ 保持传递闭包干净 + gate 脚本机械验证闭包不含 node 半边文件。
- 已知风险：`import type` 的目标文件**仍进 program**（类型也要解析），所以 shared 层能引用的包必须本身零 node 增补——`import type` 纪律挡不住增补泄漏。

## PoC 方案

放 `missions/tasks/20260720-1620-cordis-spike/poc/`（不进 packages/，不碰在途文件）。

结构：

```
poc/
  echo-a/          双端包：src/node.ts、src/browser.ts、src/shared.ts 三入口
  echo-b/          仅 node 半边的包（有自己的 declare module 'cordis' 增补）
  tsconfig.browser.json   browser program：files/include 从 browser 入口出发
  tsconfig.node.json      node program：从 node 入口出发
  gate.mjs         gate 脚本原型：解析 browser program 文件集，断言与 node 半边清单交集为空
```

实证四件事：

1. **正例**：browser program 里 `ctx.timer` 类型可见（vendor/timer 增补，浏览器安全）；同 program 里写 `ctx.sessions`（dsh-session 的 node 增补）应报 TS2339——负例文件证明它真报错。
2. **负负例**：故意让 browser 半边经级联依赖 import 一个 node 半边文件（echo-a/browser → 某中间文件 → echo-b/node），证明污染发生（`ctx.sessions` 的负例不再报错）——说明光靠纪律不够，gate 必要。
3. **shared import type**：shared 层 `import type` 一个干净类型包（如 apiproxy 的 /api 子路径）不引入污染。
4. **gate 原型**：`tsc --listFilesOnly`（或 ts API）取 browser program 文件集 ∩ node 半边清单 = ∅；对场景 2 的偷渡要能抓出来。

顺手回答：vendor/cordis 本体（零 node import，design.md §A 已核）在 browser program 是否需要 shim/别名，还是原样 import 即可。

## 产出（本 README 末尾补结论）

- 方案可行性：program 隔离 + gate 是否"理论正确"。
- 坑清单。
- gate 脚本转正建议（scripts/ 位置、挂哪个门禁）。
- 三入口 exports 形态建议（PoC 实际用的 package.json exports 布局）。

## 状态

- [x] 第 0 步：本 README 外化方案
- [x] 读 missions/conventions.md、blueprint-v2.md、design.md §A
- [x] PoC 搭建
- [x] 四件实证
- [x] 结论回写（见下）

---

# 【已作废——旧标准产物】第一轮结论（gate 主角方案，被「tsconfig 原生自动生效」验收翻转推翻；实证事实仍有效，方案节以文末 v2 为准）

## 总判定：**方案可行，理论正确**

program 隔离 + gate 的组合成立：browser 半边独立 tsconfig program（file-set 从 browser 入口传递闭包出发）真实挡住了 node 侧 `declare module 'cordis'` merge——`ctx.timer` 可见、`ctx.sessions`/`ctx.echoB` 真报 TS2339；污染确实是 program 级、闭包级的（不是 import 语句级），所以 gate 对闭包做机械断言正好补上纪律挡不住的级联偷渡。

## 四件实证结果

| # | 场景 | tsconfig | 结果 |
|---|---|---|---|
| ① | 干净 browser program：`ctx.timer` 可见 + `ctx.sessions`/`ctx.echoB` 负例真报错 | `tsconfig.browser.json` | **GREEN**（24 repo 文件，清单在 `poc/clean-program-files.txt`）。负例用 `@ts-expect-error` 表达：干净时指令被消费→绿；泄漏时变 TS2578→红，双向 tripwire |
| ② | 负负例：经"无辜中间文件"级联偷渡 echo-b node 半边 | `tsconfig.browser-smuggle.json` | **RED 如预期**：`ctx.echoB` 的 `@ts-expect-error` 变 TS2578（增补真进来了）+ `node:path` TS2591。import 现场毫无异样——证明 gate 必要 |
| ③a | shared 层 `import type` 干净类型包（dsh-brand） | 并入 ① | 不引入污染，GREEN |
| ③b | shared 层 `import type` apiproxy `/api` 子路径 | `tsconfig.browser-apiproxy.json` | **RED——重要发现**：`/api` 自称 browser-importable，但其闭包经 dsh-session/dsh-llm/dsh-user-approval/dsh-user-interaction 的 **barrel** 拖进 7 个非白名单增补 + 5 处 `node:` import（program 从 24 文件涨到 207）。`import type` 不能防污染的风险点坐实 |
| ④ | gate 原型 `poc/gate.mjs` | 三个 program 各跑一遍 | 干净 program PASS；②③b 均被抓（闭包交集 + 增补白名单双检查都命中） |

对照实验（控制变量）：把 `types` 从 `[]` 恢复成默认（含 node）再跑 ②——`node:path` 报错消失，但 TS2578 tripwire 仍红。说明 `types: []` 是纵深防御的一层（平台 API 泄漏在案发文件立刻报错），不是唯一防线。

## vendor/cordis 在 browser program 的答案

**原样 import 即可，cordis 本体零 shim 零别名**（paths 映射到 `vendor/cordis/src` 直接编译过）。需要的 shim 全在外围、且都是纯类型（运行时零代码，合计约 15 行）：

- `types/buffer-shim.d.ts`：cosmokit 的 `typeof Buffer !== 'undefined'` 运行时守卫在 `types: []` 下需要一个 ambient `Buffer` 声明（实测去掉即 8 个 TS2591）。
- `types/nodejs-timeout-shim.d.ts`：vendor/timer 把句柄写成 `number | NodeJS.Timeout`，browser 下 `declare namespace NodeJS { type Timeout = number }` 即消。

## 坑清单

1. **`import type` 防不住增补**（核心风险坐实，③b）：类型解析把目标文件整个拉进 program，barrel 里的 `declare module 'cordis'` 一并生效。shared 层能引用的包必须**本身**零 node 增补，这只能靠闭包 gate 保证，纪律与 lint import 语句都不够。
2. **现状 apiproxy `/api` 不是干净入口**：它 `import type` 的是 dsh-session/dsh-llm 的 barrel。但底细是好的——`session/types.ts`、`session/json.ts`、`llm/types.ts`、`llm/brand.ts` 本身零增补零 node:，**修法=给这些包开纯类型子路径 exports（`/types`），apiproxy/api 改从子路径 import**。例外：dsh-user-approval / dsh-user-interaction 是单文件包（增补和类型同文件），要先拆文件才有纯子路径可言。
3. **vendor src 的编译 flag 冲突**：单 program 直编 vendor src 时，vendor 各自 tsconfig 的放宽（noImplicitAny:false 等）不生效，得在 browser program 里放宽全 program（PoC 做法，见 `tsconfig.shared.json` 注释）。转正时三选一：project references（各 vendor 保持自己 flag，推荐）/ 消费 vendor `lib/types` 产物 / 接受全 program 放宽。
4. **`paths` 是整体覆盖不可增量合并**：browser tsconfig 必须重抄全量 paths 映射（或脚本生成）。会漂移——正好由 gate 兜底。
5. **tripwire 是按 key 的**：②里只有 `ctx.echoB` 的指令变 TS2578，`ctx.sessions` 那条照常（session 没被偷渡）。负例文件当编辑器内的快速信号，真正的强制是 gate 的白名单检查（对任意未知增补普适）。
6. **`types: []` 值得保留**：没有它，偷渡文件里的 `node:` value import 静默编译过（见对照实验），泄漏要到 tripwire/gate 才发现；有它则案发文件当场红。

## gate 脚本转正建议

- **位置**：`scripts/verify-browser-closure.mjs`（或 .ts 并入现有 verify-* 家族）；输入=browser tsconfig 路径。
- **机制照抄 PoC**：`tsc -p <cfg> --listFilesOnly` 拿 program 精确文件集（**必须用 tsc 而非 bundler 依赖图**——只有 tsc 看得见 type-only 边，而 type-only 边正是污染通道）；双检查：A) 闭包 ∩ node 半边清单 = ∅；B) 含 `declare module 'cordis'` 的文件必须逐个在 browser-safe 白名单里。B 是 A 的兜底，抓 A 的 pattern 没预料到的文件。
- **node 半边清单来源**（转正时替换 PoC 的硬编码 pattern）：机械推导自 package.json exports——无 `./browser`/`./shared` 出口的包整包算 node-only；三入口包取 `./node` 入口。不再手维护清单。
- **挂哪个门禁**：跟 `pnpm run typecheck` 同级（CI 序列里紧随其后）；等 web 构建管线成型后并进该管线的 verify 步。成本≈一次 tsc no-emit（PoC 实测秒级）。
- **保留 tripwire 负例文件**进 web-runtime 源码（`ctx.sessions` 等已知 node key 各一条 `@ts-expect-error`），当编辑器里的即时信号；gate 管强制。

## 三入口 exports 形态建议（PoC 实际所用 + 转正形态）

PoC 用源码直连形态（`tsconfig paths` + `"./node"|"./browser"|"./shared": "./src/*.ts"`，见 `poc/echo-a/package.json`）。转正建议：

```jsonc
"exports": {
  "./node":    { "types": "./lib/types/node.d.ts",    "default": "./lib/node.js" },
  "./browser": { "types": "./lib/types/browser.d.ts", "default": "./dist/browser.js" },  // bundle 产物，蓝图 §5
  "./shared":  { "types": "./lib/types/shared.d.ts",  "default": "./lib/shared.js" },
  "./src/*": "./src/*",   // 保留仓库源通道惯例
  "./package.json": "./package.json"
}
```

- **无根入口**（不设 `"."`）：强迫每个 import 表态要哪半边——根入口是污染的头号通道（③b 的 barrel 教训）。
- shared 的 `default` 条目保留：creator/泛型方案（蓝图 §6）意味着 shared 可能有少量运行时（creator 函数），"对 shared 的 import 必须 import type" 的四问裁决①约束适用于**消费方**（node/browser 半边 import shared 用 type），creator 本身由框架在装配点消费。若最终 shared 纯类型，`default` 改 `types`-only 亦可。
- browser 条目指向 tsdown bundle 产物（external cordis），与蓝图 §5 一致；类型仍从 d.ts 走，gate 检查的是 **types 侧闭包**，与产物 bundle 与否无关。

## PoC 文件索引（全部保留在 `poc/` 供参考）

- `echo-a/`（三入口双端包）、`echo-b/`（node-only 带增补）
- `app/`：browser-main（①③a）、negative（tripwire）、smuggle-chain + browser-smuggle-main（②）、browser-apiproxy-probe（③b）、node-main（node 侧镜像正例）
- `tsconfig.shared/browser/browser-smuggle/browser-apiproxy/node.json`：五份 program 定义
- `types/`：两个纯类型 shim；`gate.mjs`：gate 原型；`clean-program-files.txt`：干净 program 的 24 文件证据
- 复跑：`cd poc && ../../../../node_modules/.bin/tsc -p tsconfig.browser.json && node gate.mjs tsconfig.browser.json && node gate.mjs tsconfig.browser-smuggle.json --expect-fail && node gate.mjs tsconfig.browser-apiproxy.json --expect-fail`

---

# 升级批次（2026-07-20 傍晚，team-lead 五单合并；以下为任务理解外化，防断线）

> 上面第一轮结论是「gate 主角」旧标准产物，**方案节已作废待改写**；实证数据仍有效（program 级污染、import type 传染、apiproxy 污染、vendor 零 shim 等事实不变）。

## 新验收标准（用户硬约束，翻转）【本节为当时任务单快照；第 2 条 condition 主机制随后被用户终裁推翻（「export 可以改，condition 就不用了」），终态见文末结论 v3】

1. **不要重门禁，要 tsconfig 原生自动生效**：违规 import（client 半边碰 node 半边）必须在 tsc/IDE **当场编译报错**（cannot find module），不是靠 CI gate 事后抓。gate 降级为薄兜底（甚至可无）。
2. **主机制 = exports 条件 + customConditions**，且经纠偏（55e99fb3）：**`./node` 子路径不做了**——node 半边维持各包现有 `"."` 主入口（存量不干涉）；双端包只新增 `./client` `./shared`。自定义条件（如 `dsh-node`）挂在 **`"."` 主入口**的 types/default 上：node tsconfig `customConditions: ["dsh-node"]` → 解析到 node 半边；client tsconfig 不带 → import 主入口直接 TS2307。
   - **additive 硬约束（连带实证）**：不带条件的普通 node 消费者（现存全仓 import）解析主入口必须完全不受影响——带条件多一层解析，不带走 default 原路径。
   - 注意：无根入口的「强迫表态」防线随 ./node 取消而不存在了；client program 隔离全靠 customConditions/独立 tsconfig + types:[] + gate 符号溯源（README 取舍注记如实写）。
3. **命名裁决：一律 client 不用 browser**：tsconfig.client*.json、`./client` 入口、client-safe 白名单、gate 措辞全改。
4. **gate 重做为 TS compiler API 进程内**（gate-api.mjs，旧 gate.mjs 留档对照）：
   - 基础档：`ts.getParsedCommandLineOfConfigFile` → `ts.createProgram` → `program.getSourceFiles()` 出闭包（等价 listFilesOnly 但进程内，可给 import 解析链排障）。
   - **符号溯源档（主检查）**：`program.getTypeChecker()` → 拿 cordis `Context`/`Events` 接口 Symbol → `getDeclarations()` 枚举全部 merge 成员 → 每成员 `getSourceFile().fileName` 归属包 → 输出「key → 来源文件/包」清单，与 client-safe 白名单比对。检查本质（挂了什么 key、从哪来）而非代理指标（文件在不在）。
   - **双端 diff 模式**：同脚本参数化吃 tsconfig，client/node 各出一张 key→来源表，diff 出对等性报告（对等 Loader 验收预埋）。
   - 三场景复验：偷渡场景必须精确报出 ctx.echoB 来源文件；apiproxy 场景 7 个增补各自来源。
5. **apiproxy 双条件情报**（pr-gates 另一树 6dfe2a66b 已把 /api /client 改 types→lib/.d.ts、default→src）：「.d.ts 增补传染」从理论题变现实路径题，**优先实证**（echo-c 模拟 types→d.ts 布局）；session 纯类型子路径修法建议要写成对双条件布局的增量。

## 执行计划（小批落盘，每批 ≤5 分钟）

- [x] A1（最小正例先行）：echo-a exports `"."` 挂 dsh-node 条件 + poc/node_modules symlink 真解析 + tsconfig.client.json / tsconfig.node.json 对照，跑通「client import 主入口 TS2307、node 侧正常」
- [x] A2：additive 验证（不带任何 customConditions 的普通 tsconfig 解析 `"."` 走 default 原路径不受影响）
- [x] B1：逃逸变体——src/* 通道、paths 覆盖 exports（各一个负例）
- [x] B2：echo-c 模拟双条件 types→lib/.d.ts 布局，实证 .d.ts 增补传染
- [x] C：gate-api.mjs 符号溯源 + 双端 diff，三场景复验
- [x] D：全量 client 命名改造 + README 结论节按新标准重写（含 IDE 故事）

---

# 结论 v3（2026-07-20 深夜定稿；用户终裁「export 可以改，condition 就不用了」——condition 整体降备选）

## 总判定（v1 主线）

**类型隔离 = 独立 client tsconfig（file-set 从 client 入口出发 + `types: []`）+ `./client`、`./shared` 纯 exports 子路径（零条件解析）+ gate-api 符号溯源。**condition 方案不在主线（降级理由见下节）。职责划分：

- **独立 program + 纯子路径**承担日常隔离：client 代码只 import `./client`/`./shared` 子路径，闭包天然干净；`types: []` 让偷渡进来的 `node:` import 在案发文件当场红。
- **gate-api 白名单检查是「client 误 import 主入口」的唯一防线**（责任加重）。新增实证（echo-d）：普通主入口（无条件、无 node: import 的最坏情形）被 client import 时 **tsc 全静默零报错**（exit=0 实测）——没有任何配置层能拦，gate-api 精确抓出 `Context.echoD <- echo-d/src/node.ts`。
- **双端 diff 模式**照做（对等 Loader 验收预埋）。

## 【备选记档，v1 不采】condition 方案完整可行性证据（A 批实证，原样保留）

> 降级理由（用户裁决）：`./client`、`./shared` 本来就是纯子路径解析，condition 只防「client 误 import 主入口」一个场景，gate 符号溯源本就抓得住——不值得付「每个双端包主入口改两层形态 + 全仓 tsconfig.base 加 customConditions」的配置税。**触发条件=主入口误用成为高频痛点时启用**；届时以下证据直接可用。

**布局**（echo-a/echo-b 实测，`./node` 子路径已按裁决取消）：

```jsonc
// 双端包：node 半边住现有 "." 主入口，只新增 ./client ./shared
"exports": {
  ".": {
    "dsh-node": "./src/node.ts",      // 转正时: { types: lib/types/node.d.ts, default: lib/node.js }
    "default": "./lib/node.js"        // 纯运行时产物，无邻接 .d.ts —— additive 关键（见下）
  },
  "./client": "./src/client.ts",      // 转正时: types→d.ts + default→tsdown bundle（蓝图 §5）
  "./shared": "./src/shared.ts"
}
```

- **拦截**：client program（tsconfig 无 customConditions）import `@dsh-spike/echo-b` → **TS2307 cannot find module**（纯 gate 形态）或 **TS7016 找不到声明文件**（两层形态，strict 仓库必红）。错误就在违规 import 那一行，IDE 同一份 tsconfig 同一个错。
- **node 侧**：tsconfig `customConditions: ["dsh-node"]` → 同一 specifier 解析到 node 半边源/类型，全绿。
- **additive 硬约束（重要发现）**：`"."` **只挂 `dsh-node` 条目会破坏存量运行时**——plain node（无 `--conditions`）解析主入口直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`。必须两层：`default` 指向纯运行时 lib 产物（不带邻接 .d.ts），实测 plain node 解析结果与今天完全一致；`node --conditions=dsh-node` 才切换。**推论：全仓 tsconfig.base 要加一行 `customConditions: ["dsh-node"]`**（node 侧类型挂条件下之后，现有 typecheck 才能继续看到类型；解析目标不变，纯 additive），node 运行时启动脚本加 `--conditions=dsh-node`（或运行时继续走 default 的 lib 产物，两可，转正时定）。

## 逃逸/误用通道实证（B 批 + echo-d 补充）——独立 program 拦不住的面，gate 的存在理由

| 通道 | 结果 | 处置（已拍部分标注） |
|---|---|---|
| **主入口误用**（echo-d：普通 `"."`、无 node: import 的最坏情形） | client program 里解析成功、**tsc 全静默零报错**，增补直接进 program | **gate-api 唯一防线**（实测精确归源）；condition 备选留作痛点触发 |
| `./src/*` 出口（仓库惯例） | 直达 node 半边源码，污染发生；`types: []` 让 `node:` import 在案发文件当场红（半 loud） | **已拍：双端包不给 `./src/*` 出口**（都是新包，零成本；存量包通配不动） |
| tsconfig `paths` 映射包名 | **完全绕过** exports；目标无 `node:` import 时全静默 | client tsconfig **禁止 paths 指到包内部**（vendor 四包除外，纪律）+ gate 兜 |
| **.d.ts 增补传染**（echo-c 模拟 pr-gates 双条件布局 types→lib/*.d.ts） | **`import type` 一个 types 解析到含 `declare module 'cordis'` 的 .d.ts 的包，增补照样进 program**（tripwire TS2578 坐实），全静默无平台报警 | 纯类型子路径的 **.d.ts 必须从零增补源独立发射**（硬约束，已拍）；gate-api 能溯源 .d.ts 来源兜底 |

## gate-api.mjs（v1 主线三大件之一，用户点名的 TS API 符号溯源机制）

进程内 `ts.getParsedCommandLineOfConfigFile` → `ts.createProgram`，零子进程。主检查=**溯源本质**：枚举 program 里所有归并进 cordis 作用域的 `Context`/`Events` interface 声明（源文件 interface、`declare module 'cordis'` 增补、.d.ts 增补一视同仁），输出「key → 来源文件」表，与 client-safe 白名单比对。实测输出样例：

- 干净 client program：34 key 全归源 vendor/cordis + vendor/timer → PASS。
- 偷渡场景：精确报 `Context.echoB <- poc/echo-b/src/node.ts`；.d.ts 场景报 `Context.echoC <- poc/echo-c/lib/types/node.d.ts`。
- apiproxy 场景：31 条违规逐 key 归源（`Context.llm/sessions/agents/...` + `Events.agent/*` 全表）。
- **diff 模式**（`--diff client.json node.json`）：双端 key→来源表 + 对等报告（shared 32 / client-only timer / node-only llm、sessions、echoB…）——对等 Loader（蓝图 §4）的验收可直接吃这张表。

转正建议：`scripts/verify-client-closure.mjs`（JS import typescript，无子进程），CI 挂 typecheck 之后。v1 主线下它的职责清单（比 v2 设想重）：**主入口误用的唯一防线** + src/*（存量包）、paths、.d.ts 三条逃逸 + 对等性报告。IDE 内无它也有基本体验（独立 program 挡住增补可见性、types:[] 挡平台 API），但「误 import 主入口」要等 gate 跑才红——这是 v1 主线接受的取舍，痛点化则启用备选 condition 方案。

## IDE 故事（poc/ide/ 实测；v1 主线下依然成立的部分 + 备选增量）

**v1 主线部分**：`ide/client/` 与 `ide/node/` 各带目录级 tsconfig.json，tsserver 按 nearest-config 规则给同窗口两个文件绑不同 program——红线「同窗口不串 program」由 tsconfig 目录边界天然保证（web app 源码目录自带 client tsconfig，与 vite 项目常态一致）。client 文件里 `ctx.sessions` 现场红（增补不可见）、偷渡文件的 `node:` import 现场红（types:[]），两个目录 tsc 双绿复验过。**v1 编辑器体验的缺口**：「误 import 主入口」不红（echo-d 实证），等 gate 跑才报——已记入取舍注记。**备选 condition 方案的增量**正是把这个缺口也变成现场红（TS2307/TS7016，ide/ 实测过，证据留档）；`@ts-expect-error` 负例形态注记见 ide/client/main.ts 头注。

## 三入口 exports 转正形态（v1 主线定稿）

- **`"."` 主入口 = node 半边，完全维持现状**（普通 types/default 布局，无条件、无两层形态、存量零改动）。
- **新增 `./client`**：`{ types: ./lib/types/client.d.ts, default: ./dist/client.js }`（tsdown bundle、external cordis，蓝图 §5）；**该 d.ts 及其引用链必须零 node 增补**（echo-c 教训，已拍为硬约束）。
- **新增 `./shared`**：类型+creator；消费方 import 必须 `import type`（四问裁决①），creator 由框架装配点消费。
- **双端包不设 `./src/*` 出口（已拍）**；存量包 `./src/*` 通配不动（老规矩延续）。
- **取舍注记（如实记录）**：v1 主线下「client 误 import 主入口」在编辑器里不报错（echo-d 实证全静默），gate-api 是唯一防线；备选 condition 方案（含两层 additive 形态、tsconfig.base 加 customConditions 的完整证据）留档于上节，触发条件=该误用成为高频痛点。

## 复跑索引（poc/ 下）

```sh
tsc=../../../../node_modules/.bin/tsc
# —— v1 主线 ——
$tsc -p tsconfig.client.json            # ① 干净 client：GREEN
$tsc -p tsconfig.v1-misuse.json         # ② 主入口误用（echo-d）：GREEN=全静默污染实证
node gate-api.mjs tsconfig.v1-misuse.json --expect-fail     # ③ gate 抓出 Context.echoD（唯一防线）
$tsc -p tsconfig.escape-src.json        # ④ src/* 逃逸：RED（污染+node:报警）→ 已拍双端包不开此出口
$tsc -p tsconfig.escape-paths.json      # ⑤ paths 逃逸：RED（tripwire TS2578）
$tsc -p tsconfig.escape-dts.json        # ⑥ .d.ts 传染：RED（tripwire TS2578）
node gate-api.mjs tsconfig.client.json                      # PASS，34 key 溯源表
node gate-api.mjs tsconfig.escape-dts.json --expect-fail    # 抓 .d.ts 增补
node gate-api.mjs tsconfig.client-apiproxy.json --expect-fail  # apiproxy 31 违规逐 key 归源
node gate-api.mjs --diff tsconfig.client.json tsconfig.node.json  # 对等报告
$tsc -p ide/client/tsconfig.json && $tsc -p ide/node/tsconfig.json  # IDE 故事双绿
# —— 备选 condition 方案证据（v1 不采，留档）——
$tsc -p tsconfig.client-violation.json  # 拦截正例：GREEN（echo-b 两层形态 TS7016、echo-a 纯 gate 形态 TS2307，均被 @ts-expect-error 消费；该 program 不含 vendor src 故 noImplicitAny 全开=生产条件）
$tsc -p tsconfig.node.json              # node 侧（dsh-node 条件）：GREEN
node --input-type=module -e "console.log(import.meta.resolve('@dsh-spike/echo-b'))"          # → lib/node.js（default，additive 证明）
node --conditions=dsh-node --input-type=module -e "console.log(import.meta.resolve('@dsh-spike/echo-b'))"  # → src/node.ts
```

假包一览：echo-a（双端三入口，`.` 挂 dsh-node=备选形态样本）、echo-b（node-only+条件+两层 additive=备选形态样本）、echo-c（.d.ts 增补传染）、echo-d（普通主入口=v1 主线误用样本）。旧产物留档对照：gate.mjs（listFilesOnly 文件集方案）、clean-program-files.txt。
