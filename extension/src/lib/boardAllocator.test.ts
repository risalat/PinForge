import { describe, expect, it } from 'vitest'
import { buildWeightedBoardSequence } from './boardAllocator'

describe('buildWeightedBoardSequence', () => {
  it('allocates pins close to requested primary share', () => {
    const output = buildWeightedBoardSequence({
      totalPins: 20,
      primaryBoardId: 'primary',
      secondaryBoardIds: ['board-a', 'board-b'],
      primaryShare: 0.6,
    })

    expect(output).toHaveLength(20)
    expect(output.filter((id) => id === 'primary')).toHaveLength(12)
  })

  it('avoids scheduling the same board consecutively when alternatives exist', () => {
    const output = buildWeightedBoardSequence({
      totalPins: 6,
      primaryBoardId: 'primary',
      secondaryBoardIds: ['board-a', 'board-b'],
      primaryShare: 0.5,
    })

    for (let index = 1; index < output.length; index += 1) {
      expect(output[index]).not.toBe(output[index - 1])
    }
  })
})
