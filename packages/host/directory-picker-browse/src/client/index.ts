/**
 * Browser half of the browse directory-picker backend: fills ui-workspace's
 * two directory-flow holes with the in-app Select Workspace Directory dialog
 * (figma `Harness` 813-23126 family), driving the node half's
 * `host.listDirectory`/`host.createDirectory` primitives. Mounting this
 * package therefore composes both sides of the browse interaction with one
 * cordis.yml row; no client code branches on a capability kind. The dialog's
 * copy is locale-registered here — the flow package owns its own strings.
 */
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { deferRegistration } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext, DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the SlotMap merge declaring the directory-flow holes and their owner contract.
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DirectoryBrowser } from './DirectoryBrowser.tsx'

/** Locale namespace owning the browser dialog's copy. */
const LOCALE_NS = 'directory-browser'

/** Injected face: the browse wire calls and copy the dialog drives (bound in apply's closure). */
interface BrowseFlowInjected {
  /** List one directory level (absent path = the Host home directory). */
  listDirectory: (path?: string) => Promise<DirectoryListing>
  /** Create one child directory under an existing parent. */
  createDirectory: (path: string, name: string) => Promise<string>
  /** Localized dialog copy (this package's namespace). */
  t: Translate
}

/**
 * Flow occupant: adapts the hole's owner conversation onto the browser
 * dialog — a confirmed directory is the picked path, dismissal is the
 * cancellation. Browse failures (unreadable targets, create conflicts) stay
 * inside the dialog's own alert surfaces, so the owner's `onError` arm is
 * never driven by this occupant.
 * @param props - owner conversation plus the injected browse face.
 * @returns the dialog element (renders nothing while closed).
 */
export function BrowseDirectoryFlow(props: DirectoryFlowOwnerProps & BrowseFlowInjected): ReactElement {
  return createElement(DirectoryBrowser, {
    open: props.open,
    busy: props.busy,
    listDirectory: props.listDirectory,
    createDirectory: props.createDirectory,
    t: props.t,
    onOpen: props.onPicked,
    onClose: props.onCancel,
  })
}

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
    const deferred = [
      deferRegistration(ctx.slots, 'conversation.hero.workspace.directoryFlow', BrowseDirectoryFlow, () =>
        ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', inject: injected }, BrowseDirectoryFlow)),
      deferRegistration(ctx.slots, 'sidebar.workspaces.directoryFlow', BrowseDirectoryFlow, () =>
        ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject: injected }, BrowseDirectoryFlow)),
    ]
    return () => { for (const entry of deferred) entry.dispose() }
  }, 'directory-picker-browse: flow registrations')
}
