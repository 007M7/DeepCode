// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  ComposerSubmissionPolicy, DEFAULT_BUSY_ENTER_BEHAVIOR,
} from '../src/client/input/submission-policy.ts'

describe('ComposerSubmissionPolicy', () => {
  it('defaults to Queue and only applies the preference while running', () => {
    const policy = new ComposerSubmissionPolicy()
    expect(policy.busyEnter.getSnapshot()).toBe(DEFAULT_BUSY_ENTER_BEHAVIOR)
    expect(policy.resolve(false, 'enter', true)).toBe('queue')
    expect(policy.resolve(false, 'accelerated', true)).toBe('queue')
    expect(policy.resolve(true, 'enter', true)).toBe('queue')
    expect(policy.resolve(true, 'accelerated', true)).toBe('steer')
    expect(policy.resolve(true, 'enter', false)).toBe('queue')
    expect(policy.resolve(true, 'accelerated', false)).toBe('queue')

    const changed = vi.fn()
    const persist = vi.fn()
    policy.bindPersistence(persist)
    policy.busyEnter.subscribe(changed)
    policy.setBusyEnter('steer')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(policy.resolve(true, 'enter', true)).toBe('steer')
    expect(policy.resolve(true, 'accelerated', true)).toBe('queue')
    expect(policy.resolve(false, 'enter', true)).toBe('queue')
    expect(policy.resolve(false, 'accelerated', true)).toBe('queue')
    expect(persist).toHaveBeenCalledWith('steer')
  })

  it('syncs a Host preference without writing it back and leaves an identical write untouched', () => {
    const persist = vi.fn()
    const policy = new ComposerSubmissionPolicy(persist)
    policy.syncPreference('steer')
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
    policy.setBusyEnter('steer')
    expect(persist).not.toHaveBeenCalled()
  })

  it('publishes the in-memory preference before calling the durable writer', () => {
    const policy = new ComposerSubmissionPolicy()
    const persist = vi.fn(() => {
      expect(policy.busyEnter.getSnapshot()).toBe('steer')
    })
    policy.bindPersistence(persist)
    policy.setBusyEnter('steer')
    expect(persist).toHaveBeenCalledOnce()
  })
})
