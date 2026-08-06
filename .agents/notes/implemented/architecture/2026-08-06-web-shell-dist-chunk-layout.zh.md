# Agent Note: Web 壳产物的 chunk 切分与目录布局

Status: implemented

[English](2026-08-06-web-shell-dist-chunk-layout.md) | 中文

## Problem

apps/web 的壳此前打成单一约 1.2 MB（minified）的 index chunk，其中约八成是 vendor 字节——KaTeX、boot 语法与 shiki 引擎、react-dom、markdown 管线——与全部 workspace 壳代码（约五分之一）熔在一起。任何一行壳代码改动都让整个 chunk 换哈希，回头客户端全量重新下载；`dist/assets/` 是 100 多个文件的单层平铺（主 chunk、23 个懒加载语法 chunk、59 个 KaTeX 字体面、sourcemap 混居），无从导航。

## Decision

`apps/web/vite.config.ts` 以 `manualChunks` 把壳切成两个初始 chunk，并以输出命名函数归类目录；整套配置零正则——精确包名 Set、文件名清单、扩展名清单。

**成员归属**（`VENDOR_PACKAGES`，按精确 npm 包名）：

- `vendor` = 三个重渲染家族的**门面包**：math（katex、rehype-katex）、highlight（shiki）、markdown（react-markdown、remark-gfm、remark-math、mdast-util-from-markdown、mdast-util-gfm、micromark-extension-gfm、micromark-extension-math、micromark-factory-space、micromark-util-character、micromark-util-symbol、micromark-util-types）。清单只需列 workspace 代码**直接 import** 的包：私有传递依赖（unified/hast 系、oniguruma 系、@shikijs/core 等数十个）只被这些门面引用，rollup 的 chunk 着色自动将其并入 vendor；与 index 侧共享的依赖回落 index，只稀释几 KB，不构成正确性问题。
- `index`（默认 chunk）= react 族、vendored cordis、全部 workspace 代码及未列入的小件（anser、clsx）。
- `@shikijs/langs` 特判：boot 语法（`BOOT_GRAMMAR_FILES`：typescript、shellscript、json——highlight.ts 静态 import 的三件，均为零内部 import 的自含数据模块）进 vendor；其余 23 个懒加载语法不做指派，各自保持按需 chunk。
- `index.html` 由 vite 自动接线：index 走 `<script>`、vendor 走 `<link rel="modulepreload">`，两 chunk 并行拉取，无瀑布。

**目录布局**（`chunkFileNames` + `assetFileNames`）：

- `assets/` 根只留 index 与 vendor 的 js（含随行 sourcemap）与 css。
- 语法 chunk 归 `assets/langs/`。判据是 chunk 的 `moduleIds` 含 `@shikijs/langs` 成员，而非 facade：内嵌语法共享 chunk（php/ruby/mdx 内嵌 html+javascript，被 rollup 拆出共享）**没有 facade**，facade 判据会漏；index/vendor 按名排除，因 vendor 合法携带 boot 三语法。
- 字体归 `assets/fonts/`（`FONT_EXTENSIONS`：woff2/woff/ttf；今日全部为 vendor.css 引用的 KaTeX 字面，浏览器按需只拉 woff2，且仅在公式渲染时）。
- sourcemap 无需安排：rollup 把 `.map` 写在各自 js 旁并以裸相对文件名引用，chunk 挪目录 map 自动跟随。

跨目录引用（index 的动态 import 指向 `langs/`、语法 chunk 间同目录相对引用、vendor.css 相对引用 `fonts/`）均由构建器生成，运行时零配套改动；host 侧 webserver 按静态前缀原样服务嵌套路径。

## Alternatives considered

- **react 等 vendor 走 CDN**：dsh web 面向本机/内网主机（常无外网），CDN 直接不可用；react 是全部插件 bundle 的 platform seed external（壳是唯一供给方），改 CDN 全局变量形态需牵动 platform 清单/seed/模块表三处；缓存收益由 vendor 切分即可取得。
- **反向兜底规则（node_modules 除 react 族全归 vendor）**：成员从配置上读不出来，且把 anser/clsx 类小件错归 vendor；被正向精确包名清单取代。
- **正则家族匹配**：可读性差；精确包名 + rollup 对传递依赖的自动着色使模式匹配没有必要。
- **以 facadeModuleId 识别语法 chunk**：无 facade 的内嵌语法共享 chunk 会漏检落回根目录；`moduleIds` 成员判据覆盖两种形态。
- **KaTeX 整体懒加载、boot TypeScript 语法转懒**：会改变首帧渲染行为（公式/首个代码块的回退），是独立于产物布局的取舍，另行决策。

## Verification

sourcemap 字节归属审计证明 vendor 不含任何 workspace 字节、index 的 npm 侧仅剩 react 族与 anser/clsx；懒语法 chunk 数量与 `LAZY_GRAMMARS` 表一一对应；浏览器 keyless replay 用例与改动前基线逐字一致（本机环境性红除外），两 chunk 壳装载渲染无回归。

## Consequences

- 壳代码改动只重哈希 index（约为产物三分之一）；vendor（约三分之二）跨壳版本缓存稳定，仅依赖升级时失效。
- `dist/assets/` 可导航：根两对 js/css，`langs/` 按需语法，`fonts/` 字体。
- 维护成本：workspace 代码新增对某渲染家族门面包的直接 import 时需同步 `VENDOR_PACKAGES`（漏列仅稀释 index，不致坏）；在 highlight.ts 扩 boot 语法集而未同步 `BOOT_GRAMMAR_FILES` 时，该语法静默落入 index，仅产物审计可见。
- webserver 静态面尚无压缩，gzip 体量是潜在值；传输层压缩是另一项独立决策。
