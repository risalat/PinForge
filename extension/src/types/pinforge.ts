export type PinJobStatus =
  | 'draft'
  | 'uploading'
  | 'scheduling'
  | 'completed'
  | 'failed'

export type PinDraftState = 'draft' | 'ready' | 'scheduled' | 'failed'

export interface PinSettings {
  startDate: string
  gapDays: number
  jitterDays: number
  boardPool: string[]
  primaryBoardId: string
  primaryShare: number
}

export interface PinDraft {
  id: string
  sourceImageUrl: string
  sourceImageAlt?: string
  contextHeading?: string
  publerMediaId?: string
  mediaJobId?: string
  title: string
  description: string
  altText?: string
  boardId: string
  scheduledAt: string
  scheduleJobId?: string
  scheduledPostId?: string
  keywordsUsed: string[]
  state: PinDraftState
  errors: string[]
}

export interface PinJob {
  jobId: string
  workspaceId: string
  apiKeySnapshot?: string
  sourceTitle?: string
  publerScheduleJobId?: string
  publerMediaJobIds: string[]
  status: PinJobStatus
  createdAt: string
  updatedAt: string
  sourceUrl: string
  settings: PinSettings
  pins: PinDraft[]
}
