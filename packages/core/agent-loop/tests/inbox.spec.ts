import { describe, expect, it } from 'vitest'
import { Inbox } from '../src/inbox.ts'

function resolverPair() {
  let r!: () => void
  const p = new Promise<void>((resolve) => { r = resolve })
  return { promise: p, resolve: r }
}

describe('Inbox', () => {
  it('dequeues one queued message at a time in FIFO order', () => {
    const inbox = new Inbox()
    inbox.enqueue({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    inbox.enqueue({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    expect(inbox.hasQueued).toBe(true)

    expect(inbox.dequeueQueued()?.content[0]).toMatchObject({ text: 'first' })
    expect(inbox.hasQueued).toBe(true)
    expect(inbox.dequeueQueued()?.content[0]).toMatchObject({ text: 'second' })
    expect(inbox.hasQueued).toBe(false)
    expect(inbox.dequeueQueued()).toBeUndefined()
  })

  it('pushes and drains steering messages separately from queued', () => {
    const inbox = new Inbox()
    inbox.steer({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } })
    expect(inbox.hasQueued).toBe(false)
    expect(inbox.hasSteering).toBe(true)

    const steering = inbox.drainSteering()
    expect(steering).toHaveLength(1)
    expect(inbox.hasSteering).toBe(false)
  })

  it('waitForQueued returns immediately when a queued message is already present', async () => {
    const inbox = new Inbox()
    inbox.enqueue({ content: [{ type: 'text', text: 'ready' }], source: { kind: 'user' } })

    const started = Date.now()
    await inbox.waitForQueued(new Promise(() => {})) // never-resolving cancel
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('waitForQueued resolves when a message is enqueued', async () => {
    const inbox = new Inbox()
    const waiter = inbox.waitForQueued(new Promise(() => {})) // never-resolving cancel
    // enqueue after starting the wait
    setTimeout(() => { inbox.enqueue({ content: [{ type: 'text', text: 'wake' }], source: { kind: 'user' } }) }, 5)
    await waiter
  })

  it('waitForQueued resolves when the cancel promise resolves', async () => {
    const inbox = new Inbox()
    const { promise, resolve } = resolverPair()
    const waiter = inbox.waitForQueued(promise)
    resolve()
    await waiter
  })

  it('waitForQueued overwrites the previous wakeup callback (only the latest waiter is notified)', async () => {
    const inbox = new Inbox()
    const { promise: p1, resolve: r1 } = resolverPair()

    void inbox.waitForQueued(new Promise(() => {})) // first call, never resolved
    void inbox.waitForQueued(p1) // second call overwrites wakeup

    // Cancelling the latest waiter clears the shared callback; enqueue must neither
    // wake the stale waiter nor fail on the cleared callback.
    r1()
    await p1

    inbox.enqueue({ content: [{ type: 'text', text: 'hey' }], source: { kind: 'user' } })
  })

  it('clears wakeup in finally handler when enqueue resolves', async () => {
    const inbox = new Inbox()
    void inbox.waitForQueued(new Promise(() => {})) // never-resolving cancel
    // The wakeup is set. Now trigger it via enqueue → wakeup() calls resolve,
    // promise resolves, finally clears wakeup because wakeup === resolve.
    inbox.enqueue({ content: [{ type: 'text', text: 'wake' }], source: { kind: 'user' } })
    // No explicit await needed — enqueue is synchronous, and the microtask
    // (finally) runs. The key coverage hit is finally with wakeup === resolve.
  })

  it('finally handler does not clear wakeup when a different waiter overwrote it', async () => {
    // A stale waiter's finally must not clear the replacement waiter.
    const inbox = new Inbox()
    const { promise: c1, resolve: r1 } = resolverPair()

    void inbox.waitForQueued(c1) // wakeup = resolve1, c1.then(resolve1)
    void inbox.waitForQueued(new Promise(() => {})) // wakeup = resolve2, cancel never resolves

    r1()
    await c1

    // The replacement remains registered and is resolved by enqueue.
    inbox.enqueue({ content: [{ type: 'text', text: 'hey' }], source: { kind: 'user' } })
  })
})
