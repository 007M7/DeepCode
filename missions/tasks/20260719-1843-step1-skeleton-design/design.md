# step1 骨架 · 实现规格（v2）

> 2026-07-19 v2 重写：读者是**无本会话上下文的编码 teammate**——照本文档即可建目录、写文件、跑通验收，不需要再查素材。事实核实基于 HEAD `9eb1fbd5d`。设计权衡见 git 历史里的 v1；本文只给结论。
> 范围：五模块骨架 + 静态服务 + host boot + 停机。**不含任何 /api 路由、/health、session 通信、协议实现**（step2，契约见 `../20260719-1902-apiproxy-api-design/design.md`）。

## ⓪ 已锁定结论（直接照做，不再讨论）

- 五模块：`apps/dsc`、`apps/web`、`packages/host/apiproxy`、`packages/client/web-runtime`、`packages/client/web-ui`。
- 包名/bin：`@deepseek-ai/dsc`，bin 名 `dsc`，子命令 `web`；前端包 `@deepseek-ai/dsc-web`；三个 dsh 包 `@deepseek-ai/dsh-apiproxy` / `@deepseek-ai/dsh-web-runtime` / `@deepseek-ai/dsh-web-ui`。
- 版本：vite `^6.0.0`、`@vitejs/plugin-react` `^4.0.0`、react/react-dom `^18.2.0`、`@types/react` `~18.3.1`、`@types/react-dom` `~18.3.0`、typescript `^6.0.3`（跟根）。
- `--port` 用 `node:util` 的 `parseArgs`，默认 **3080**；`listen(port, '0.0.0.0')`，打印 `http://127.0.0.1:<port>`。
- API key：bin 先 `loadEnv()` 读根 `.env` 进 process.env（直接 import 自 `@deepseek-ai/dsh-app-boot`，已核实是普通具名导出函数，无 Loader 依赖），`LlmDeepSeek` 插件层自己兜底读 `$DEEPSEEK_API_KEY`（缺 key 在 plugin load 期 throw，fail loud）。
- persistenceRoot：`'./.sessions'`（cwd 相对；demo:web 从仓库根跑，与现有 demos 一致）。
- 停机：照 `packages/examples/jsonrpc-demo/src/bin.ts` 的 `disposeAndExit` 样板；SIGINT→130、SIGTERM→0；关 HTTP 后 dispose cordis root。不做 drain。
- 纪律：**不遵循仓库门禁**（coverage/doc-sync/JSDoc/README/knip/根 typecheck references 一概不动、不补）；只求 `demo:web` 能跑通验收清单。
- step1 不做：`/api/*` 路由（含 /health）、session 通信、agent 预建、vite dev server/proxy、ClientSlot、tsdown/构建产物（dev 期 tsx 跑 src）、测试。

## ① 目录树（新建文件全清单）

```
apps/                                    ← 新顶层目录
  dsc/
    package.json                         ← §③-1
    tsconfig.json                        ← §④-1
    src/bin.ts                           ← §⑤-5（bin 全部逻辑单文件：parseArgs + bootHost + 静态服务 + 信号）
  web/
    package.json                         ← §③-2
    tsconfig.json                        ← §④-2
    index.html                           ← §⑤-4（vite 默认入口位置 = 包根）
    vite.config.ts                       ← §⑤-4
    src/main.ts                          ← §⑤-4
packages/host/                           ← 新包组
  apiproxy/
    package.json                         ← §③-3
    tsconfig.json                        ← §④-3
    src/index.ts                         ← §⑤-1（bootHost）
packages/client/                         ← 新包组
  web-runtime/
    package.json                         ← §③-4
    tsconfig.json                        ← §④-4
    src/index.ts                         ← §⑤-2（Runtime + createRuntime）
  web-ui/
    package.json                         ← §③-5
    tsconfig.json                        ← §④-5
    src/index.tsx                        ← §⑤-3（mount + App）
```

不建：tests/、README.md（含 packages/host/README.md、packages/client/README.md 组说明）、tsdown.config.ts——门禁跳过，step 后续补。

## ② 根配置改动（四处，给出精确编辑）

### ②-1 `pnpm-workspace.yaml`

`packages:` 列表在 `- packages/*/*` 之后插入一行：

