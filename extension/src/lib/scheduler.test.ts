import { describe, expect, it } from 'vitest'
import { buildSchedule } from './scheduler'

describe('buildSchedule', () => {
  it('returns monotonic increasing timestamps when jitter is enabled', () => {
    const seededRandomValues = [0.2, 0.8, 0.1, 0.7, 0.3, 0.9]
    let pointer = 0
    const rng = () => {
      const value = seededRandomValues[pointer % seededRandomValues.length]
      pointer += 1
      return value
    }

    const output = buildSchedule({
      startAt: '2026-03-02T09:00:00+06:00',
      count: 8,
      gapDays: 7,
      jitterDays: 3,
      rng,
    })

    expect(output).toHaveLength(8)

    for (let index = 1; index < output.length; index += 1) {
      const previous = Date.parse(output[index - 1])
      const current = Date.parse(output[index])
      expect(current).toBeGreaterThan(previous)
    }
  })
})
