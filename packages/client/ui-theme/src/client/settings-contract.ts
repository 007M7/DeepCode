/**
 * Settings-surface slot merge consumed by this package's Appearance row. The
 * AUTHORITATIVE home for 'settings.general.item' is the ui-settings contract
 * (declaring is claiming: the shell's General entry declares the slot); this
 * file repeats the entry verbatim because the settings shell sits above the
 * feature layer, so importing its types from here would invert the layering.
 * TypeScript declaration merging rejects diverging duplicates, so every
 * program that sees both copies enforces identity.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One preference row inside the General section (duplicate-identical merge; authority: ui-settings contract). */
    'settings.general.item': { kind: 'list'; scope: 'root'; owner: { children?: never } }
  }
}

export {}
