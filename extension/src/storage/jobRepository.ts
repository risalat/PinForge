import type { PinJob } from '../types/pinforge'

export const PINFORGE_JOBS_KEY = 'pinforge.jobs'

function getStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Chrome storage is unavailable in this context.')
  }

  return chrome.storage.local
}

export async function loadJobs(): Promise<PinJob[]> {
  const storage = getStorageArea()
  const data = await storage.get(PINFORGE_JOBS_KEY)
  return (data[PINFORGE_JOBS_KEY] as PinJob[] | undefined) ?? []
}

export async function saveJobs(jobs: PinJob[]): Promise<void> {
  const storage = getStorageArea()
  await storage.set({ [PINFORGE_JOBS_KEY]: jobs })
}

export async function upsertJob(nextJob: PinJob): Promise<void> {
  const currentJobs = await loadJobs()
  const existingIndex = currentJobs.findIndex((job) => job.jobId === nextJob.jobId)

  if (existingIndex === -1) {
    currentJobs.push(nextJob)
  } else {
    currentJobs[existingIndex] = nextJob
  }

  await saveJobs(currentJobs)
}

export async function findJobById(jobId: string): Promise<PinJob | undefined> {
  const jobs = await loadJobs()
  return jobs.find((job) => job.jobId === jobId)
}

export async function updateJob(
  jobId: string,
  updater: (current: PinJob) => PinJob,
): Promise<PinJob | undefined> {
  const currentJobs = await loadJobs()
  const existingIndex = currentJobs.findIndex((job) => job.jobId === jobId)
  if (existingIndex < 0) {
    return undefined
  }

  const nextJob = updater(currentJobs[existingIndex])
  currentJobs[existingIndex] = nextJob
  await saveJobs(currentJobs)
  return nextJob
}

export async function getLatestJob(workspaceId?: string): Promise<PinJob | undefined> {
  const jobs = await loadJobs()
  const filtered = workspaceId
    ? jobs.filter((job) => job.workspaceId === workspaceId)
    : jobs
  if (filtered.length === 0) {
    return undefined
  }

  return filtered
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
}