```yaml
  - packages/*/*
  - apps/*          # ← 新增
  - website
```

### ②-2 根 `package.json` 两处

a) `workspaces` 数组（与 pnpm-workspace.yaml 保持一致）加一项：

```json
  "workspaces": [
    "vendor/*",
    "packages/*/*",
    "apps/*",
    "website"
  ],
```

b) `scripts` 加一行（无 `--expose-internals`，无 HMR）：

```json
    "demo:web": "node --import tsx apps/dsc/src/bin.ts web",
```

### ②-3 `tsconfig.base.json`

`"@deepseek-ai/dsh-*"` paths 数组**末尾**追加两行（位置无关——包目录名全仓唯一、first-on-disk-wins；注意给上一行 `"./packages/support/*/src"` 补逗号）：

```json
        "./packages/support/*/src",
        "./packages/host/*/src",
        "./packages/client/*/src"
```

这两行是 tsx 跑 `demo:web` 时把 `@deepseek-ai/dsh-apiproxy` 等裸名解析到源码的**必要条件**（tsx 读 tsconfig paths；lib/ 未构建）。`@deepseek-ai/dsc-web` 不匹配 `dsh-*` 通配、走 node_modules workspace 软链 + package exports 解析，无需 paths。

### ②-4 `.gitignore`

现有 `.gitignore` 无泛 `dist/` 条目（只有 `dist-exe/`），追加一行：

```
apps/web/dist/
```

