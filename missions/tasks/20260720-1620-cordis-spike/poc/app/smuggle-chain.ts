/**
 * The cascade middle file: looks client-safe by name and signature, but its
 * import chain reaches a node half via echo-b's main entry. Under the
 * conditions scheme this no longer resolves in a client program (TS2307 right
 * here) — the file itself goes red, unlike the old file-set scheme where the
 * pollution was silent at the import site.
 */
import { createEchoB } from '@dsh-spike/echo-b'

/** Innocent-looking helper whose closure smuggles echo-b's node half. */
export function smuggledEcho(text: string): string {
  return createEchoB('/tmp').echo(text)
}
