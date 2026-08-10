import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

/** PNG signature per the PNG specification. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  expect(index).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />')
  // The SVG must stay declared after the PNG: the HTML spec selects the last
  // equally appropriate icon, so SVG-capable browsers get the adaptive SVG
  // while Safari versions before 26 fall back to the PNG.
  expect(index.indexOf('/favicon-32x32.png')).toBeLessThan(index.indexOf('/favicon.svg'))

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [
      {
        src: '/favicon-32x32.png',
        sizes: '32x32',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  })
})

it('ships the PNG fallback as a valid non-empty 32x32 image', async () => {
  const png = await readFile(join(DIST_ROOT, 'favicon-32x32.png'))
  expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE)
  expect(png.readUInt32BE(16)).toBe(32)
  expect(png.readUInt32BE(20)).toBe(32)
  expect(png.length).toBeGreaterThan(0)
})

it('ships a favicon that switches to a light mark under dark color scheme', async () => {
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  // The light fill must live inside the dark-scheme media query, so the icon
  // stays black in light mode and only turns white under a dark scheme.
  expect(favicon).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*path\s*{[^}]*fill:\s*#fff/i)
  expect(favicon).toContain('fill="#000"')
})
