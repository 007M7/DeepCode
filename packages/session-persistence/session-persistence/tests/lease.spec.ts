import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  sessionLeaseProcessIsLive,
  sessionLiveOwner,
  shareSessionLiveLease,
} from '../src/lease.ts'

const originalOwner = process.env.DSH_SESSION_LIVE_OWNER

afterEach(() => {
  vi.restoreAllMocks()
  if (originalOwner === undefined) delete process.env.DSH_SESSION_LIVE_OWNER
  else process.env.DSH_SESSION_LIVE_OWNER = originalOwner
})

describe('process live-session lease helpers', () => {
  it('creates one exec-stable owner identity and classifies process liveness', () => {
    delete process.env.DSH_SESSION_LIVE_OWNER
    const first = sessionLiveOwner()
    expect(first.pid).toBe(process.pid)
    expect(typeof first.nonce).toBe('string')
    expect(sessionLiveOwner()).toEqual(first)
    expect(sessionLeaseProcessIsLive(process.pid)).toBe(true)

    const missing = Object.assign(new Error('missing'), { code: 'ESRCH' })
    vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw missing })
    expect(sessionLeaseProcessIsLive(999_999)).toBe(false)
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw denied })
    expect(sessionLeaseProcessIsLive(999_998)).toBe(true)
  })

  it('shares one physical lease until every process-local reference releases', async () => {
    const releasePhysical = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const acquire = vi.fn<() => Promise<() => Promise<void>>>(() => Promise.resolve(releasePhysical))
    const key = `shared-${randomUUID()}`
    const first = await shareSessionLiveLease(key, acquire)
    const second = await shareSessionLiveLease(key, acquire)
    expect(acquire).toHaveBeenCalledTimes(1)
    await first()
    expect(releasePhysical).not.toHaveBeenCalled()
    await second()
    await second()
    expect(releasePhysical).toHaveBeenCalledTimes(1)
  })

  it('removes failed acquisitions and retries a failed physical release', async () => {
    const key = `retry-${randomUUID()}`
    await expect(shareSessionLiveLease(key, () => Promise.reject(new Error('claim failed'))))
      .rejects.toThrow('claim failed')

    let releases = 0
    const release = await shareSessionLiveLease(key, () => Promise.resolve(async () => {
      releases += 1
      if (releases === 1) throw new Error('release failed')
    }))
    await expect(release()).rejects.toThrow('release failed')
    await expect(release()).resolves.toBeUndefined()
    expect(releases).toBe(2)
  })
})