其余根配置（tsconfig.json references、tsconfig.build.json、tsdown.config.ts、coverage/knip/jscpd 各 glob）**一概不动**——apps/* 与新包学 website 先例：workspace 成员、自带构建、不进根构建图与门禁。

## ③ 五个包 package.json 全文

依赖纪律（本 step 统一）：**全部用平铺 `dependencies`，内部包（含 vendored 的 cordis / @cordisjs/plugin-timer）一律 `workspace:^`**；不做仓库惯例的 peer+dev 双列（apps 是叶子、client 两包非 cordis 插件；apiproxy 正规化时再改）。全部 `private: true`，不发布。

### ③-1 `apps/dsc/package.json`

bin 字段按仓库惯例指 `lib/bin.js`，但 step1 不构建、不经 bin 调用——唯一运行路径是根 script `demo:web`（tsx 跑 src）。

```json
{
  "name": "@deepseek-ai/dsc",
  "description": "dsc CLI: `dsc web` serves the built web UI and boots the harness host",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": {
    "dsc": "lib/bin.js"
  },
  "files": [
    "lib/bin.js",
    "src"
  ],
  "license": "BSD-3-Clause",
  "dependencies": {
    "@deepseek-ai/dsc-web": "workspace:^",
    "@deepseek-ai/dsh-apiproxy": "workspace:^",
    "@deepseek-ai/dsh-app-boot": "workspace:^"
  }
}
```

### ③-2 `apps/web/package.json`

无 `main`/`"."` export——它是 vite 构建入口不是库；`"./dist/*"` export 是 apps/dsc 解析 dist 的唯一通道（`require.resolve` 走 exports 映射）。依赖四项都必须列（v2.1 修正，实测两次 build 失败得出）：**`dsh-web-runtime`**——`src/main.ts` 直接 import，pnpm 严格 node_modules 下未声明不可解析；**react / react-dom**——`@vitejs/plugin-react` 强制 `resolve.dedupe: ['react','react-dom']`，dedupe 让 vite 从项目根 apps/web 解析而非从 importer（web-ui），apps/web 自己没有 react 即 resolve NULL。

```json
{
  "name": "@deepseek-ai/dsc-web",
  "description": "dsc web frontend: vite build entry producing dist/ served by apps/dsc",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    "./dist/*": "./dist/*",
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "vite build",
    "watch": "vite build --watch"
  },
  "license": "BSD-3-Clause",
  "dependencies": {
    "@deepseek-ai/dsh-web-runtime": "workspace:^",
    "@deepseek-ai/dsh-web-ui": "workspace:^",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^6.0.3",
    "vite": "^6.0.0"
  }
}
```

### ③-3 `packages/host/apiproxy/package.json`

入口按仓库模板指 `lib/`（step1 不构建；tsx 经 tsconfig paths 直接吃 src，lib 只为将来构建留位）。

```json
{
  "name": "@deepseek-ai/dsh-apiproxy",
  "description": "Programmatic harness host composition for dsc: bootHost mounts the core spine; step2 adds the ApiProxy contract",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/types/**/*.d.ts",
    "lib/types/**/*.d.ts.map",
    "src"
  ],
  "license": "BSD-3-Clause",
  "dependencies": {
    "@cordisjs/plugin-timer": "workspace:^",
    "@deepseek-ai/dsh-agent": "workspace:^",
    "@deepseek-ai/dsh-agent-loop": "workspace:^",
    "@deepseek-ai/dsh-bash-local": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-llm-deepseek": "workspace:^",
    "@deepseek-ai/dsh-session": "workspace:^",
    "@deepseek-ai/dsh-session-persistence-jsonl": "workspace:^",
    "@deepseek-ai/dsh-system-prompt": "workspace:^",
    "@deepseek-ai/dsh-tasks": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^",
    "cordis": "workspace:^"
  }
}
```

### ③-4 `packages/client/web-runtime/package.json`

**入口直接指 src**（与 apiproxy 不同）：消费者只有 vite（啃源码打包），step1 这两个 client 包不做任何构建。零依赖。

```json
{
  "name": "@deepseek-ai/dsh-web-runtime",
  "description": "Browser-side runtime layer for the dsc web UI (no React): runtime creation; step2 adds the api client and store",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./package.json": "./package.json"
  },
  "license": "BSD-3-Clause"
}
```

### ③-5 `packages/client/web-ui/package.json`

```json
{
  "name": "@deepseek-ai/dsh-web-ui",
  "description": "React component layer for the dsc web UI: mount(el, runtime)",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.tsx",
  "types": "src/index.tsx",
  "exports": {
    ".": "./src/index.tsx",
    "./package.json": "./package.json"
  },
  "license": "BSD-3-Clause",
  "dependencies": {
    "@deepseek-ai/dsh-web-runtime": "workspace:^",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "~18.3.1",
    "@types/react-dom": "~18.3.0"
  }
}
```

## ④ 五个 tsconfig.json 全文

形状照 `packages/examples/stdio-demo/tsconfig.json`（extends 根 base / rootDir src / outDir lib/types / include src / references 指依赖包目录）。apps/* 在顶层第二级，extends 相对路径少一级（`../../`）。这些 tsconfig step1 只服务 tsx 的 paths 解析与编辑器；不进根构建图、不跑 tsc 门禁。浏览器侧三包（web-runtime/web-ui/apps-web）覆写 `lib` 加 DOM、清空 `types`（去掉 base 的 node）；含 JSX 的再加 `"jsx": "react-jsx"`。

### ④-1 `apps/dsc/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": [
    "src"
  ],
  "references": [
    { "path": "../../vendor/cordis" },
    { "path": "../../packages/host/apiproxy" },
    { "path": "../../packages/ui/app-boot" }
  ]
}
```

### ④-2 `apps/web/tsconfig.json`

`vite.config.ts` 不进 include（它要 node 环境类型，与浏览器 src 冲突；vite 自己能跑它，编辑器红线忍受或将来拆 tsconfig.node.json——step1 不管）。

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "types": [],
    "jsx": "react-jsx"
  },
  "include": [
    "src"
  ],
  "references": [
    { "path": "../../packages/client/web-ui" }
  ]
}
```

### ④-3 `packages/host/apiproxy/tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": [
    "src"
  ],
  "references": [
    { "path": "../../../vendor/cordis" },
    { "path": "../../../vendor/timer" },
    { "path": "../../llm/llm" },
    { "path": "../../llm/llm-deepseek" },
    { "path": "../../core/session" },
    { "path": "../../core/system-prompt" },
    { "path": "../../core/tools" },
    { "path": "../../core/agent" },
    { "path": "../../tasks/tasks" },
    { "path": "../../core/agent-loop" },
    { "path": "../../session-persistence/session-persistence-jsonl" },
    { "path": "../../bash/bash-local" }
  ]
}
```

### ④-4 `packages/client/web-runtime/tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "types": []
  },
  "include": [
    "src"
  ]
}
```

### ④-5 `packages/client/web-ui/tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "types": [],
    "jsx": "react-jsx"
  },
  "include": [
    "src"
  ],
  "references": [
    { "path": "../web-runtime" }
  ]
}
```

## ⑤ 源文件内容

### ⑤-1 `packages/host/apiproxy/src/index.ts` — bootHost

签名与插件清单（顺序即代码顺序；cordis 按 inject 自动挂起等依赖，顺序仅为可读性，但**逐个 await** 保证失败在 boot 期确定性上抛——不装 agent-spine-demo bundle，其 apply 内不 await 子插件、失败晚爆）：

```ts
import { Context } from 'cordis'
import Timer from '@cordisjs/plugin-timer'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import TaskService from '@deepseek-ai/dsh-tasks'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'

