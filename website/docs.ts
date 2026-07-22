/**
 * Canonical publication manifest for the documentation website.
 *
 * Markdown stays in its owning repository tier. This manifest maps each
 * canonical source into matching route trees for both site locales; when a
 * translation is absent, both routes intentionally project the available
 * source instead of copying Markdown.
 */

/** Locale key used by the VitePress site. */
export type DocsLocale = 'root' | 'en'

/** Sidebar collection rendered for one locale and top-level module. */
type DocsSidebar =
  | 'zh-guide'
  | 'zh-develop'
  | 'zh-reference'
  | 'en-guide'
  | 'en-develop'
  | 'en-reference'

/** A page projected into the VitePress source tree. */
export interface DocsPage {
  /** VitePress locale whose route tree owns this projection. */
  locale: DocsLocale
  /** Language of the canonical source currently projected at this route. */
  contentLocale: 'zh-CN' | 'en-US'
  /** Repository-relative canonical Markdown source. */
  source: string
  /** VitePress route, including the `.md` suffix. */
  route: string
  /** Navigation label shown in the sidebar. */
  label: string
  /** Sidebar collection that owns the page, or null for a locale home page. */
  sidebar: DocsSidebar | null
  /** Section label within the sidebar. */
  section: string
  /** Stable order within the section. */
  order: number
  /** Additional repository paths that resolve to this page. */
  sourceAliases?: string[]
}

interface MirroredPage {
  source: string | Record<DocsLocale, string>
  route: string
  contentLocale: DocsPage['contentLocale'] | Record<DocsLocale, DocsPage['contentLocale']>
  label: Record<DocsLocale, string>
  sidebar: Record<DocsLocale, DocsSidebar | null>
  section: Record<DocsLocale, string>
  order: number
  sourceAliases?: string[] | Partial<Record<DocsLocale, string[]>>
}

type PairedPage = Omit<MirroredPage, 'source' | 'contentLocale' | 'sourceAliases'> & {
  /** English side of a sibling `foo.md` / `foo.zh.md` pair. */
  source: string
  /** Language-neutral repository aliases, such as the directory of an index page. */
  sourceAliases?: string[]
}

function localized<T>(value: T | Record<DocsLocale, T>, locale: DocsLocale): T {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<DocsLocale, T>)[locale]
    : value
}

function mirroredPages(pages: MirroredPage[]): DocsPage[] {
  return pages.flatMap(page => (['root', 'en'] as const).map((locale) => {
    const aliases = page.sourceAliases === undefined
      ? undefined
      : Array.isArray(page.sourceAliases) ? page.sourceAliases : page.sourceAliases[locale]
    return {
      locale,
      contentLocale: localized(page.contentLocale, locale),
      source: localized(page.source, locale),
      route: locale === 'root' ? page.route : `en/${page.route}`,
      label: page.label[locale],
      sidebar: page.sidebar[locale],
      section: page.section[locale],
      order: page.order,
      ...(aliases === undefined ? {} : { sourceAliases: aliases }),
    }
  }))
}

function pairedPages(pages: PairedPage[]): DocsPage[] {
  return mirroredPages(pages.map((page) => {
    const chineseSource = page.source.replace(/\.md$/, '.zh.md')
    const sharedAliases = page.sourceAliases ?? []
    return {
      ...page,
      source: { root: chineseSource, en: page.source },
      contentLocale: { root: 'zh-CN', en: 'en-US' },
      sourceAliases: {
        root: [...sharedAliases, page.source],
        en: [...sharedAliases, chineseSource],
      },
    }
  }))
}

const homeAndGuide = pairedPages([
  {
    source: 'docs/user/index.md',
    route: 'index.md',
    label: { root: 'DeepSeek Harness', en: 'DeepSeek Harness' },
    sidebar: { root: null, en: null },
    section: { root: '首页', en: 'Home' },
    order: 0,
  },
  {
    source: 'docs/user/guide/index.md',
    route: 'guide/index.md',
    label: { root: '介绍', en: 'Introduction' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: '入门', en: 'Guide' },
    order: 1,
    sourceAliases: ['docs/user/guide'],
  },
  {
    source: 'docs/user/guide/quickstart.md',
    route: 'guide/quickstart.md',
    label: { root: '快速开始', en: 'Quick start' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: '入门', en: 'Guide' },
    order: 2,
  },
  {
    source: 'docs/user/guide/config.md',
    route: 'guide/config.md',
    label: { root: '配置文件', en: 'Configuration' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: '入门', en: 'Guide' },
    order: 3,
  },
])

const develop = pairedPages([
  {
    source: 'docs/user/develop/basic/index.md',
    route: 'develop/basic/index.md',
    label: { root: '第一个插件', en: 'First plugin' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: '基础', en: 'Basics' },
    order: 1,
    sourceAliases: ['docs/user/develop/basic'],
  },
  {
    source: 'docs/user/develop/basic/tool.md',
    route: 'develop/basic/tool.md',
    label: { root: '开发一个 Tool', en: 'Build a tool' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: '基础', en: 'Basics' },
    order: 2,
  },
  {
    source: 'docs/user/develop/basic/config.md',
    route: 'develop/basic/config.md',
    label: { root: '插件配置', en: 'Plugin configuration' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: '基础', en: 'Basics' },
    order: 3,
  },
  {
    source: 'docs/user/develop/framework/index.md',
    route: 'develop/framework/index.md',
    label: { root: '插件与生命周期', en: 'Plugin lifecycle' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: '框架能力', en: 'Framework' },
    order: 1,
    sourceAliases: ['docs/user/develop/framework'],
  },
  {
    source: 'docs/user/develop/framework/service.md',
    route: 'develop/framework/service.md',
    label: { root: '服务与依赖', en: 'Services and dependencies' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: '框架能力', en: 'Framework' },
    order: 2,
  },
  {
    source: 'docs/user/develop/framework/events.md',
    route: 'develop/framework/events.md',
    label: { root: '事件系统', en: 'Event system' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: '框架能力', en: 'Framework' },
    order: 3,
  },
  {
    source: 'docs/user/develop/practice/index.md',
    route: 'develop/practice/index.md',
    label: { root: '能力的三层拆分', en: 'Capability layering' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: '实战', en: 'Practice' },
    order: 1,
    sourceAliases: ['docs/user/develop/practice'],
  },
  {
    source: 'docs/user/develop/practice/llm-adapter.md',
    route: 'develop/practice/llm-adapter.md',
    label: { root: 'LLM 适配器', en: 'LLM adapter' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: '实战', en: 'Practice' },
    order: 2,
  },
])

