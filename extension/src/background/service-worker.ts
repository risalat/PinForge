import { PublerClient } from '../lib/publerClient'
import { loadJobs, saveJobs } from '../storage/jobRepository'
import type { PinDraft, PinJob } from '../types/pinforge'

const JOB_POLL_ALARM = 'pinforge-job-poll'
const JOB_POLL_INTERVAL_MINUTES = 1
const SETTINGS_KEY = 'pinforge.settings'

chrome.runtime.onInstalled.addListener(() => {
  ensurePollAlarm()
  void resumePendingJobs()
})

chrome.runtime.onStartup.addListener(() => {
  ensurePollAlarm()
  void resumePendingJobs()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== JOB_POLL_ALARM) {
    return
  }

  void resumePendingJobs()
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PINFORGE_PING') {
    sendResponse({ ok: true, scope: 'background' })
    return true
  }

  if (message?.type === 'PINFORGE_RESUME_JOBS') {
    void resumePendingJobs()
      .then((summary) => {
        sendResponse({ ok: true, scope: 'background', ...summary })
      })
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error)
        sendResponse({ ok: false, scope: 'background', error: text })
      })
    return true
  }

  return false
})

function ensurePollAlarm(): void {
  chrome.alarms.create(JOB_POLL_ALARM, { periodInMinutes: JOB_POLL_INTERVAL_MINUTES })
}

async function resumePendingJobs(): Promise<{
  pendingJobs: number
  updatedJobs: number
}> {
  const jobs = await loadJobs()
  const pendingJobs = jobs.filter(
    (job) => job.status === 'uploading' || job.status === 'scheduling',
  )

  if (pendingJobs.length === 0) {
    return { pendingJobs: 0, updatedJobs: 0 }
  }

  const settings = await loadSettingsSnapshot()
  let updatedJobs = 0

  for (let index = 0; index < jobs.length; index += 1) {
    const current = jobs[index]
    if (current.status !== 'uploading' && current.status !== 'scheduling') {
      continue
    }

    const apiKey = resolveApiKey(current, settings)
    if (!apiKey) {
      continue
    }

    try {
      const client = new PublerClient({
        apiKey,
        workspaceId: current.workspaceId,
      })
      const next = await pollPendingJob(current, client)
      if (next) {
        jobs[index] = next
        updatedJobs += 1
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      console.warn(`[PinForge] Polling job ${current.jobId} failed: ${text}`)
    }
  }

  if (updatedJobs > 0) {
    await saveJobs(jobs)
    console.info(
      `[PinForge] Polled ${pendingJobs.length} pending job(s), updated ${updatedJobs}.`,
    )
  }

  return { pendingJobs: pendingJobs.length, updatedJobs }
}

interface SettingsSnapshot {
  apiKey: string
  workspaceId: string
}

async function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  const data = await chrome.storage.local.get(SETTINGS_KEY)
  const settings = data[SETTINGS_KEY]
  if (!isObject(settings)) {
    return { apiKey: '', workspaceId: '' }
  }

  const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : ''
  const workspaceId = typeof settings.workspaceId === 'string' ? settings.workspaceId.trim() : ''
  return { apiKey, workspaceId }
}

function resolveApiKey(job: PinJob, settings: SettingsSnapshot): string {
  if (job.apiKeySnapshot && job.apiKeySnapshot.trim() !== '') {
    return job.apiKeySnapshot.trim()
  }
  if (settings.apiKey === '') {
    return ''
  }
  if (settings.workspaceId && settings.workspaceId !== job.workspaceId) {
    return settings.apiKey
  }
  return settings.apiKey
}

async function pollPendingJob(job: PinJob, client: PublerClient): Promise<PinJob | null> {
  let next = cloneJob(job)
  let changed = false

  if (next.status === 'uploading') {
    const result = await pollUploadingPins(next, client)
    next = result.job
    changed = changed || result.changed
  }

  if (next.status === 'scheduling') {
    const result = await pollScheduleJob(next, client)
    next = result.job
    changed = changed || result.changed
  }

  if (!changed) {
    return null
  }

  next.updatedAt = new Date().toISOString()
  return next
}

