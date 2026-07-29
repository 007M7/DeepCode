// Shared chrome helpers for user/assistant IconActions rows: clipboard write
// and the compact date+clock label from a session-event epoch.

/**
 * Best-effort clipboard write; rejections stay swallowed (no success chrome).
 * @param text - Plain text to place on the clipboard.
 */
export async function writeClipboard(text: string): Promise<void> {
  // lib.dom types clipboard non-optional, but insecure contexts omit it —
  // that runtime gap is exactly what this guard detects.
  /* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition */
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Denied permissions / iframe policy.
    }
    return
  }
  // execCommand('copy') is the only clipboard fallback where the async API
  // is missing (insecure contexts); deprecated but deliberately retained.
  /* eslint-disable @typescript-eslint/no-deprecated */
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    exec('copy')
  } catch {
    // Clipboard unavailable; the button stays idle.
  }
  /* eslint-enable @typescript-eslint/no-deprecated */
  el.remove()
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Local calendar-day epoch (ms at local midnight) for an instant.
 * @param ms - Unix epoch ms.
 * @returns Midnight of that local calendar day.
 */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Delay until the next local midnight after `ms` (at least 1ms).
 * @param ms - Unix epoch ms.
 * @returns Milliseconds until the following local midnight.
 */
export function msUntilNextLocalMidnight(ms: number): number {
  const next = new Date(ms)
  next.setHours(24, 0, 0, 0)
  return Math.max(next.getTime() - ms, 1)
}

/**
 * Compact local timestamp for message IconActions.
 * Same calendar day → `HH:mm`; earlier this year → `M月D日 HH:mm`;
 * other years → `YYYY年M月D日 HH:mm`.
 * @param time - Unix epoch ms from the source session event.
 * @param now - Reference instant for the day/year cut (defaults to wall clock).
 * @returns Date-aware clock string (24-hour, zero-padded time).
 */
export function formatMessageClock(time: number, now: number = Date.now()): string {
  const d = new Date(time)
  const n = new Date(now)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (
    d.getFullYear() === n.getFullYear()
    && d.getMonth() === n.getMonth()
    && d.getDate() === n.getDate()
  ) {
    return clock
  }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  if (d.getFullYear() === n.getFullYear()) return `${md} ${clock}`
  return `${d.getFullYear()}年${md} ${clock}`
}
