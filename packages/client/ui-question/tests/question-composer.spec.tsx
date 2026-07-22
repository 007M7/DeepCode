// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PendingInteraction } from '@deepseek-ai/dsh-client-runtime/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import {
  QuestionComposer, parseQuestionTitle, parseRecommendedLabel,
} from '../src/client/QuestionComposer.tsx'

afterEach(cleanup)

type Interaction = Extract<PendingInteraction, { kind: 'question' }>

function interaction(rpcId = 'question-1'): Interaction {
  return {
    kind: 'question',
    rpcId: RpcId(rpcId),
    questions: [
      {
        id: 'profile', header: '偏好', question: '选择候选人类型',
        options: [
          { label: '工程落地型 (Recommended)', description: '优先工程交付。' },
          { label: '研究潜力型', description: '优先研究能力。' },
        ],
      },
      {
        id: 'detail', question: '补充你的要求',
      },
      {
        id: 'signals', question: '选择重要信号（可多选）', multiSelect: true,
        options: [{ label: '系统设计' }, { label: '代码质量' }, { label: '产品判断' }],
      },
    ],
  }
}

describe('QuestionComposer', () => {
  it('collects single, custom, and multi-select answers before one batch submit', () => {
    const answer = vi.fn(() => Promise.resolve())
    const cancel = vi.fn(() => Promise.resolve())
    render(<QuestionComposer interaction={interaction()} actions={{ answer, cancel }} />)

    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.getByText('推荐')).toBeTruthy()
    expect(screen.getByText('工程落地型')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('radio', { name: /工程落地型/ }), { key: 'Enter' })
    expect(answer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))

    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '填写答案' })).toBeNull()
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '要能独立排查线上问题' } })
    fireEvent.keyDown(custom, { key: 'Enter' })

    expect(screen.getByText('3 / 3')).toBeTruthy()
    expect(screen.getByText('选择重要信号')).toBeTruthy()
    expect(screen.getByText('可多选')).toBeTruthy()
    expect(screen.queryByText('（可多选）')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '代码质量' }))
    fireEvent.keyDown(screen.getByRole('checkbox', { name: '代码质量' }), { key: 'Enter' })

    expect(answer).toHaveBeenCalledWith(interaction(), {
      answers: [
        { id: 'profile', selected: ['工程落地型 (Recommended)'] },
        { id: 'detail', selected: [], custom: '要能独立排查线上问题' },
        { id: 'signals', selected: ['系统设计', '代码质量'] },
      ],
    })
    expect((screen.getByRole('button', { name: '正在提交…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('skips individual questions without discarding earlier answers', () => {
    const answer = vi.fn(() => Promise.resolve())
    const cancel = vi.fn(() => Promise.resolve())
    render(<QuestionComposer interaction={interaction()} actions={{ answer, cancel }} />)

    expect((screen.getByText('下一题').closest('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '研究潜力型' }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过本题' }))
    expect(screen.getByText('3 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '跳过本题' }))

    expect(cancel).not.toHaveBeenCalled()
    expect(answer).toHaveBeenCalledWith(interaction(), {
      answers: [
        { id: 'profile', selected: ['研究潜力型'] },
        { id: 'detail', selected: [] },
        { id: 'signals', selected: [] },
      ],
    })
  })

  it('keeps IME Enter inside the custom input until composition finishes', () => {
    const answer = vi.fn(() => Promise.resolve())
    const cancel = vi.fn(() => Promise.resolve())
    render(<QuestionComposer interaction={interaction()} actions={{ answer, cancel }} />)

    fireEvent.click(screen.getByRole('radio', { name: '研究潜力型' }))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '中文输入' } })

    fireEvent.keyDown(custom, { key: 'Enter', isComposing: true })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()

    fireEvent.keyDown(custom, { key: 'Enter', keyCode: 229 })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()

    fireEvent.keyDown(custom, { key: 'Enter' })
    expect(screen.getByText('3 / 3')).toBeTruthy()
  })

  it('opens custom input, reports missing skipped answers, and supports header navigation', () => {
    const answer = vi.fn(() => Promise.resolve())
    const cancel = vi.fn(() => Promise.resolve())
    render(<QuestionComposer interaction={interaction()} actions={{ answer, cancel }} />)

    fireEvent.click(screen.getByRole('button', { name: '其他，请填写自定义答案' }))
    expect(screen.getByPlaceholderText('输入你的答案')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '工程落地型' }))
    const emptyCustom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.keyDown(emptyCustom, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.keyDown(emptyCustom, { key: 'Enter' })
    expect(screen.getByText('请选择一个选项或填写自定义答案。')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.click(screen.getByRole('checkbox', { name: '产品判断' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByText('请先完成这道问题。')).toBeTruthy()
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('上一题'))
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()
  })

  it('surfaces explicit cancellation rejection', async () => {
    const answer = vi.fn(() => Promise.resolve())
    const cancel = vi.fn(() => Promise.reject('取消请求失败'))
    render(<QuestionComposer interaction={interaction()} actions={{ answer, cancel }} />)

    fireEvent.click(screen.getByRole('button', { name: '放弃整组问题' }))
    expect(await screen.findByText('取消请求失败')).toBeTruthy()
    expect((screen.getByRole('button', { name: '跳过本题' }) as HTMLButtonElement).disabled).toBe(false)

    cancel.mockRejectedValueOnce(new Error('第二次取消失败'))
    fireEvent.click(screen.getByRole('button', { name: '放弃整组问题' }))
    expect(await screen.findByText('第二次取消失败')).toBeTruthy()
  })

  it('surfaces transport rejection and resets local drafts for a different rpcId', async () => {
    const answer = vi.fn(() => Promise.reject(new Error('网络中断')))
    const cancel = vi.fn(() => Promise.resolve())
    const first = interaction('first')
    const view = render(<QuestionComposer interaction={first} actions={{ answer, cancel }} />)

    fireEvent.click(screen.getByRole('radio', { name: /研究潜力型/ }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    view.rerender(<QuestionComposer interaction={interaction('second')} actions={{ answer, cancel }} />)
    expect(screen.getByRole('radio', { name: /研究潜力型/ }).getAttribute('aria-checked')).toBe('false')

    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: 'x' } })
    fireEvent.keyDown(custom, { key: 'Enter' })
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(await screen.findByText('网络中断')).toBeTruthy()
    expect((screen.getByRole('button', { name: '提交' }) as HTMLButtonElement).disabled).toBe(false)

    answer.mockRejectedValueOnce('字符串错误')
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(await screen.findByText('字符串错误')).toBeTruthy()
  })
})

describe('parseRecommendedLabel', () => {
  it('recognizes English and Chinese suffixes without changing ordinary labels', () => {
    expect(parseRecommendedLabel('Fast (Recommended)')).toEqual({ label: 'Fast', recommended: true })
    expect(parseRecommendedLabel('稳妥（推荐）')).toEqual({ label: '稳妥', recommended: true })
    expect(parseRecommendedLabel('稳妥 (推荐)')).toEqual({ label: '稳妥', recommended: true })
    expect(parseRecommendedLabel('Plain')).toEqual({ label: 'Plain', recommended: false })
  })
})

describe('parseQuestionTitle', () => {
  it('removes Chinese and ASCII multi-select suffixes', () => {
    expect(parseQuestionTitle('选择信号（可多选）')).toBe('选择信号')
    expect(parseQuestionTitle('选择信号 (可多选)')).toBe('选择信号')
    expect(parseQuestionTitle('选择信号')).toBe('选择信号')
  })
})
