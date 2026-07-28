/**
 * Dialog backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `dialog` capability, opening one native OS chooser on the host
 * display per pick (macOS `osascript`, Windows STA PowerShell
 * `FolderBrowserDialog`, Linux Zenity with a KDialog fallback). Only viable
 * when the operator sits at the host's screen; remote deployments compose the
 * browse backend instead.
 * @module @deepseek-ai/dsh-host-directory-picker-dialog
 */

import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { pickNativeDirectory } from './native-picker.ts'

export type { DirectoryPickerInternals, DirectoryPickerRunner } from './native-picker.ts'
export { pickNativeDirectory } from './native-picker.ts'

/** The `ctx.directoryPicker` dialog implementation (stable capability object per service life). */
export default class DialogDirectoryPicker extends DirectoryPicker {
  private readonly dialogCapability: DirectoryPickerCapability = {
    kind: 'dialog',
    /* v8 ignore next -- pure forward to pickNativeDirectory (its spec owns behavior); invoking here opens a real chooser. */
    pick: signal => pickNativeDirectory(signal),
  }

  /**
   * The dialog interaction capability.
   * @returns the stable `dialog` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.dialogCapability
  }
}
