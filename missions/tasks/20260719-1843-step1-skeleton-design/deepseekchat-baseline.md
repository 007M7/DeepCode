# deepseekchat（deepsuite-frontend）前端工程基线调研

调研对象：`/weka-hg/prod/deepseek/permanent/ys/private/workspace/gitlab/deepsuite-frontend`。
该仓库是 **Rush + pnpm** monorepo（无根 package.json，项目清单在 `rush.json`），主聊天 web 应用选定为 **`apps/chat`（`@deepseek/chat`）**。

**重要前提：该仓库不用 Vite，构建器是 Rspack（`@rspack/cli` + `builtin:swc-loader`）。** 全仓 `find` 无任何 `vite.config.*`，也没有 `vite` 依赖。下文 "vite 配置要点" 一节相应改为 rspack 配置要点，供新骨架用 Vite 对齐等效能力时参考。
## 1. 关键依赖版本表

| 项目 | 版本 / 值 | 出处 |
| --- | --- | --- |
| react | `^18.2.0`（lock 解析为 18.3.1） | `apps/chat/package.json` dependencies；`common/config/rush/pnpm-lock.yaml` |
| react-dom | `^18.2.0`（lock 18.3.1） | 同上 |
| @types/react / @types/react-dom | `~18.3.1` / `~18.3.0` | `apps/chat/package.json` |
| 构建器 | **Rspack**：`@rspack/cli` 2.0.2、`@rspack/core` 2.0.2、`@rspack/dev-server` 2.0.1（无 vite） | `apps/chat/package.json` devDependencies |
| React 转换 | 无 @vitejs/plugin-react\*；用 rspack `builtin:swc-loader`，`react.runtime: 'automatic'`，dev 下 `react-refresh`（`@rspack/plugin-react-refresh` 2.0.0） | `shared/rspack-base-config/index.ts`、`shared/rspack-base-config/package.json` |
| typescript | `6.0.3` | `apps/chat/package.json`、`shared/tsconfig-base` 的消费方统一为 6.0.3 |
| 状态管理 | **zustand `~4.4.7`**（配 `immer ~10.1.1`；数据请求用 `swr ~2.2.4`；另有 rxjs） | `apps/chat/package.json` dependencies |
| 路由 | react-router-dom `^6.16.0`（lock 6.30.4） | `apps/chat/package.json` |
| 样式方案 | **CSS Modules（`*.module.css`）+ PostCSS**（postcss-nested、postcss-custom-media、@csstools/postcss-global-data、autoprefixer）；类型用 `typed-css-modules`（tcm）生成 `.css.d.ts`；类名工具 `clsx`。无 tailwind/less/styled-components | `apps/chat/rspack.config.ts`（`css/auto` + `createPostcssUse`）、`shared/rspack-postcss-rule/index.ts`、`apps/chat/package.json` |
| SVG | `@svgr/webpack ^8.1.0`（`?url` 走 asset，其余 tsx 引用走 SVGR 组件） | `apps/chat/rspack.config.ts` |
| Lint/格式化 | oxlint `1.63.0` + oxfmt `0.48.0`（非 eslint/prettier） | `apps/chat/package.json` |
| 测试 | vitest `~4.0.18` | `apps/chat/package.json` |
| Node 版本 | `>=20.19.0 <21.0.0 \|\| >=22.12.0 <23.0.0 \|\| >=26.0.0 <27.0.0` | `rush.json` `nodeSupportedVersionRange` |
| 包管理器 | Rush `5.175.1` + pnpm `10.33.4`（`useWorkspaces: true`，无独立 packageManager 字段） | `rush.json`、`common/config/rush/pnpm-config.json` |
| npm registry | `https://registry.npmmirror.com` | `common/config/rush/.npmrc` |

## 2. build/dev 脚本清单（apps/chat/package.json scripts，构建相关）

- `dev` → `rushx dev:staging`；`dev:staging` = `DEPLOY_ENV=staging rspack serve -c rspack.config.ts`（dev server 需要 `DEPLOY_ENV` 环境变量，否则 config 直接 throw）
- `dev:production` = `DEPLOY_ENV=production rspack serve ...`
- `devc` = 杀 8080 进程 + `run-p dev tcm:watch watch:deps`（并行跑 dev server、CSS Modules 类型 watch、上游依赖 watch）
- `build` = lint + type + test + 清 dist + `rspack build -c rspack.config.ts` + 产物语法兼容检查（`check:bundle-compat`）
- `build:production` / `build:staging` = 设 `DEPLOY_ENV` 后走 `build`
- `rspack` = `rspack build -c rspack.config.ts`
- `analyze` = `RSDOCTOR=true ... rspack build`（Rsdoctor 分析）
- `type` = 并行：`tcm`（生成 css.d.ts）+ `tsc -p tsconfig.scripts.json` + `tsc -p src/tsconfig.json`（全部 noEmit，类型检查与打包分离）
- `tcm` / `tcm:watch` = `typed-css-modules` 扫 `src/**/*.module.css`
- `test` = `vitest --run __tests__`
- `preview` = `rspack serve -c rspack.preview.config.ts`