export interface BootHostOptions {
  persistenceRoot: string          // apps/dsc 传 './.sessions'
}

export interface HostHandle {
  ctx: Context
  dispose(): Promise<void>         // = ctx.fiber.dispose()
}

export async function bootHost(options: BootHostOptions): Promise<HostHandle> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TaskService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, {})
  await ctx.plugin(SessionPersistenceJsonl, { root: options.persistenceRoot })
  await ctx.plugin(LocalBashExecutor, {})
  return { ctx, dispose: () => ctx.fiber.dispose() }
}
```

逐项说明（结论 + 一句注记）：

| 插件 | config 实参 | 注记 |
|---|---|---|
| `Timer` | 无 | AgentLoop 依赖链要 timer |
| `LlmService` | 无 | default export 类 |
| `SessionStore` | 无 | |
| `SystemPrompt` | `{ persona: '' }` | schema 有 default('')，传空串显式化；step2 再定真 persona |
| `ToolRegistry` | 无 | inject: ['systemPrompt']，晚于 SystemPrompt 列出仅为可读性 |
| `AgentRegistry` | 无 | |
| `TaskService` | 无 | |
| `AgentLoop` | `{ agents: [] }` | **不预建 agent**（acp-demo 同款）；inject: agents/sessions/llm/tools/systemPrompt |
| `LlmDeepSeek` | `{}` | **函数插件，`import * as` 挂载**（named exports，无 default）；apply 内 `config.apiKey ?? process.env.DEEPSEEK_API_KEY`，缺 key 直接 throw |
| `SessionPersistenceJsonl` | `{ root: options.persistenceRoot }` | root 必填无默认（schema `.required()`） |
| `LocalBashExecutor` | `{}` | default export 类；cwd 默认 process.cwd() |

不装：skill 族、workspace-context、invariants、tool-bash（模型工具面 step2 随 agent 通信一起定）、fs 族、compact、subagent、UI 插件。step1 这个 host 起来后**什么都不做**，只证明 boot/dispose 通。

### ⑤-2 `packages/client/web-runtime/src/index.ts`

```ts
export interface Runtime {
  baseUrl: string                  // step2 的 ApiClient 从这里长出来
}

export function createRuntime(): Runtime {
  return { baseUrl: window.location.origin }
}
```

### ⑤-3 `packages/client/web-ui/src/index.tsx`

```tsx
import { createRoot } from 'react-dom/client'
import type { Runtime } from '@deepseek-ai/dsh-web-runtime'

function App({ runtime }: { runtime: Runtime }) {
  return <main>dsc web · skeleton · {runtime.baseUrl}</main>
}

export function mount(el: HTMLElement, runtime: Runtime): () => void {
  const root = createRoot(el)
  root.render(<App runtime={runtime} />)
  return () => root.unmount()
}
```

### ⑤-4 apps/web 三件套

`apps/web/index.html`（vite 约定：包根、script 指 src 入口）：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>dsc</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`apps/web/src/main.ts`：

```ts
import { createRuntime } from '@deepseek-ai/dsh-web-runtime'
import { mount } from '@deepseek-ai/dsh-web-ui'

