import { describe, expect, it } from 'vitest'

describe('vitest 冒烟', () => {
  it('支持基础断言', () => {
    expect(1 + 1).toBe(2)
  })
})