async function pollUploadingPins(
  job: PinJob,
  client: PublerClient,
): Promise<{ job: PinJob; changed: boolean }> {
  const next = cloneJob(job)
  let changed = false

  for (let index = 0; index < next.pins.length; index += 1) {
    const pin = next.pins[index]
    if (!pin.mediaJobId || pin.publerMediaId || pin.state === 'failed') {
      continue
    }

    const snapshot = await client.getJobStatusSnapshot(pin.mediaJobId)
    if (snapshot.state === 'completed') {
      if (snapshot.mediaId) {
        const updatedPin = {
          ...pin,
          publerMediaId: snapshot.mediaId,
          state: pin.state === 'draft' ? 'ready' : pin.state,
          errors: [],
        }
        if (!isSamePin(pin, updatedPin)) {
          next.pins[index] = updatedPin
          changed = true
        }
      } else {
        const updatedPin = markPinFailed(pin, 'Media job completed without media ID.')
        if (!isSamePin(pin, updatedPin)) {
          next.pins[index] = updatedPin
          changed = true
        }
      }
      continue
    }

    if (snapshot.state === 'failed') {
      const updatedPin = markPinFailed(pin, snapshot.error ?? 'Media upload failed.')
      if (!isSamePin(pin, updatedPin)) {
        next.pins[index] = updatedPin
        changed = true
      }
    }
  }

  const pendingPins = next.pins.filter(
    (pin) => pin.mediaJobId && !pin.publerMediaId && pin.state !== 'failed',
  )
  if (pendingPins.length === 0) {
    const anyMediaReady = next.pins.some((pin) => !!pin.publerMediaId)
    const nextStatus = anyMediaReady ? 'completed' : 'failed'
    if (next.status !== nextStatus) {
      next.status = nextStatus
      changed = true
    }
  }

  const mediaJobIds = [...new Set(next.pins.map((pin) => pin.mediaJobId).filter(Boolean))] as string[]
  if (next.publerMediaJobIds.join('|') !== mediaJobIds.join('|')) {
    next.publerMediaJobIds = mediaJobIds
    changed = true
  }

  return { job: next, changed }
}

async function pollScheduleJob(
  job: PinJob,
  client: PublerClient,
): Promise<{ job: PinJob; changed: boolean }> {
  const next = cloneJob(job)
  let changed = false

  const scheduleJobId = next.publerScheduleJobId
  if (!scheduleJobId) {
    if (next.status !== 'failed') {
      next.status = 'failed'
      changed = true
    }
    return { job: next, changed }
  }

  const snapshot = await client.getJobStatusSnapshot(scheduleJobId)
  const schedulePinIndexes = next.pins
    .map((pin, index) => ({ pin, index }))
    .filter((entry) => entry.pin.scheduleJobId === scheduleJobId)
    .map((entry) => entry.index)

  if (snapshot.state === 'failed') {
    for (const pinIndex of schedulePinIndexes) {
      const currentPin = next.pins[pinIndex]
      if (currentPin.state === 'scheduled') {
        continue
      }
      const updatedPin = markPinFailed(currentPin, snapshot.error ?? 'Schedule job failed.')
      if (!isSamePin(currentPin, updatedPin)) {
        next.pins[pinIndex] = updatedPin
        changed = true
      }
    }

    if (next.status !== 'failed') {
      next.status = 'failed'
      changed = true
    }
    return { job: next, changed }
  }

  if (snapshot.state !== 'completed') {
    return { job: next, changed }
  }

  const outcomes = extractScheduleOutcomesFromJobRaw(snapshot.raw)
  if (outcomes.length > 0) {
    for (let index = 0; index < schedulePinIndexes.length; index += 1) {
      const pinIndex = schedulePinIndexes[index]
      const currentPin = next.pins[pinIndex]
      const outcome = outcomes[index]
      if (!outcome) {
        continue
      }

      const failed = isFailureStatus(outcome.status) || !!outcome.error
      const updatedPin: PinDraft = failed
        ? markPinFailed(currentPin, outcome.error ?? 'Schedule publish failed.')
        : {
            ...currentPin,
            state: 'scheduled',
            scheduledPostId: outcome.postId ?? currentPin.scheduledPostId,
            errors: [],
          }

      if (!isSamePin(currentPin, updatedPin)) {
        next.pins[pinIndex] = updatedPin
        changed = true
      }
    }
  } else {
    const postIds = extractPostIdsFromJobRaw(snapshot.raw)
    for (let index = 0; index < schedulePinIndexes.length; index += 1) {
      const pinIndex = schedulePinIndexes[index]
      const currentPin = next.pins[pinIndex]
      const updatedPin: PinDraft = {
        ...currentPin,
        state: 'scheduled',
        scheduledPostId: postIds[index] ?? currentPin.scheduledPostId,
        errors: [],
      }
      if (!isSamePin(currentPin, updatedPin)) {
        next.pins[pinIndex] = updatedPin
        changed = true
      }
    }
  }

  const anyScheduled = next.pins.some((pin) => pin.state === 'scheduled')
  const anyScheduleFailed = next.pins.some(
    (pin) => pin.scheduleJobId === scheduleJobId && pin.state === 'failed',
  )
  const nextStatus = anyScheduled && !anyScheduleFailed ? 'completed' : anyScheduled ? 'completed' : 'failed'
  if (next.status !== nextStatus) {
    next.status = nextStatus
    changed = true
  }

  return { job: next, changed }
}

