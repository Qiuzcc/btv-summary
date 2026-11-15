import { describe, expect, it } from 'vitest'
import { Semaphore } from '../src/main/core/semaphore'

describe('信号量', () => {
  it('限制并发数', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 5 }, async () => {
      await sem.acquire()
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      sem.release()
    })
    await Promise.all(tasks)
    expect(maxActive).toBe(2)
  })

  it('扩容后立即放行等待者', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    let secondAcquired = false
    const p = sem.acquire().then(() => {
      secondAcquired = true
    })
    // 第二个还在等待
    await new Promise((r) => setTimeout(r, 5))
    expect(secondAcquired).toBe(false)
    sem.setMax(2)
    await p
    expect(secondAcquired).toBe(true)
    sem.release()
    sem.release()
  })
})
