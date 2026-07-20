# 全仓 package.json exports 形态盘点（2026-07-20）

> 调研输入:cordis-spike 的双端 exports 条件(customConditions)调研 + 后续「三入口规范」。只读盘点,零改动。范围:packages/*/*(78)+ apps(2)+ vendor(9)+ python(1)= 108 个 manifest,以当前树为准。**构型批(pr-gates)在途**:client/* 两包与 host/apiproxy 的 src 指向预计会变,标注于表。

## 聚类总览

| 形态 | 数量 | 说明 |
|---|---|---|
| A. 标准形:lib 入口 + `./src/*` 透传 | 90 | `.`={types:lib/types, default:lib/index.js} + `./src/*` + `./package.json`。harness 绝对主流,vendor 8 包同形 |
| B. src 直入口(无 lib) | 2 | client/web-runtime、client/web-ui(GUI 期产物,构型批在改) |
| C. lib 入口 + 指向 src 的**具名**子路径 | 2 | core/session(`./surface`→src)、host/apiproxy(`./api` `./api/*` `./client`→src) |
| D. lib 入口 + 额外 lib 子路径(无 src 透传) | 3 | code-runtime-worker(`./worker`)、sdk/scripts(`./dev/tsdown-config`,bin)、apps/web(`./dist/*`) |
| E. lib 入口干净形(无 src 透传、无子路径) | 3 | core/agent-loop、sdk/create-sdk(bin)、sdk/helper |
| F. A 形 + 额外子路径 | 5 | 四个 examples demo(`./bin`,bin 包)+ workflow-workerthread(`./worker`) |
| G. 无 exports 无 main | 2 | apps/dsc(纯 bin)、python/sdk-runtime(pnpm 占位) |
| H. 只有 main 无 exports | 1 | vendor/schemastery(main=lib/index.cjs,唯一 CJS 主入口) |

## ① 导出 src 的包(用户点名)

**`./src/*` 通配透传:95 包**(A 形 90 + F 形 5)——即除 B/C 之外几乎全仓都留着 `"./src/*": "./src/*"` 后门。这是模板化产物(所有包同一份样板),不是逐包决策。

**入口/具名子路径指向 src(比通配更实质的 src 导出)**:

| 包 | 指向 src 的座位 | 消费者(grep 实证) |
|---|---|---|
| client/web-runtime | `main`/`types`/`.` = src/index.ts | apps/web、client/web-ui(**构型批在改**) |
| client/web-ui | `main`/`types`/`.` = src/index.tsx | apps/web(**构型批在改**) |
| host/apiproxy | `./api`→src/api/index.ts、`./api/*`→src/api/*.ts、`./client`→src/fetch/client.ts | 见 ③ |
| core/session | `./surface`→src/surface.ts | client/web-runtime/src/session/fold-adapter.ts(1 处) |

## ② GUI 新五包 + apps 现状

| 包 | main | exports 形态 | 备注 |
|---|---|---|---|
| client/web-runtime | src/index.ts | B(src 直入口) | 构型批在途→lib |
| client/web-ui | src/index.tsx | B(src 直入口) | 构型批在途→lib |
| host/apiproxy | lib/index.js | C(lib 入口+3 个 src 具名子路径) | src 子路径是「为 client 专门导出」的那部分,见 ③ |
| host/runtime | lib/index.js | A 标准形 | 已合规 |
| host/webserver | lib/index.js | A 标准形 | 已合规 |
| apps/dsc | (无,bin=lib/bin.js) | G | 纯 CLI,无库面 |
| apps/web | (无) | D(`./dist/*` 透传) | 唯一消费者 apps/dsc web.ts 的 require.resolve('@deepseek-ai/dsc-web/dist/index.html') |

## ③ apiproxy 子路径导出(「为 client 专门导出」部分)

| 子路径 | 指向 | 消费者(product 源码,grep 实证) |
|---|---|---|
| `./api` | src/api/index.ts | host/runtime(api-proxy.ts、start.ts)、client/web-runtime(api.ts、fixture.ts)、apps/dsc(headless.ts) |
| `./api/*` | src/api/*.ts | host/runtime(api/rpc)、client/web-runtime(api/rpc)、apps/dsc(api/rpc) |
| `./client` | src/fetch/client.ts | client/web-runtime/src/api.ts(re-export AbstractApiClient/IApiClient,仅此 1 文件) |

特征:三个子路径**都指 src/*.ts 而非 lib**——即使主入口已是 lib,双端共享的契约面走的还是 TS 源直连。这正是 cordis-spike customConditions 调研要解决的形态(browser 侧 vite 吃 TS 源没问题,node 侧要么 tsx 要么得走 lib)。「三入口规范」落地时 apiproxy 是首要改造对象。

## ④ src 路径 import 违例清单(「代码上尽量别再用」)

**product 源码(src→src 跨包):0 处**——干净。
**测试代码:13 处,全部是「本包 tests/ import 本包 src/」**(白盒测试形态,不跨包):

| 文件 | import |
|---|---|
| mcp-client/tests/mcp-client.spec.ts | 本包 src/tools.ts、src/transport.ts |
| mcp-client/tests/mcp-client.e2e.ts | 本包 src/index.ts、src/tools.ts |
| mcp-client/tests/apply.spec.ts | 本包 src/index.ts |
| hooks-codex/tests/config.spec.ts | 本包 src/config.ts |
| hooks-claude/tests/config.spec.ts | 本包 src/config.ts |
| core/tools/tests/ts-types.spec.ts | 本包 src/ts-types.ts |
| bash-sandbox/tests/bwrap.e2e.ts + seatbelt.e2e.ts | **dsh-sandbox-local**/src/profiles.ts(唯一真跨包×2) |
| compact-basic/tests/compact-basic.spec.ts | 本包 src/region.ts、src/config.ts |
| web-search-deepseek/tests/deepseek.spec.ts | 本包 src/types.ts |

vendor src import:全仓 0 处。**结论:`./src/*` 通配的真实消费=测试白盒(且 11/13 是本包),砍掉通配对 product 代码零破坏,只需处理 bash-sandbox 两个 e2e 的跨包 src import + 本包白盒改相对路径(或规范豁免测试)。**

## ⑤ 其他值得记录的形态

- **`./worker` 子路径**(workerthread、code-runtime-worker):指 lib/worker.cjs(CJS!worker 线程入口)。运行时自身不经包名消费(host.ts 用相对 `new URL('./worker.cjs', import.meta.url)`,dev 态 fallback `./worker.ts`),子路径是给外部/测试的正式座位。三入口规范时这类「非 index 的运行时资产」要单独归类。
- **`./bin` 子路径**(4 examples):bin 包同时把 bin 入口暴露为库子路径(types+default 双条件,规范形),源码 @module 注释自证。
- **sdk/scripts `./dev/tsdown-config`**:构建工具链自消费(各包 tsdown.config.ts),lib 指向,规范形。
- **vendor/logger-console**:全仓唯一用 **条件分支 exports** 的包(`node`:lib/index.js vs `default`:lib/browser.js)——cordis-spike 双端条件调研的现成 in-repo 先例。
- **vendor/schemastery**:全仓唯一无 exports 字段包(main=lib/index.cjs);上游原状,NodeNext 下靠 main 回退。
- **core/agent-loop、sdk/helper、sdk/create-sdk**:仅有的三个「无 `./src/*`」的 dsh 包——agent-loop 疑似有意收紧(核心循环不给后门),可作三入口规范的目标形参照。

## 附:原始数据

/tmp/exports-survey.json(本机,重跑 survey 脚本可再生;脚本一次性,未入库)。