function cloneJob(job: PinJob): PinJob {
  return {
    ...job,
    publerMediaJobIds: [...job.publerMediaJobIds],
    pins: job.pins.map((pin) => ({
      ...pin,
      keywordsUsed: [...pin.keywordsUsed],
      errors: [...pin.errors],
    })),
  }
}

function markPinFailed(pin: PinDraft, reason: string): PinDraft {
  return {
    ...pin,
    state: 'failed',
    errors: appendError(pin.errors, reason),
  }
}

function appendError(existing: string[], reason: string): string[] {
  const normalized = reason.trim()
  if (!normalized) {
    return existing
  }
  if (existing.includes(normalized)) {
    return existing
  }
  return [...existing, normalized]
}

function isSamePin(a: PinDraft, b: PinDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface ScheduleOutcome {
  postId?: string
  status?: string
  error?: string
}

function extractScheduleOutcomesFromJobRaw(raw: Record<string, unknown>): ScheduleOutcome[] {
  const outcomes: ScheduleOutcome[] = []
  collectScheduleOutcomes(raw, outcomes)
  return outcomes
}

function collectScheduleOutcomes(value: unknown, outcomes: ScheduleOutcome[]): void {
  if (!value) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectScheduleOutcomes(item, outcomes))
    return
  }
  if (!isObject(value)) {
    return
  }

  const postId =
    findFirstStringOrNumberInObject(value, ['post_id', 'postId']) ??
    findFirstStringOrNumberInObject(value, ['id'])
  const status = findFirstStringInObject(value, ['status', 'state', 'result'])
  const error = findFirstErrorInObject(value)

  const looksLikeOutcome =
    (postId !== undefined && (status !== undefined || error !== undefined)) ||
    (status !== undefined && error !== undefined)

  if (looksLikeOutcome) {
    outcomes.push({
      postId: postId !== undefined ? String(postId) : undefined,
      status: status?.toLowerCase(),
      error,
    })
  }

  Object.values(value).forEach((nested) => {
    collectScheduleOutcomes(nested, outcomes)
  })
}

function extractPostIdsFromJobRaw(raw: Record<string, unknown>): string[] {
  const ids: string[] = []
  collectPostIds(raw, ids)
  return ids
}

function collectPostIds(value: unknown, output: string[]): void {
  if (!value) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectPostIds(item, output))
    return
  }
  if (!isObject(value)) {
    return
  }

  for (const [key, currentValue] of Object.entries(value)) {
    const lowerKey = key.toLowerCase()
    if (
      (lowerKey === 'post_id' || lowerKey === 'postid') &&
      (typeof currentValue === 'string' || typeof currentValue === 'number')
    ) {
      output.push(String(currentValue))
    }
    collectPostIds(currentValue, output)
  }
}

function findFirstStringInObject(
  objectValue: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = objectValue[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }
  return undefined
}

function findFirstStringOrNumberInObject(
  objectValue: Record<string, unknown>,
  keys: string[],
): string | number | undefined {
  for (const key of keys) {
    const value = objectValue[key]
    if (
      (typeof value === 'string' && value.trim() !== '') ||
      typeof value === 'number'
    ) {
      return value
    }
  }
  return undefined
}

function findFirstErrorInObject(objectValue: Record<string, unknown>): string | undefined {
  const directKeys = ['error', 'message', 'reason', 'details']
  for (const key of directKeys) {
    const value = objectValue[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }

  const errors = objectValue.errors
  if (Array.isArray(errors)) {
    const textErrors = errors
      .map((value) => {
        if (typeof value === 'string') {
          return value.trim()
        }
        if (isObject(value)) {
          const message = value.message
          if (typeof message === 'string') {
            return message.trim()
          }
        }
        return ''
      })
      .filter((value) => value !== '')
    if (textErrors.length > 0) {
      return textErrors.join('; ')
    }
  }

  return undefined
}

function isFailureStatus(status: string | undefined): boolean {
  if (!status) {
    return false
  }
  return ['fail', 'error', 'rejected', 'cancel', 'invalid'].some((pattern) =>
    status.includes(pattern),
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
