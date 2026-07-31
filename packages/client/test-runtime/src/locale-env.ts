/**
 * Browser-language pin for specs that assert localized copy. A fresh
 * LocaleService with no stored preference opens in the language `navigator`
 * asks for, and jsdom reports the runner's own (`en-US`) — so a spec asserting
 * the product's Chinese copy states the browser it assumes instead of
 * inheriting the machine's.
 */

/**
 * Override `navigator.languages`/`navigator.language` for the current spec.
 * @param primary - most preferred BCP 47 tag; also becomes `navigator.language`.
 * @param rest - further tags in preference order.
 * @returns restore function handing the properties back to the environment.
 */
export function pinBrowserLanguages(primary: string, ...rest: string[]): () => void {
  Object.defineProperty(navigator, 'languages', { value: [primary, ...rest], configurable: true })
  Object.defineProperty(navigator, 'language', { value: primary, configurable: true })
  return () => {
    // Deleting the own properties uncovers the environment's own accessors
    // again (Navigator declares both readonly, hence the erased receiver).
    const own = navigator as unknown as Record<string, unknown>
    delete own.languages
    delete own.language
  }
}
