/**
 * Canonical publication manifest for the documentation website.
 *
 * Markdown stays in its owning repository tier. This manifest only maps a
 * source file to its public route and navigation placement.
 */

/** A page projected into the VitePress source tree. */
export interface DocsPage {
  /** Repository-relative canonical Markdown source. */
  source: string
  /** VitePress route, including the `.md` suffix. */
  route: string
  /** Navigation label shown in the sidebar. */
  label: string
  /** Sidebar collection that owns the page. */
  sidebar: 'zh-guide' | 'zh-develop' | 'en-docs'
  /** Section label within the sidebar. */
  section: string
  /** Stable order within the section. */
  order: number
  /** Additional repository paths that resolve to this page. */
  sourceAliases?: string[]
}

const zhGuide: DocsPage[] = [
  {
    source: 'docs/user/zh-CN/index.md',
    route: 'index.md',
    label: 'DeepSeek Harness',
    sidebar: 'zh-guide',
    section: '入门',
    order: 0,
  },
  {
    source: 'docs/user/zh-CN/guide/index.md',
    route: 'guide/index.md',
    label: '介绍',
    sidebar: 'zh-guide',
    section: '入门',
    order: 1,
    sourceAliases: ['docs/user/zh-CN/guide'],
  },
  {
    source: 'docs/user/zh-CN/guide/quickstart.md',
    route: 'guide/quickstart.md',
    label: '快速开始',
    sidebar: 'zh-guide',
    section: '入门',
    order: 2,
  },
  {
    source: 'docs/user/zh-CN/guide/config.md',
    route: 'guide/config.md',
    label: '配置文件',
    sidebar: 'zh-guide',
    section: '入门',
    order: 3,
  },
]

const zhDevelop: DocsPage[] = [
  {
    source: 'docs/user/zh-CN/develop/basic/index.md',
    route: 'develop/basic/index.md',
    label: '第一个插件',
    sidebar: 'zh-develop',
    section: '基础',
    order: 1,
    sourceAliases: ['docs/user/zh-CN/develop/basic'],
  },
  {
    source: 'docs/user/zh-CN/develop/basic/tool.md',
    route: 'develop/basic/tool.md',
    label: '开发一个 Tool',
    sidebar: 'zh-develop',
    section: '基础',
    order: 2,
  },
  {
    source: 'docs/user/zh-CN/develop/basic/config.md',
    route: 'develop/basic/config.md',
    label: '插件配置',
    sidebar: 'zh-develop',
    section: '基础',
    order: 3,
  },
  {
    source: 'docs/user/zh-CN/develop/framework/index.md',
    route: 'develop/framework/index.md',
    label: '插件与生命周期',
    sidebar: 'zh-develop',
    section: '框架能力',
    order: 1,
    sourceAliases: ['docs/user/zh-CN/develop/framework'],
  },
  {
    source: 'docs/user/zh-CN/develop/framework/service.md',
    route: 'develop/framework/service.md',
    label: '服务与依赖',
    sidebar: 'zh-develop',
    section: '框架能力',
    order: 2,
  },
  {
    source: 'docs/user/zh-CN/develop/framework/events.md',
    route: 'develop/framework/events.md',
    label: '事件系统',
    sidebar: 'zh-develop',
    section: '框架能力',
    order: 3,
  },
  {
    source: 'docs/user/zh-CN/develop/practice/index.md',
    route: 'develop/practice/index.md',
    label: '能力的三层拆分',
    sidebar: 'zh-develop',
    section: '实战',
    order: 1,
    sourceAliases: ['docs/user/zh-CN/develop/practice'],
  },
  {
    source: 'docs/user/zh-CN/develop/practice/llm-adapter.md',
    route: 'develop/practice/llm-adapter.md',
    label: 'LLM 适配器',
    sidebar: 'zh-develop',
    section: '实战',
    order: 2,
  },
]

const enOverview: DocsPage[] = ([
  ['docs/architecture.md', 'en/index.md', 'Architecture'],
  ['docs/cordis-primer.md', 'en/cordis-primer.md', 'Cordis primer'],
  ['docs/capability-seams.md', 'en/capability-seams.md', 'Capability services'],
  ['docs/agent-lifecycle.md', 'en/agent-lifecycle.md', 'Agent lifecycle'],
  ['docs/tool-execution-pipeline.md', 'en/tool-execution-pipeline.md', 'Tool execution'],
] as const).map(([source, route, label], order) => ({
  source,
  route,
  label,
  sidebar: 'en-docs',
  section: 'Concepts',
  order,
}))

const enCatalogs: DocsPage[] = ([
  ['docs/config-catalog.md', 'en/config-catalog.md', 'Plugin configuration'],
  ['docs/tool-catalog.md', 'en/tool-catalog.md', 'Tool schemas'],
  ['docs/cordis-catalog/services.md', 'en/cordis-catalog/services.md', 'Services'],
  ['docs/cordis-catalog/events.md', 'en/cordis-catalog/events.md', 'Events'],
  ['docs/persistence-catalog.md', 'en/persistence-catalog.md', 'Persistence events'],
] as const).map(([source, route, label], order) => ({
  source,
  route,
  label,
  sidebar: 'en-docs',
  section: 'Generated reference',
  order,
}))

const corePages = [
  ['core.md', 'Core data structures'],
  ['session.md', 'Sessions'],
  ['tools.md', 'Tools'],
  ['llm-streaming.md', 'LLM streaming'],
  ['bash.md', 'Bash execution'],
  ['filesystem.md', 'Filesystem'],
  ['code-runtime.md', 'Code runtime'],
  ['compaction.md', 'Compaction'],
  ['subagent.md', 'Subagents'],
  ['workflow.md', 'Workflows'],
  ['skills.md', 'Skills'],
  ['approval.md', 'Approvals'],
  ['user-interaction.md', 'User interaction'],
  ['sandbox.md', 'Sandboxing'],
  ['web.md', 'Web access'],
  ['persistence.md', 'Session persistence'],
] as const

const enCore: DocsPage[] = corePages.map(([file, label], order) => ({
  source: `docs/core-data-structures/${file}`,
  route: `en/core-data-structures/${file}`,
  label,
  sidebar: 'en-docs',
  section: 'Data structures',
  order,
  ...(file === 'core.md' ? { sourceAliases: ['docs/core-data-structures'] } : {}),
}))

const enCookbook: DocsPage[] = ([
  ['adding-a-package.md', 'Adding a package'],
  ['adding-a-tool.md', 'Adding a tool'],
  ['adding-an-llm-adapter.md', 'Adding an LLM adapter'],
  ['extension-cookbook.md', 'Extension patterns'],
] as const).map(([file, label], order) => ({
  source: `docs/cookbook/${file}`,
  route: `en/cookbook/${file}`,
  label,
  sidebar: 'en-docs',
  section: 'Cookbook',
  order,
}))

/** Every canonical page published by the documentation website. */
export const docsPages: DocsPage[] = [
  ...zhGuide,
  ...zhDevelop,
  ...enOverview,
  ...enCatalogs,
  ...enCore,
  ...enCookbook,
]
