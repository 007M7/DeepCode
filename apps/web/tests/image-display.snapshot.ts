// @vitest-environment jsdom
// Multimodal image surfaces over the BUILT client graph (the code-mode-fixture
// idiom: real bundles via AppWebEntry, keyless FixtureApiClient transport).
// Opens the fixture history session whose turn 73 carries an image in BOTH a
// user message and an assistant message, and pins the product surfaces: the
// history ImageGallery loading real fixture bytes through the authorized
// sessions.attachment route, the single-click ImageLightbox, and the composer
// intake chain (paste → ordered thumbnail rail → image-only send enablement → remove).
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

/** Open the fixture history session (the alpha log carrying the turn-72 image pair) and wait for its gallery. */
async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const group = (await within(tree).findAllByText('fixture'))
    .map(el => el.closest<HTMLElement>('[role="treeitem"]'))
    .find(el => el?.getAttribute('aria-expanded') !== null)
  if (group === null || group === undefined) throw new Error('fixture Workspace group missing')
  if (group.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(within(group).getByText('fixture'))
    await waitFor(() => {
      expect(group.getAttribute('aria-expanded')).toBe('true')
    })
  }
  const session = await within(tree).findByText('Fixture 历史会话')
  fireEvent.click(session)
  await waitFor(() => {
    expect(document.querySelectorAll('[data-align] img').length).toBeGreaterThan(0)
  }, { timeout: 10_000 })
}

it('renders the history image pair through the authorized attachment route and opens the lightbox', async () => {
  mountAssembledApp()
  await openFixtureSession()

  // Both the user-side (align=end) and assistant-side (align=start) galleries
  // load real fixture bytes over sessions.attachment. jsdom provides
  // createObjectURL, so this environment MUST take the object-URL path — a
  // data: src here would mean the fallback ran where it should not.
  await waitFor(() => {
    if (document.querySelector('[data-align="end"] img') === null
      || document.querySelector('[data-align="start"] img') === null) {
      throw new Error('history image galleries missing')
    }
  }, { timeout: 10_000 })
  const galleryShape = (align: string) => [...document.querySelectorAll(`[data-align="${align}"] img`)]
    .map(img => ({ alt: img.getAttribute('alt'), scheme: img.getAttribute('src')?.split(':')[0] }))
  expect({ user: galleryShape('end'), assistant: galleryShape('start') }).toMatchInlineSnapshot(`
    {
      "assistant": [
        {
          "alt": "fixture-image.png",
          "scheme": "blob",
        },
      ],
      "user": [
        {
          "alt": "fixture-image.png",
          "scheme": "blob",
        },
      ],
    }
  `)
  const userImage = document.querySelector<HTMLElement>('[data-align="end"] img')!

  // A single click opens the original-size lightbox; Escape/close dismisses it.
  const frame = userImage.closest('button')
  if (frame === null) throw new Error('image frame button missing')
  fireEvent.click(frame)
  const lightbox = await screen.findByRole('dialog')
  expect(within(lightbox).getByRole('img').getAttribute('src')?.split(':')[0]).toBe('blob')
  fireEvent.click(within(lightbox).getByRole('button', { name: /Close/ }))
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

it('accepts pasted images into the composer rail in order and removes them', async () => {
  mountAssembledApp()

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (start === null) throw new Error('fixture Workspace new-session action missing')
  fireEvent.click(start)

  // Image-only send arming is pinned at package level (input-bar.spec.tsx);
  // this assembled lane pins the intake chain over the built graph.
  const textarea = await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 })
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'pasted.png', { type: 'image/png' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      getData: () => '',
    },
  })

  // The rail is an accessible group holding the draft thumbnail (queried via
  // DOM: jsdom's a11y-visibility computation hides the composer subtree).
  const rail = await waitFor(() => {
    const el = document.querySelector('[role="group"][aria-label="Pending images"]')
    if (el === null) throw new Error('attachment rail missing')
    return el
  }, { timeout: 5_000 })
  expect([...rail.querySelectorAll('img')].map(img => ({
    alt: img.getAttribute('alt'), scheme: img.getAttribute('src')?.split(':')[0],
  }))).toMatchInlineSnapshot(`
    [
      {
        "alt": "pasted.png",
        "scheme": "blob",
      },
    ]
  `)

  const second = new File([new Uint8Array([137, 80, 78, 71])], 'second.png', { type: 'image/png' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => second }],
      getData: () => '',
    },
  })
  await waitFor(() => {
    expect([...rail.querySelectorAll('img')].map(img => img.getAttribute('alt')))
      .toEqual(['pasted.png', 'second.png'])
  })

  const remove = [...rail.querySelectorAll('button[aria-label^="Remove image"]')]
  if (remove.length !== 2) throw new Error('remove buttons missing')
  for (const button of remove) fireEvent.click(button)
  await waitFor(() => {
    expect(document.querySelector('[role="group"][aria-label="Pending images"]')).toBeNull()
  })

  // An unsupported file announces a transient toast (the inline strip is
  // gone) and the banner dismisses itself after its hold-and-fade lifetime.
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'text/plain', getAsFile: () => new File(['x'], 'notes.txt', { type: 'text/plain' }) }],
      getData: () => '',
    },
  })
  const toast = await screen.findByRole('alert')
  expect(toast.textContent).toContain('Unsupported image format: text/plain')
  await waitFor(() => {
    expect(screen.queryByRole('alert')).toBeNull()
  }, { timeout: 6_000 })
})
