// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { MessageImage } from '../src/client/chat/MessageImage.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const enT = makeTranslate(en, commonZh)

const attachment = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png' as const,
  bytes: 68,
  width: 640,
  height: 320,
  name: 'history.png',
}

describe('MessageImage', () => {
  it('loads a session-authorized URL, bounds the thumbnail, and double-clicks into the original', async () => {
    const load = vi.fn().mockResolvedValue('blob:history')
    const view = render(<MessageImage attachment={attachment} load={load} t={t} />)
    const frame = view.getByRole('button', { name: 'history.png，双击查看原图' })
    expect(frame.getAttribute('style')).toContain('width: 240px')
    expect(frame.getAttribute('style')).toContain('height: 120px')
    await waitFor(() => { expect(view.getByAltText('history.png')).toBeTruthy() })
    expect(load).toHaveBeenCalledWith(attachment)
    fireEvent.doubleClick(frame)
    expect(view.getByRole('dialog', { name: '原图预览' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '关闭原图预览' }))
    expect(view.queryByRole('dialog', { name: '原图预览' })).toBeNull()
  })

  it('surfaces a retry control when durable bytes cannot be read', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('blob:retry')
    const view = render(<MessageImage attachment={attachment} load={load} t={t} />)
    const retry = await view.findByRole('button', { name: '图片加载失败，点击重试' })
    fireEvent.click(retry)
    await waitFor(() => { expect(view.getByAltText('history.png')).toBeTruthy() })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('renders image controls from the active English dictionary', async () => {
    const load = vi.fn().mockResolvedValue('blob:history')
    const view = render(<MessageImage attachment={attachment} load={load} t={enT} />)
    const frame = view.getByRole('button', { name: 'history.png, double-click to view original' })
    await waitFor(() => { expect(view.getByAltText('history.png')).toBeTruthy() })
    fireEvent.doubleClick(frame)
    expect(view.getByRole('dialog', { name: 'Original image preview' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Close original image preview' })).toBeTruthy()
  })

  it('keeps assistant images at their original position between text blocks', async () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[
          { kind: 'text', text: 'before' },
          { kind: 'image', attachment },
          { kind: 'text', text: 'after' },
        ]}
        streaming={false}
        loadImage={() => Promise.resolve('blob:middle')}
      />,
    )
    const image = await view.findByAltText('history.png')
    const before = view.getByText('before')
    const after = view.getByText('after')
    expect(before.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(image.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })
})
