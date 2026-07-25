/**
 * Settings-surface slot merge consumed by this package's Language row. The
 * AUTHORITATIVE home for 'settings.general.item' is the ui-settings contract
 * (declaring is claiming: the shell's General entry declares the slot); this
 * file repeats the entry verbatim because the shell consumes ctx.locale
 * (project reference ui-settings -> locale), so importing the shell's types
 * from here would close a reference cycle. TypeScript declaration merging
 * rejects diverging duplicates, so every program that sees both copies (the
 * shell's own build, the client aggregate) enforces identity.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One preference row inside the General section (duplicate-identical merge; authority: ui-settings contract). */
    'settings.general.item': { kind: 'list'; scope: 'root'; owner: { children?: never } }
  }
}

export {}