const el = document.getElementById('root')
if (el === null) throw new Error('missing #root')
mount(el, createRuntime())
```

`apps/web/vite.config.ts`（vite 默认 outDir 就是 dist、默认吃包根 index.html，无需多配；react 插件负责 web-ui 里的 JSX/tsx）：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

vite 对 workspace 依赖的处理：`@deepseek-ai/dsh-web-ui` / `dsh-web-runtime` 经 node_modules 软链解析到源文件（package.json 入口直指 src，§③-4/③-5），vite 当普通源码编译——**不需要** resolve.alias 或 optimizeDeps 配置。

### ⑤-5 `apps/dsc/src/bin.ts` — 动线（伪代码级，函数边界与真实 API 已核实）

```ts
#!/usr/bin/env node
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { dirname, join, normalize, resolve, extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { loadEnv } from '@deepseek-ai/dsh-app-boot'
import { bootHost } from '@deepseek-ai/dsh-apiproxy'

// ---- 1. 参数 ----
// argv: dsc web [--port N]；positionals[0] !== 'web' → usage 到 stderr，exit 1
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { port: { type: 'string', default: '3080' } },
  allowPositionals: true,
})
if (positionals[0] !== 'web') { process.stderr.write('usage: dsc web [--port N]\n'); process.exit(1) }
const port = Number(values.port)
if (!Number.isInteger(port) || port <= 0 || port > 65535) { /* stderr + exit 1 */ }

// ---- 2. env ----
loadEnv('dsc')            // 读 <cwd>/.env 进 process.env；ENOENT 静默（app-boot 具名导出，已核实无 Loader 牵连）

// ---- 3. host ----
const host = await bootHost({ persistenceRoot: './.sessions' })
// 缺 DEEPSEEK_API_KEY 时 LlmDeepSeek 在这里 throw → 顶层 rejection 打印后进程退出（fail loud，不 catch）

// ---- 4. dist 根 ----
// 选型：createRequire（同步、返回文件路径、workspace 软链下走真实 exports 映射；
// import.meta.resolve 返回 URL 还得 fileURLToPath，弃）
const require = createRequire(import.meta.url)
const distIndex = require.resolve('@deepseek-ai/dsc-web/dist/index.html')
// dist 不存在（没跑 vite build）时这里同步 throw ERR_MODULE_NOT_FOUND →
// catch 后打印「先跑 pnpm --filter @deepseek-ai/dsc-web build」，exit 1
const distRoot = dirname(distIndex)