## 3. 构建配置要点（rspack.config.ts；Vite 骨架对齐参考）

- **入口/产物**：entry `./src/index.tsx`；输出 `static/[name].[contenthash:10].js`，dev 用无 hash 名；`publicPath` 生产走 CDN（`https://fe-static.deepseek.com/chat/`），dev 为 `/`。
- **HTML**：`HtmlRspackPlugin` 两份模板 `src/index.html` 与 `src/share.html`（多页），模板参数注入 git commit id 与内联 analytics 脚本。
- **浏览器 target / polyfill**：swc `env.targets = ['ios >= 12', 'chrome >= 66']`，`mode: 'usage'` + `core-js 3.41`（`shared/rspack-base-config/browserTargets.cjs`）。仓库无 browserslist 文件，target 就是这份常量。
- **JSX/TS 转换**：`builtin:swc-loader`，typescript+tsx 语法，`react.runtime: 'automatic'`，dev 开 `development` + `refresh`。
- **CSS**：原生 `css/auto`（rspack 内置 CSS Modules，`namedExports: false`，生产 localIdentName `[hash:8]`）+ postcss-loader（nested / custom-media / global-data 注入共享 media.css / autoprefixer）。
- **别名**：仅 `core-js` 与 `@swc/helpers` 指到 resolve 出的包目录（保证单实例），**没有 `@/` → `src` 之类的路径别名**；`resolve.extensions = ['.tsx', '.ts', '.js']`。
- **dev server**：staging 端口 8080 / production 8090，`historyApiFallback: true`，`/api` 等前缀 proxy 到 `https://chat-dev.deepseek.com`（或生产域名），`allowedHosts: 'all'`。
- **特殊产物**：SRI（子资源完整性）插件、sourcemap 上传插件、`NormalModuleReplacementPlugin` 按环境替换 debug 模块、splitChunks 手工分 vendors/mermaid/katex/prismjs 分组——这些属于该产品线定制，新骨架不需要。

## 4. tsconfig 关键 compilerOptions

`apps/chat/src/tsconfig.json` extends `../tsconfig.web.json` extends `@deepseek/tsconfig-base/tsconfig.json`（`shared/tsconfig-base/tsconfig.json`），叠加后 web 源码生效值：

- `strict: true`（另显式 `noImplicitAny`、`useUnknownInCatchVariables`）
- `target: "ESNext"`，`lib: ["DOM", "DOM.Iterable", "ESNext"]`
- `module: "ESNext"`，`moduleResolution: "Bundler"`（base 里是 CommonJS，web 层覆写）
- `jsx: "react-jsx"`
- `noEmit: true`、`isolatedModules: true`、`skipLibCheck: true`
- `noUnusedLocals` / `noUnusedParameters` / `noImplicitOverride` / `noImplicitReturns`、`checkJs: true`
- `allowSyntheticDefaultImports: true`；src 层 `types: ["react", "react-dom"]`

## 5. 目录组织要点

`apps/chat/src/` 一级结构：`index.html` + `share.html`（HTML 模板在 src 内，非仓根）、入口 `index.tsx`（副作用 setup 一串 + `App.tsx`）、`router.tsx` / `setupRouter.ts` / `routes/`（react-router v6）、`components/`（每组件一目录，`Foo.tsx` + `Foo.module.css` + 生成的 `.css.d.ts`）、`store/`（zustand 各 store 按文件拆分）、`service/`、`models/`、`hooks/`、`jobs/`（启动任务）、`utils/`、`i18n/`、`style/`（global.css）、`assets/`、`config/`，另有 `css.d.ts` / `svg.ts` / `shims.d.ts` 等全局声明。React 挂载（`createRoot`）封装在共享包 `packages/app-kit-web` 的 app 框架内，业务入口只做 setup + 配置。

## 对新 React + Vite 骨架的启示（简结）

可直接继承的基线：React 18 + react-dom 18、TS strict + `jsx: react-jsx` + `module: ESNext` + `moduleResolution: Bundler`、zustand（+immer）状态、CSS Modules + clsx 样式、react-router v6、pnpm + Node 22。
这些继续依赖他们

构建器一项无法照搬（对方是 Rspack），Vite 侧等效物：`@vitejs/plugin-react`（swc 版可选）替代 builtin:swc-loader + react-refresh；Vite 原生 CSS Modules 替代 `css/auto` + tcm；`server.proxy` 替代 devServer.proxy；`build.target` 若无需老浏览器可不必带 core-js polyfill 链。
我们继续使用 vite，主要考虑到后面会用他们的模块
