/**
 * Browser half of the browse directory-picker backend: fills ui-workspace's
 * two directory-flow holes with the in-app Select Workspace Directory dialog
 * (figma `Harness` 813-23126 family), driving the node half's
 * `host.listDirectory`/`host.createDirectory` primitives. Mounting this
 * package therefore composes both sides of the browse interaction with one
 * cordis.yml row; no client code branches on a capability kind. The dialog's
 * copy is locale-registered here — the flow package owns its own strings.
 */
import { deferRegistration } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap merge declaring the directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { BrowseFlowInjected } from './flow.ts'
import { BrowseDirectoryFlow } from './flow.ts'

/** Locale namespace owning the browser dialog's copy. */
const LOCALE_NS = 'directory-browser'

/** Required services (cordis fiber inject): the slot registry, the wire-facing workspace service, and locale. */
export const inject = ['slots', 'workspaces', 'locale']

/**
 * Client plugin body: register the dialog's dictionaries and the browse flow
 * into both directory-flow holes (declaration-aware deferral — the declaring
 * ui-workspace entries may activate later, and an HMR collapse re-declares).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(LOCALE_NS, 'zh', {
        'browser.title': '选择工作区目录',
        'browser.home': '主目录',
        'browser.newFolder': '新建文件夹',
        'browser.folderName': '文件夹名称',
        'browser.createIn': '在"{name}"中新建文件夹',
        'browser.untitledFolder': '未命名文件夹',
        'browser.create': '创建',
        'browser.cancel': '取消',
        'browser.open': '打开',
        'browser.editPath': '编辑路径',
        'browser.loading': '加载中…',
      }),
      ctx.locale.register(LOCALE_NS, 'en', {
        'browser.title': 'Select Workspace Directory',
        'browser.home': 'Home',
        'browser.newFolder': 'New folder',
        'browser.folderName': 'Folder name',
        'browser.createIn': 'New folder in "{name}"',
        'browser.untitledFolder': 'Untitled folder',
        'browser.create': 'Create',
        'browser.cancel': 'Cancel',
        'browser.open': 'Open',
        'browser.editPath': 'Edit path',
        'browser.loading': 'Loading…',
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'directory-picker-browse: dialog dictionaries')

  const injected = (): BrowseFlowInjected => ({
    listDirectory: path => ctx.workspaces.listDirectory(path),
    createDirectory: (path, name) => ctx.workspaces.createDirectory(path, name),
    t: ctx.locale.bind(LOCALE_NS),
  })
  ctx.effect(() => {
    // Constructing the pair can throw halfway (a declared hole already
    // occupied registers synchronously): roll the earlier deferral back so
    // no live subscription outlives the failed fiber.
    const deferred: ReturnType<typeof deferRegistration>[] = []
    try {
      deferred.push(deferRegistration(ctx.slots, 'conversation.hero.workspace.directoryFlow', BrowseDirectoryFlow, () =>
        ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', inject: injected }, BrowseDirectoryFlow)))
      deferred.push(deferRegistration(ctx.slots, 'sidebar.workspaces.directoryFlow', BrowseDirectoryFlow, () =>
        ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject: injected }, BrowseDirectoryFlow)))
    } catch (error) {
      for (const entry of deferred) entry.dispose()
      throw error
    }
    return () => { for (const entry of deferred) entry.dispose() }
  }, 'directory-picker-browse: flow registrations')
}