// ---- 5. 静态服务 ----
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
  '.map':  'application/json',
}
const server = createServer(async (req, res) => {
  // 只服务 GET/HEAD，其余 405
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  const target = resolve(normalize(join(distRoot, pathname)))
  // 路径穿越拒绝：target 必须等于 distRoot（即 `/`）或以 distRoot + '/' 为前缀，否则 403
  if (target !== distRoot && !target.startsWith(distRoot + '/')) { /* 403; return */ }
  try {
    const body = await readFile(target === distRoot ? distIndex : target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // 未命中（ENOENT/EISDIR）一律回 index.html + text/html 200（SPA 将来路由）
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(await readFile(distIndex))
  }
})

// ---- 6. listen + 打印 ----
server.listen(port, '0.0.0.0', () => {
  console.log(`dsc web: http://127.0.0.1:${port}`)
})
// listen 失败（EADDRINUSE）：server.on('error') → stderr + disposeAndExit(1)

// ---- 7. 停机（照 jsonrpc-demo/src/bin.ts:39-51 样板，多关一个 http server）----
let exiting = false
async function disposeAndExit(code: number): Promise<void> {
  if (exiting) return
  exiting = true
  try {
    server.close()                 // 停止接受新连接；不等既有连接 drain（step1 不做）
    await host.dispose()           // = ctx.fiber.dispose()
  } finally {
    process.exit(code)
  }
}
process.on('SIGTERM', () => { void disposeAndExit(0) })
process.on('SIGINT', () => { void disposeAndExit(130) })
```

边界结论（实现时不要改）：

- **不用** app-boot 的 `boot()`/`installFailLoud`/`resolveConfigPath`——那是 Loader 路径；本 bin 只借 `loadEnv`。
- 未知路径回 index.html 用 **200**（不是 404）；`/api/*` step1 无特判，同样回 index.html，step2 再切。
- 路径穿越判定基准：`resolve(target)` 必须等于 distRoot 或以 `distRoot + '/'` 为前缀（普通字符串前缀即可，distRoot 来自 require.resolve 已是绝对真实路径）。
- 打印行固定 `http://127.0.0.1:<port>`（listen 的是 0.0.0.0，打印回环地址供本地浏览器点击；容器场景用户自己换 IP）。

## ⑥ 验收清单（从仓库根逐条执行）

前提：根 `.env` 含 `DEEPSEEK_API_KEY`（step1 不发请求，但 LlmDeepSeek load 期查 key）。

| # | 命令 | 期望 |
|---|---|---|
| 1 | `pnpm install` | 退出 0；`node_modules/@deepseek-ai/dsc-web` 等五个软链出现 |
| 2 | `pnpm --filter @deepseek-ai/dsc-web build` | 退出 0；产出 `apps/web/dist/index.html` 与 `dist/assets/*.js` |
| 3 | `pnpm run demo:web &`（后台起） | 数秒内 stdout 出现 `dsc web: http://127.0.0.1:3080` |
| 4 | `curl -s http://127.0.0.1:3080/` | 返回 index.html 内容（含 `<div id="root">`） |
| 5 | `curl -s http://127.0.0.1:3080/assets/<步骤2产出的js名>` | 返回 js；`curl -sI` 看 `content-type: text/javascript` |
| 6 | `curl -s http://127.0.0.1:3080/no/such/route` | 返回 index.html（SPA 回退，HTTP 200） |
| 7 | `curl -s --path-as-is 'http://127.0.0.1:3080/%2e%2e%2fpackage.json' -o /dev/null -w '%{http_code}'` | `403`（穿越拒绝。v2.1 修正：裸 `/../package.json` 即使带 `--path-as-is` 也测不到 403——server 侧 `new URL()` 先把 `/..` 折叠成 `/`，请求安全落为 SPA 回退 200+index.html、无泄漏；只有编码变体在 decodeURIComponent 后才出现 `..`、真正命中 403 分支） |
| 8 | 浏览器开 `http://<容器IP>:3080/` | 页面渲出 `dsc web · skeleton · http://<容器IP>:3080` |
| 9 | 前台 `pnpm run demo:web` 后 Ctrl-C | 进程退出（预期码 130；tsx/pnpm 链路下 shell 观察值可能是信号态，不必较真——能干净退出即过） |
| 10 | `kill -TERM <pid>` | 退出码 0 |
| 11 | 缺 key 场景：`env -u DEEPSEEK_API_KEY DEEPSEEK_API_KEY= pnpm run demo:web`（或临时改名 .env） | 非零退出，stderr 含 `llm-deepseek: an API key is required` |
| 12 | 没跑步骤 2 就 `rm -rf apps/web/dist && pnpm run demo:web` | 非零退出，stderr 提示先跑 `pnpm --filter @deepseek-ai/dsc-web build` |

验收 3-10 期间 `.sessions/` **不应该**出现（没有 agent、没有 session；SessionPersistenceJsonl 惰性建目录）。出现即说明 bootHost 多干了事。

## ⑦ step2 接缝（一句话，不复制契约）

apiproxy 的 API 契约（`api/` 类型层、fetch 载体、SSE 流、web-runtime 侧 ApiClient/fold/store）**唯一权威在 `../20260719-1902-apiproxy-api-design/design.md`**，且其命名体系仍在演进——本文档不复制任何契约类型名。step1 只保证接缝物理位置：`/api/*` 请求将来在 bin.ts 静态服务 handler 最前面加一个前缀分支转给 apiproxy 的 fetch handler，静态部分零改动；bootHost 返回的 `ctx` 就是将来构造 ApiProxy impl 的输入。

## ⑧ 与 v1 的差异记录（给 review 者，不影响实现）

- v1 的三个遗留问题全部已拍板落死：vite ^6 + plugin-react ^4；`@deepseek-ai/dsc` + bin `dsc` + 子命令 `web`；persistenceRoot `./.sessions`。
- v1 写「apps/dsc deps 双列 peer+dev」参考 examples 模板——v2 改为**五包全平铺 dependencies**（用户拍板：apps 叶子不玩双列；client 包非 cordis 插件同理；apiproxy 将来正规化再改）。
- v1 未定 client 包入口形态——v2 定为 src 直入口（main/exports 指 `./src/index.ts(x)`），因 step1 唯一消费者是 vite。
- dist 解析在 createRequire 与 import.meta.resolve 二选一——v2 定 createRequire。
