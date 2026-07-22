/**
 * i18n plugin, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader (load and lifecycle follow
 * the host; the browser half ships via exports["./client"], discovered
 * through the package.json dshClient declaration). Everything else —
 * I18nService, Translate, LocaleDict — lives in the client half; consumers
 * import the /client subpath. Contract: api-contracts v3 section 8.
 */

/** Host plugin body — no host-side behavior for the i18n plugin. */
export function apply(): void {}
