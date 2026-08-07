/**
 * The preset picker both surfaces render: a menu of presets over a button
 * naming the current one.
 *
 * The settings row and the composer seat differ in where they sit, what they
 * call the current value, and when they refuse a pick — not in how the picker
 * itself behaves. Trust is the one thing the list always says: a locally
 * authored preset is exactly as privileged as the plugins it names, so the
 * label marks it rather than presenting every preset as shipped and vetted.
 */

import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetOption } from './settings-store.ts'

/** What one surface passes to the shared picker. */
export interface PresetMenuProps {
  /** Presets to offer, in roster order. */
  options: readonly AgentPresetOption[]
  /** The preset the button names and the menu marks selected. */
  selectedId: string
  /** Text on the button; the surfaces word a pending roster differently. */
  label: string
  /** Suffix marking a locally authored preset in the menu. */
  userTrustLabel: string
  /** Class for the trigger button, owned by the calling surface. */
  buttonClassName: string | undefined
  /** Class for the chevron, owned by the calling surface. */
  chevronClassName: string | undefined
  /** Whether the trigger refuses interaction. */
  disabled: boolean
  /** Native tooltip, absent where the surface offers none. */
  title?: string
  /** Whether the menu is open — the surface owns this so it can force it shut. */
  open: boolean
  /** Report the menu's next open state. */
  onOpenChange: (open: boolean) => void
  /** Called with the picked preset once the menu has closed. */
  onSelect: (id: string) => void
}

/**
 * Render the preset picker.
 * @param props - the calling surface's copy, styling, and handlers.
 * @returns the menu and its trigger.
 */
export function PresetMenu({
  options, selectedId, label, userTrustLabel, buttonClassName, chevronClassName,
  disabled, title, open, onOpenChange, onSelect,
}: PresetMenuProps) {
  return (
    <Menu
      open={open}
      onClose={() => { onOpenChange(false) }}
      items={options.map(option => ({
        id: option.id,
        label: option.trust === 'user' ? `${option.id} · ${userTrustLabel}` : option.id,
      }))}
      selectedId={selectedId}
      onSelect={(id) => {
        onOpenChange(false)
        onSelect(id)
      }}
      align="end"
      portal
      anchor={(
        <button
          type="button"
          className={buttonClassName}
          aria-haspopup="menu"
          aria-expanded={open}
          {...title === undefined ? {} : { title }}
          disabled={disabled}
          onClick={() => { onOpenChange(!open) }}
        >
          {label}
          <IconChevronDownOutline14 className={chevronClassName} />
        </button>
      )}
    />
  )
}
