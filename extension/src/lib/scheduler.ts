import dayjs from 'dayjs'

export interface ScheduleOptions {
  startAt: string | Date
  count: number
  gapDays: number
  jitterDays?: number
  minuteStepMinutes?: number
  rng?: () => number
}

export function buildSchedule(options: ScheduleOptions): string[] {
  if (options.count <= 0) {
    return []
  }

  if (options.gapDays < 0) {
    throw new Error('gapDays must be zero or greater.')
  }

  const start = dayjs(options.startAt)
  if (!start.isValid()) {
    throw new Error('startAt must be a valid date.')
  }

  const random = options.rng ?? Math.random
  const jitterDays = Math.max(0, options.jitterDays ?? 0)
  const minuteStep = Math.max(1, options.minuteStepMinutes ?? 1)

  const schedule: string[] = []
  let lastScheduled = start.subtract(1, 'minute')

  for (let index = 0; index < options.count; index += 1) {
    let candidate = start.add(index * options.gapDays, 'day')

    if (jitterDays > 0 && index > 0) {
      const direction = random() < 0.5 ? -1 : 1
      const offsetDays = Math.floor(random() * (jitterDays + 1))
      candidate = candidate.add(direction * offsetDays, 'day')
    }

    candidate = candidate.add(index * minuteStep, 'minute')

    if (candidate.isSame(lastScheduled) || candidate.isBefore(lastScheduled)) {
      candidate = lastScheduled.add(minuteStep, 'minute')
    }

    lastScheduled = candidate
    schedule.push(candidate.toISOString())
  }

  return schedule
}
