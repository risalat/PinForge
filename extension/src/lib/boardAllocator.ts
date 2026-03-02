export interface BoardAllocationOptions {
  totalPins: number
  primaryBoardId: string
  secondaryBoardIds: string[]
  primaryShare?: number
}

export function buildWeightedBoardSequence(
  options: BoardAllocationOptions,
): string[] {
  const totalPins = Math.max(0, options.totalPins)
  if (totalPins === 0) {
    return []
  }

  const primaryBoardId = options.primaryBoardId.trim()
  if (!primaryBoardId) {
    throw new Error('primaryBoardId is required.')
  }

  const uniqueSecondaryBoards = [...new Set(options.secondaryBoardIds)]
    .map((boardId) => boardId.trim())
    .filter((boardId) => boardId !== '' && boardId !== primaryBoardId)

  const safePrimaryShare = clamp(options.primaryShare ?? 0.6, 0, 1)
  const secondaryBoardCount = uniqueSecondaryBoards.length
  const primaryPinCount =
    secondaryBoardCount === 0 ? totalPins : Math.round(totalPins * safePrimaryShare)
  const remainingPins = totalPins - primaryPinCount

  const quotas = new Map<string, number>()
  quotas.set(primaryBoardId, primaryPinCount)

  if (secondaryBoardCount > 0) {
    const base = Math.floor(remainingPins / secondaryBoardCount)
    const extra = remainingPins % secondaryBoardCount

    uniqueSecondaryBoards.forEach((boardId, index) => {
      quotas.set(boardId, base + (index < extra ? 1 : 0))
    })
  }

  const sequence: string[] = []

  while (sequence.length < totalPins) {
    const candidates = [...quotas.entries()]
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1])

    if (candidates.length === 0) {
      break
    }

    const previousBoard = sequence[sequence.length - 1]
    const preferredCandidate =
      candidates.find(([boardId]) => boardId !== previousBoard) ?? candidates[0]

    const [selectedBoardId, selectedCount] = preferredCandidate
    sequence.push(selectedBoardId)
    quotas.set(selectedBoardId, selectedCount - 1)
  }

  return sequence
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
