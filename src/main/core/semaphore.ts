/**
 * 计数信号量：控制并发数。acquire 在配额满时挂起，release 唤醒等待者。
 * 用于视频并发、LLM 在途请求、ASR 上传三级限流。
 */
export class Semaphore {
  private waiting: Array<() => void> = []
  private current = 0

  constructor(private max: number) {}

  get capacity(): number {
    return this.max
  }

  get inUse(): number {
    return this.current
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.current++
  }

  release(): void {
    this.current = Math.max(0, this.current - 1)
    const next = this.waiting.shift()
    if (next) next()
  }

  setMax(max: number): void {
    this.max = Math.max(1, max)
    // 扩容时立即唤醒等待者直到填满
    while (this.current < this.max && this.waiting.length > 0) {
      const next = this.waiting.shift()!
      next()
      this.current++
    }
  }
}