const reference = mirroredPages([
  ...([
    ['docs/architecture.md', 'reference/index.md', '架构', 'Architecture'],
    ['docs/cordis-primer.md', 'reference/cordis-primer.md', 'Cordis 入门', 'Cordis primer'],
    ['docs/capability-seams.md', 'reference/capability-seams.md', '能力服务', 'Capability services'],
    ['docs/agent-lifecycle.md', 'reference/agent-lifecycle.md', 'Agent 生命周期', 'Agent lifecycle'],
    ['docs/tool-execution-pipeline.md', 'reference/tool-execution-pipeline.md', 'Tool 执行', 'Tool execution'],
  ] as const).map(([source, route, rootLabel, enLabel], order): MirroredPage => ({
    source,
    route,
    contentLocale: 'en-US',
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: '概念', en: 'Concepts' },
    order,
  })),
  ...([
    ['docs/config-catalog.md', 'reference/config-catalog.md', '插件配置', 'Plugin configuration'],
    ['docs/tool-catalog.md', 'reference/tool-catalog.md', 'Tool Schema', 'Tool schemas'],
    ['docs/cordis-catalog/services.md', 'reference/cordis-catalog/services.md', '服务', 'Services'],
    ['docs/cordis-catalog/events.md', 'reference/cordis-catalog/events.md', '事件', 'Events'],
    ['docs/persistence-catalog.md', 'reference/persistence-catalog.md', '持久化事件', 'Persistence events'],
  ] as const).map(([source, route, rootLabel, enLabel], order): MirroredPage => ({
    source,
    route,
    contentLocale: 'en-US',
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: '生成参考', en: 'Generated reference' },
    order,
  })),
  ...([
    ['context.md', 'Context', 'Context'],
    ['events.md', 'Events', 'Events'],
    ['fiber.md', 'Fiber', 'Fiber'],
    ['registry.md', 'Plugin Registry', 'Plugin Registry'],
    ['service.md', 'Service', 'Service'],
  ] as const).map(([file, rootLabel, enLabel], order): MirroredPage => ({
    source: `docs/cordis-catalog/core/${file}`,
    route: `reference/cordis-api/${file}`,
    contentLocale: 'en-US',
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: 'Cordis API', en: 'Cordis Core API' },
    order,
  })),
  ...([
    ['core.md', '核心数据结构', 'Core data structures'],
    ['scope.md', '作用域', 'Scopes'],
    ['session.md', '会话', 'Sessions'],
    ['goal.md', '目标', 'Goals'],
    ['system-prompt.md', '系统提示词', 'System prompts'],
    ['tools.md', '工具', 'Tools'],
    ['llm-streaming.md', 'LLM 流式响应', 'LLM streaming'],
    ['bash.md', 'Bash 执行', 'Bash execution'],
    ['filesystem.md', '文件系统', 'Filesystem'],
    ['code-runtime.md', '代码运行时', 'Code runtime'],
    ['compaction.md', '上下文压缩', 'Compaction'],
    ['subagent.md', '子代理', 'Subagents'],
    ['workflow.md', '工作流', 'Workflows'],
    ['skills.md', '技能', 'Skills'],
    ['approval.md', '审批', 'Approvals'],
    ['user-interaction.md', '用户交互', 'User interaction'],
    ['commands.md', '命令', 'Human commands'],
    ['sandbox.md', '沙箱', 'Sandboxing'],
    ['web.md', 'Web 访问', 'Web access'],
    ['persistence.md', '会话持久化', 'Session persistence'],
  ] as const).map(([file, rootLabel, enLabel], order): MirroredPage => ({
    source: `docs/core-data-structures/${file}`,
    route: `reference/core-data-structures/${file}`,
    contentLocale: 'en-US',
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: '数据结构', en: 'Data structures' },
    order,
    ...(file === 'core.md' ? { sourceAliases: ['docs/core-data-structures'] } : {}),
  })),
  ...([
    ['adding-a-package.md', '新增 Package', 'Adding a package'],
    ['adding-a-tool.md', '新增 Tool', 'Adding a tool'],
    ['adding-an-llm-adapter.md', '新增 LLM Adapter', 'Adding an LLM adapter'],
    ['extension-cookbook.md', '扩展模式', 'Extension patterns'],
  ] as const).map(([file, rootLabel, enLabel], order): MirroredPage => ({
    source: `docs/cookbook/${file}`,
    route: `reference/cookbook/${file}`,
    contentLocale: 'en-US',
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: '开发手册', en: 'Cookbook' },
    order,
  })),
])

/** Every canonical page published by the documentation website. */
export const docsPages: DocsPage[] = [
  ...homeAndGuide,
  ...develop,
  ...reference,
]
