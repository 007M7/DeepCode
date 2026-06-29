/**
 * `LocalFetchProvider`: a `WebFetchProvider` that retrieves a concrete public
 * HTTP(S) URL with the platform-native `fetch` (Node 24) and returns a status
 * code plus bounded decoded content. It owns SAFE RESOURCE RETRIEVAL — URL
 * validation, redirect policy, timeout, abort, byte caps, charset decoding,
 * content-type classification, binary rejection — but NOT presentation
 * (HTML→markdown lives in `@deepseek-ai/dsh-tool-web`).
 *
 * Redirects are followed manually (`redirect: 'manual'`) so the provider can
 * enforce a same-origin-only policy: a cross-origin redirect is refused with
 * `WEB_REDIRECT_BLOCKED`, requiring a fresh tool call (Claude Code's WebFetch
 * uses the same model). It does NOT carry browser cookies, editor/git
 * credentials, or implicit access to private services.
 *
 * SSRF / private-network protection is DEFERRED (see the package RFC); until it
 * lands this provider is an SSRF primitive and must not be enabled where it can
 * reach sensitive internal targets.
 *
 * @module @deepseek-ai/dsh-web-fetch-local/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult, WebProviderStatus } from '@deepseek-ai/dsh-web'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.ts'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface LocalFetchLimits {
  /** Maximum accepted request URL length. */
  maxUrlLength: number
  /** Maximum response body size in bytes (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs: number
  /** Upper bound for a per-request timeout override. */
  maxTimeoutMs: number
  /** Maximum number of (same-origin) redirect hops to follow. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
}

/** Stable id this provider registers under. */
export const LOCAL_FETCH_PROVIDER_ID = 'local-http'

/** The anonymous public HTTP(S) fetch provider. */
export class LocalFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  constructor(private readonly limits: LocalFetchLimits) {}

  /** No credentials to check — an anonymous public fetcher is always usable. */
  status(): WebProviderStatus {
    return { available: true }
  }

  async fetch(request: WebFetchRequest, exec?: { readonly signal?: AbortSignal }): Promise<WebFetchResult> {
    const timeoutMs = request.timeoutMs !== undefined
      ? Math.min(request.timeoutMs, this.limits.maxTimeoutMs)
      : this.limits.timeoutMs

    // One controller drives both the caller's abort and our own timeout, so the
    // network request and the streaming read both stop on either.
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    if (exec?.signal !== undefined) {
      if (exec.signal.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
      exec.signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => { controller.abort(new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT')) }, timeoutMs)

    try {
      return await this.followAndRead(request.url, controller)
    } finally {
      clearTimeout(timer)
      if (exec?.signal !== undefined) exec.signal.removeEventListener('abort', onAbort)
    }
  }

  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  private async followAndRead(initialUrl: string, controller: AbortController): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl, this.limits.maxUrlLength)
    let redirectsFollowed = 0

    for (;;) {
      const response = await this.requestOnce(currentUrl, controller)

      if (isRedirectStatus(response.status)) {
        // The redirect budget is enforced BEFORE this hop's target is resolved
        // or origin-checked, so `maxRedirects: N` follows at most N redirects
        // exactly: the (N+1)th redirect is refused as "exceeded" regardless of
        // where it points (a same-origin/cross-origin distinction on a hop we
        // are not allowed to follow would be the wrong diagnosis).
        if (redirectsFollowed >= this.limits.maxRedirects) {
          await response.body?.cancel()
          throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        const location = response.headers.get('location')
        if (location === null) {
          // A redirect status with no Location is not a usable resource. Cancel
          // the (possibly streaming) body before throwing so no socket leaks.
          await response.body?.cancel()
          throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
        }
        const target = resolveRedirect(location, currentUrl)
        // Re-validate the target against the same transport hygiene a direct
        // request gets: a redirect must not be a back door to a credentialed,
        // non-http(s), or over-long URL that validateFetchUrl would reject. A
        // rejection here must still cancel the body first (see below).
        let validatedTarget: URL
        try {
          validatedTarget = validateFetchUrl(target.toString(), this.limits.maxUrlLength)
          if (!isSameOrigin(validatedTarget, currentUrl)) {
            throw new WebError(
              `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
              'WEB_REDIRECT_BLOCKED',
            )
          }
        } catch (error: unknown) {
          await response.body?.cancel()
          throw error
        }
        await response.body?.cancel()
        currentUrl = validatedTarget
        redirectsFollowed++
        continue
      }

      return await this.readBody(response, currentUrl, controller.signal)
    }
  }

  private async requestOnce(url: URL, controller: AbortController): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': this.limits.userAgent, 'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8' },
        signal: controller.signal,
      })
    } catch (error: unknown) {
      throw translateAbortOrNetwork(error, controller.signal)
    }
  }

  /** Read, byte-cap, classify, and decode the final response body. */
  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    // Resolve the decoder BEFORE reading the body so an unsupported charset
    // fails without consuming the stream — but cancel the body on that failure
    // so the socket does not leak (matching the unsupported-content-type path).
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      providerId: this.id,
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response stream up to `maxResponseBytes`. A `Content-Length` over
   * the cap rejects immediately with `WEB_FETCH_TOO_LARGE`; a stream that grows
   * past the cap is cut short (`truncatedByBytes`) rather than rejected, so a
   * server that under-reports still yields a bounded usable body.
   */
  private async readCapped(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        // Only DROPPED bytes count as truncation: a chunk that exactly fills the
        // remaining capacity keeps all its bytes and we read on to observe EOF,
        // so an exactly-at-cap body is not falsely flagged truncated.
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      /* v8 ignore next -- mid-stream read fault needs a network drop after headers; translate path covered by request-phase tests. */
      throw translateAbortOrNetwork(error, signal)
    } finally {
      /* v8 ignore next 4 -- cancel() after a completed/broken read settles without rejecting; unobserved best-effort cleanup. */
      await reader.cancel().catch(() => {
        // Cancel after a successful read (or after we broke past the cap) is
        // best-effort cleanup; the bytes we need are already collected.
      })
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Resolve a (possibly relative) `Location` against the current URL. */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- URL resolution against a valid absolute base effectively never throws; defensive guard. */
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Translate a thrown fetch/stream error into a `WebError`. Our own
 * `WEB_FETCH_TIMEOUT` (passed to `controller.abort(reason)`) and any other
 * already-typed `WebError` pass through; an `AbortError` becomes `WEB_ABORTED`,
 * UNLESS the abort was our timeout — the body-read reader surfaces a generic
 * `AbortError` rather than the abort reason, so we recover the timeout's
 * `WebError` from `signal.reason`; anything else is a transport/network failure
 * (`WEB_PROVIDER_ERROR`).
 */
function translateAbortOrNetwork(error: unknown, signal?: AbortSignal): WebError {
  if (error instanceof WebError) return error
  if (error instanceof DOMException && error.name === 'AbortError') {
    // A timeout abort carries its WebError as the signal reason; honor the
    // WEB_FETCH_TIMEOUT contract instead of reporting a generic cancellation.
    // (Node rejects WITH the reason — the WebError branch above — so this only
    // fires on a runtime that surfaces a bare AbortError while reason is set.)
    /* v8 ignore next */
    if (signal?.reason instanceof WebError) return signal.reason
    return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  }
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
