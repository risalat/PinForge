
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AIClient, type AIProvider, type TitleStyle } from '../../lib/aiClient'
import { buildWeightedBoardSequence } from '../../lib/boardAllocator'
import {
  PublerClient,
  type PublerJobStatusSnapshot,
  type PinterestBoard,
  type PublerAccount,
  type PublerWorkspace,
} from '../../lib/publerClient'
import { buildSchedule } from '../../lib/scheduler'
import {
  PINFORGE_JOBS_KEY,
  loadJobs,
  upsertJob,
} from '../../storage/jobRepository'
import {
  buildImageFingerprint,
  getArticleCoverageRecord,
  listArticleCoverageRecords,
  normalizeArticleUrl,
  upsertArticleCoverageRecord,
  type ArticleCoverageRecord,
  type ArticleCoverageStatus,
  type ArticleImageCoverage,
} from '../../storage/articleCoverageRepository'
import { cacheMediaId, loadWorkspaceMediaCache } from '../../storage/mediaCacheRepository'
import type { PinCopy } from '../../lib/validators'
import type { PinDraft, PinJob, PinJobStatus } from '../../types/pinforge'

const SETTINGS_KEY = 'pinforge.settings'

interface SettingsState {
  apiKey: string
  workspaceId: string
  selectedAccountId: string
  selectedBoardIds: string[]
  primaryBoardId: string
  aiProvider: AIProvider
  aiApiKey: string
  aiModel: string
  aiCustomEndpoint: string
}

interface ScheduleSettings {
  startAtLocal: string
  gapDays: number
  jitterDays: number
  primarySharePercent: number
}

interface ScrapedImage {
  id: string
  image_url: string
  alt: string
  caption: string
  nearest_heading: string
  section_heading_path: string[]
  surrounding_text_snippet: string
}

interface ScrapeResultView {
  postTitle: string
  canonicalUrl: string
  images: ScrapedImage[]
}

interface SchedulePreviewRow {
  image: ScrapedImage
  boardId: string
  boardName: string
  scheduledAtIso: string
}

interface ImageCopyState {
  title: string
  description: string
  altText: string
  keywordsUsed: string[]
  perImageKeywordsInput: string
  lockTitle: boolean
}

interface MediaUploadState {
  state: 'idle' | 'cached' | 'queued' | 'processing' | 'completed' | 'failed'
  mediaId?: string
  jobId?: string
  error?: string
}

interface SchedulePublishState {
  state: 'idle' | 'ready' | 'queued' | 'processing' | 'scheduled' | 'failed'
  scheduleJobId?: string
  scheduledPostId?: string
  error?: string
}

const DEFAULT_SETTINGS: SettingsState = {
  apiKey: '',
  workspaceId: '',
  selectedAccountId: '',
  selectedBoardIds: [],
  primaryBoardId: '',
  aiProvider: 'custom_endpoint',
  aiApiKey: '',
  aiModel: '',
  aiCustomEndpoint: '',
}

const AI_PROVIDER_OPTIONS: Array<{ value: AIProvider; label: string }> = [
  { value: 'custom_endpoint', label: 'Custom Endpoint' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'openrouter', label: 'OpenRouter' },
]

const TITLE_STYLE_OPTIONS: Array<{ value: TitleStyle; label: string }> = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'seo', label: 'SEO-Focused' },
  { value: 'curiosity', label: 'Curiosity Hook' },
  { value: 'benefit', label: 'Benefit-Led' },
]

const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  startAtLocal: getDefaultStartAtLocal(),
  gapDays: 7,
  jitterDays: 0,
  primarySharePercent: 60,
}

export function PopupApp() {
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS)
  const [scheduleSettings, setScheduleSettings] = useState<ScheduleSettings>(
    DEFAULT_SCHEDULE_SETTINGS,
  )
  const [accounts, setAccounts] = useState<PublerAccount[]>([])
  const [boards, setBoards] = useState<PinterestBoard[]>([])
  const [status, setStatus] = useState('Idle')
  const [isLoading, setIsLoading] = useState(false)
  const [isGeneratingCopy, setIsGeneratingCopy] = useState(false)
  const [isUploadingMedia, setIsUploadingMedia] = useState(false)
  const [isSchedulingPosts, setIsSchedulingPosts] = useState(false)
  const [scrapeResult, setScrapeResult] = useState<ScrapeResultView | null>(null)
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([])
  const [copyByImageId, setCopyByImageId] = useState<Record<string, ImageCopyState>>({})
  const [mediaUploadByImageId, setMediaUploadByImageId] = useState<
    Record<string, MediaUploadState>
  >({})
  const [schedulePublishByImageId, setSchedulePublishByImageId] = useState<
    Record<string, SchedulePublishState>
  >({})
  const [lastScheduleJobId, setLastScheduleJobId] = useState<string>('')
  const [activeRunJobId, setActiveRunJobId] = useState<string>('')
  const [selectedCopyIds, setSelectedCopyIds] = useState<string[]>([])
  const [globalKeywordsInput, setGlobalKeywordsInput] = useState('')
  const [forceKeywords, setForceKeywords] = useState(false)
  const [titleStyle, setTitleStyle] = useState<TitleStyle>('balanced')
  const [boardSearchInput, setBoardSearchInput] = useState('')
  const [coverageSearchInput, setCoverageSearchInput] = useState('')
  const [coverageRecords, setCoverageRecords] = useState<ArticleCoverageRecord[]>([])
  const [currentArticleCoverage, setCurrentArticleCoverage] =
    useState<ArticleCoverageRecord | null>(null)
  const [aiModelCatalog, setAiModelCatalog] = useState<string[]>([])
  const [isLoadingAiModels, setIsLoadingAiModels] = useState(false)
  const [workspaceOptions, setWorkspaceOptions] = useState<PublerWorkspace[]>([])
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false)
  const [activeTab, setActiveTab] = useState<'settings' | 'run' | 'done'>('run')

  useEffect(() => {
    void loadSettings()
  }, [])

  const canConnect = useMemo(
    () => settings.apiKey.trim() !== '' && settings.workspaceId.trim() !== '',
    [settings.apiKey, settings.workspaceId],
  )

  const selectedBoards = useMemo(
    () => boards.filter((board) => settings.selectedBoardIds.includes(board.id)),
    [boards, settings.selectedBoardIds],
  )

  const filteredBoards = useMemo(() => {
    const query = boardSearchInput.trim().toLowerCase()
    if (query === '') {
      return boards
    }
    return boards.filter((board) => board.name.toLowerCase().includes(query))
  }, [boards, boardSearchInput])

  const selectedImages = useMemo(() => {
    if (!scrapeResult) {
      return [] as ScrapedImage[]
    }
    return scrapeResult.images.filter((image) => selectedImageIds.includes(image.id))
  }, [scrapeResult, selectedImageIds])

  useEffect(() => {
    const ids = selectedImages.map((image) => image.id)
    setSelectedCopyIds((current) => {
      const kept = current.filter((id) => ids.includes(id))
      const additions = ids.filter((id) => !kept.includes(id))
      return [...kept, ...additions]
    })
  }, [selectedImages])

  const selectedImageCount = selectedImages.length
  const aiConfigError = getAiConfigurationError(settings)

  const schedulePreview = useMemo(
    () =>
      buildSchedulePreview({
        selectedImages,
        allBoards: boards,
        selectedBoardIds: settings.selectedBoardIds,
        primaryBoardId: settings.primaryBoardId,
        scheduleSettings,
      }),
    [
      selectedImages,
      boards,
      settings.selectedBoardIds,
      settings.primaryBoardId,
      scheduleSettings,
    ],
  )

  const scheduleByImageId = useMemo(
    () => new Map(schedulePreview.rows.map((row) => [row.image.id, row])),
    [schedulePreview.rows],
  )

  const generatedTitleCount = selectedImages.filter((image) => {
    const title = copyByImageId[image.id]?.title ?? ''
    return title.trim() !== ''
  }).length
  const generatedDescriptionCount = selectedImages.filter((image) => {
    const description = copyByImageId[image.id]?.description ?? ''
    return description.trim() !== ''
  }).length
  const copiedImageCount = selectedImages.filter((image) => hasGeneratedCopy(copyByImageId[image.id])).length
  const selectedMediaUploadedCount = selectedImages.filter((image) => {
    const state = mediaUploadByImageId[image.id]?.state
    return state === 'cached' || state === 'completed'
  }).length
  const selectedScheduleReadyCount = selectedImages.filter((image) => {
    const mediaState = mediaUploadByImageId[image.id]?.state
    const copyState = copyByImageId[image.id]
    return (
      (mediaState === 'cached' || mediaState === 'completed') &&
      copyState &&
      hasGeneratedCopy(copyState) &&
      scheduleByImageId.has(image.id)
    )
  }).length
  const selectedScheduledCount = selectedImages.filter((image) => {
    const state = schedulePublishByImageId[image.id]?.state
    return state === 'scheduled'
  }).length

  const filteredCoverageRecords = useMemo(() => {
    const query = coverageSearchInput.trim().toLowerCase()
    if (query === '') {
      return coverageRecords
    }

    return coverageRecords.filter((record) => {
      return (
        record.sourceTitle.toLowerCase().includes(query) ||
        record.canonicalUrl.toLowerCase().includes(query)
      )
    })
  }, [coverageRecords, coverageSearchInput])

  useEffect(() => {
    void requestBackgroundJobResume()
    void restoreLatestRunState()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') {
        return
      }
      const jobsChange = changes[PINFORGE_JOBS_KEY]
      if (!jobsChange) {
        return
      }
      const jobs = Array.isArray(jobsChange.newValue) ? (jobsChange.newValue as PinJob[]) : []
      const shouldSyncUi = scrapeResult === null || activeRunJobId !== ''
      if (!shouldSyncUi) {
        return
      }
      const candidate = pickLatestRelevantJob(jobs)
      if (candidate) {
        applyPersistedJobToUi(candidate, false)
      }
    }

    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange)
    }
  }, [activeRunJobId, scrapeResult, settings.workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (settings.workspaceId.trim() === '') {
      setCoverageRecords([])
      setCurrentArticleCoverage(null)
      return
    }
    void restoreLatestRunState()
    void refreshCoverageRecords()
    if (scrapeResult?.canonicalUrl) {
      void refreshCurrentArticleCoverage(scrapeResult.canonicalUrl, scrapeResult.images)
    }
  }, [settings.workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeTab === 'done') {
      void refreshCoverageRecords()
    }
  }, [activeTab, settings.workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

  function pickLatestRelevantJob(jobs: PinJob[]): PinJob | undefined {
    const workspaceScoped =
      settings.workspaceId.trim() === ''
        ? jobs
        : jobs.filter((job) => job.workspaceId === settings.workspaceId)

    if (workspaceScoped.length === 0) {
      return undefined
    }

    const sorted = workspaceScoped
      .slice()
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

    if (activeRunJobId) {
      const active = sorted.find((job) => job.jobId === activeRunJobId)
      if (active) {
        return active
      }
    }

    if (scrapeResult?.canonicalUrl) {
      const currentCanonical = normalizeArticleUrl(scrapeResult.canonicalUrl)
      const sameSourcePending = sorted.find(
        (job) =>
          normalizeArticleUrl(job.sourceUrl) === currentCanonical &&
          (job.status === 'uploading' || job.status === 'scheduling'),
      )
      if (sameSourcePending) {
        return sameSourcePending
      }

      const sameSourceLatest = sorted.find(
        (job) => normalizeArticleUrl(job.sourceUrl) === currentCanonical,
      )
      if (sameSourceLatest) {
        return sameSourceLatest
      }
    }

    return sorted[0]
  }

  function applyPersistedJobToUi(job: PinJob, announce: boolean): void {
    const currentUrl = scrapeResult?.canonicalUrl ?? ''
    const shouldRebuildScrape =
      !scrapeResult || (job.sourceUrl && currentUrl !== '' && job.sourceUrl !== currentUrl)

    const targetImages: ScrapedImage[] = shouldRebuildScrape
      ? job.pins.map((pin) => ({
          id: pin.id || `restored-${Math.abs(hashString(pin.sourceImageUrl))}`,
          image_url: pin.sourceImageUrl,
          alt: pin.sourceImageAlt ?? '',
          caption: '',
          nearest_heading: pin.contextHeading ?? '',
          section_heading_path: [],
          surrounding_text_snippet: '',
        }))
      : scrapeResult.images

    if (shouldRebuildScrape) {
      setScrapeResult({
        postTitle: job.sourceTitle?.trim() || 'Restored Run',
        canonicalUrl: job.sourceUrl,
        images: targetImages,
      })
      const allIds = targetImages.map((image) => image.id)
      setSelectedImageIds(allIds)
      setSelectedCopyIds(allIds)
    }

    const pinBySourceUrl = new Map(job.pins.map((pin) => [pin.sourceImageUrl, pin]))
    const nextCopyByImageId: Record<string, ImageCopyState> = {}
    const nextMediaByImageId: Record<string, MediaUploadState> = {}
    const nextScheduleByImageId: Record<string, SchedulePublishState> = {}

    targetImages.forEach((image) => {
      const pin = pinBySourceUrl.get(image.image_url)
      nextCopyByImageId[image.id] = {
        title: pin?.title ?? '',
        description: pin?.description ?? '',
        altText: pin?.altText ?? '',
        keywordsUsed: pin?.keywordsUsed ?? [],
        perImageKeywordsInput: '',
        lockTitle: false,
      }

      if (pin?.publerMediaId) {
        nextMediaByImageId[image.id] = {
          state: 'completed',
          mediaId: pin.publerMediaId,
          jobId: pin.mediaJobId,
        }
      } else if (pin?.mediaJobId && pin.state !== 'failed') {
        nextMediaByImageId[image.id] = {
          state: 'processing',
          jobId: pin.mediaJobId,
        }
      } else if (pin?.mediaJobId && pin.state === 'failed') {
        nextMediaByImageId[image.id] = {
          state: 'failed',
          jobId: pin.mediaJobId,
          error: pin.errors[pin.errors.length - 1] ?? 'Media upload failed.',
        }
      } else {
        nextMediaByImageId[image.id] = { state: 'idle' }
      }

      if (pin?.state === 'scheduled') {
        nextScheduleByImageId[image.id] = {
          state: 'scheduled',
          scheduleJobId: pin.scheduleJobId ?? job.publerScheduleJobId,
          scheduledPostId: pin.scheduledPostId,
        }
      } else if (pin?.scheduleJobId && pin.state === 'failed') {
        nextScheduleByImageId[image.id] = {
          state: 'failed',
          scheduleJobId: pin.scheduleJobId,
          error: pin.errors[pin.errors.length - 1] ?? 'Schedule failed.',
        }
      } else if (pin?.scheduleJobId && job.status === 'scheduling') {
        nextScheduleByImageId[image.id] = {
          state: 'processing',
          scheduleJobId: pin.scheduleJobId,
        }
      } else if (pin?.scheduleJobId) {
        nextScheduleByImageId[image.id] = {
          state: 'queued',
          scheduleJobId: pin.scheduleJobId,
        }
      } else {
        nextScheduleByImageId[image.id] = { state: 'idle' }
      }
    })

    setCopyByImageId(nextCopyByImageId)
    setMediaUploadByImageId(nextMediaByImageId)
    setSchedulePublishByImageId(nextScheduleByImageId)
    setLastScheduleJobId(job.publerScheduleJobId ?? '')
    setActiveRunJobId(job.jobId)
    void syncCoverageFromJob(job)

    if (announce) {
      const scheduledCount = job.pins.filter((pin) => pin.state === 'scheduled').length
      const failedCount = job.pins.filter((pin) => pin.state === 'failed').length
      setStatus(
        `Restored run job ${job.jobId} (${job.status}). Scheduled: ${scheduledCount}, failed: ${failedCount}.`,
      )
    }
  }

  async function restoreLatestRunState(): Promise<void> {
    const jobs = await loadJobs()
    const candidate = pickLatestRelevantJob(jobs)
    if (!candidate) {
      return
    }
    applyPersistedJobToUi(candidate, true)
  }

  async function requestBackgroundJobResume(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'PINFORGE_RESUME_JOBS' })
    } catch {
      // background may be unavailable in dev races; ignore
    }
  }

  async function refreshCoverageRecords(): Promise<void> {
    const workspaceId = settings.workspaceId.trim()
    const records = await listArticleCoverageRecords(workspaceId || undefined)
    setCoverageRecords(records)
  }

  async function refreshCurrentArticleCoverage(
    canonicalUrl: string,
    images: ScrapedImage[],
  ): Promise<void> {
    const workspaceId = settings.workspaceId.trim()
    if (workspaceId === '' || canonicalUrl.trim() === '') {
      setCurrentArticleCoverage(null)
      return
    }

    const record = await getArticleCoverageRecord(workspaceId, canonicalUrl)
    if (!record) {
      setCurrentArticleCoverage(null)
      return
    }

    const imageFingerprints = new Set(images.map((image) => buildImageFingerprint(image.image_url)))
    const matchedImages = record.images.filter((item) => imageFingerprints.has(item.imageFingerprint))
    if (matchedImages.length === 0) {
      setCurrentArticleCoverage(null)
      return
    }

    const scheduled = matchedImages.filter((item) => item.state === 'scheduled').length
    const failed = matchedImages.filter((item) => item.state === 'failed').length
    const pending = matchedImages.length - scheduled - failed
    const coveragePercent =
      matchedImages.length === 0 ? 0 : Math.round((scheduled / matchedImages.length) * 100)

    const scoped: ArticleCoverageRecord = {
      ...record,
      totalImages: matchedImages.length,
      scheduledImages: scheduled,
      failedImages: failed,
      pendingImages: pending,
      coveragePercent,
      status: deriveCoverageStatus(matchedImages.length, scheduled, failed, pending),
      images: matchedImages,
    }

    setCurrentArticleCoverage(scoped)
  }

  async function syncCoverageFromJob(job: PinJob): Promise<void> {
    const workspaceId = job.workspaceId.trim()
    const canonicalUrl = normalizeArticleUrl(job.sourceUrl)
    if (workspaceId === '' || canonicalUrl === '') {
      return
    }

    const existing = await getArticleCoverageRecord(workspaceId, canonicalUrl)
    const now = new Date().toISOString()
    const imageMap = new Map<string, ArticleImageCoverage>()

    ;(existing?.images ?? []).forEach((image) => {
      imageMap.set(image.imageFingerprint, image)
    })

    job.pins.forEach((pin) => {
      const imageFingerprint = buildImageFingerprint(pin.sourceImageUrl)
      if (imageFingerprint === '') {
        return
      }

      const previous = imageMap.get(imageFingerprint)
      const nextState: ArticleImageCoverage['state'] =
        pin.state === 'scheduled' ? 'scheduled' : pin.state === 'failed' ? 'failed' : 'pending'

      const nextRecord: ArticleImageCoverage = {
        imageUrl: pin.sourceImageUrl,
        imageFingerprint,
        state: mergeCoverageState(previous?.state, nextState),
        scheduledPostId: pin.scheduledPostId ?? previous?.scheduledPostId,
        boardId: pin.boardId || previous?.boardId,
        scheduledAt: pin.scheduledAt || previous?.scheduledAt,
        lastError:
          pin.errors[pin.errors.length - 1] ??
          (nextState === 'failed' ? previous?.lastError : undefined),
        updatedAt: now,
      }

      imageMap.set(imageFingerprint, nextRecord)
    })

    const images = [...imageMap.values()]
    const totalImages = images.length
    const scheduledImages = images.filter((image) => image.state === 'scheduled').length
    const failedImages = images.filter((image) => image.state === 'failed').length
    const pendingImages = totalImages - scheduledImages - failedImages
    const coveragePercent =
      totalImages === 0 ? 0 : Math.round((scheduledImages / totalImages) * 100)
    const status = deriveCoverageStatus(totalImages, scheduledImages, failedImages, pendingImages)

    const runJobIds = [...new Set([...(existing?.runJobIds ?? []), job.jobId])]
    const record: ArticleCoverageRecord = {
      workspaceId,
      canonicalUrl,
      sourceTitle: job.sourceTitle?.trim() || existing?.sourceTitle || '',
      status,
      totalImages,
      scheduledImages,
      failedImages,
      pendingImages,
      coveragePercent,
      runJobIds,
      images,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    await upsertArticleCoverageRecord(record)
    if (scrapeResult?.canonicalUrl && normalizeArticleUrl(scrapeResult.canonicalUrl) === canonicalUrl) {
      await refreshCurrentArticleCoverage(scrapeResult.canonicalUrl, scrapeResult.images)
    }
    await refreshCoverageRecords()
  }

  function selectOnlyUnscheduledImages(): void {
    if (!scrapeResult) {
      setStatus('Run scraper first before filtering unscheduled images.')
      return
    }
    if (!currentArticleCoverage) {
      setStatus('No previous coverage found for this article.')
      return
    }

    const scheduledFingerprints = new Set(
      currentArticleCoverage.images
        .filter((image) => image.state === 'scheduled')
        .map((image) => image.imageFingerprint),
    )

    const nextIds = scrapeResult.images
      .filter((image) => !scheduledFingerprints.has(buildImageFingerprint(image.image_url)))
      .map((image) => image.id)

    if (nextIds.length === 0) {
      setStatus('All scraped images are already scheduled for this article.')
      return
    }

    setSelectedImageIds(nextIds)
    setSelectedCopyIds(nextIds)
    setStatus(`Selected ${nextIds.length} unscheduled image(s) for this article.`)
  }

  async function loadSettings(): Promise<void> {
    if (!chrome.storage?.local) {
      setStatus('Chrome storage unavailable in current context.')
      return
    }

    const saved = await chrome.storage.local.get(SETTINGS_KEY)
    const nextSettings = saved[SETTINGS_KEY] as SettingsState | undefined
    if (!nextSettings) {
      return
    }

    setSettings({
      ...DEFAULT_SETTINGS,
      ...nextSettings,
      selectedBoardIds: nextSettings.selectedBoardIds ?? [],
    })
    setStatus('Settings loaded.')
  }

  async function saveSettings(): Promise<void> {
    if (!chrome.storage?.local) {
      setStatus('Chrome storage unavailable in current context.')
      return
    }

    setIsLoading(true)
    setStatus('Saving settings...')

    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
      setStatus('Settings saved.')
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setStatus(`Save failed: ${text}`)
    } finally {
      setIsLoading(false)
    }
  }

  const fetchWorkspacesFromApi = useCallback(
    async (options?: { quiet?: boolean }): Promise<void> => {
      const apiKey = settings.apiKey.trim()
      if (!apiKey) {
        if (!options?.quiet) {
          setStatus('Enter Publer API key first.')
        }
        return
      }

      setIsLoadingWorkspaces(true)
      if (!options?.quiet) {
        setStatus('Loading workspaces from Publer...')
      }

      try {
        const client = new PublerClient({
          apiKey,
          workspaceId: '',
        })
        const workspaces = await client.getWorkspaces()
        setWorkspaceOptions(workspaces)
        setSettings((current) => {
          const existingStillValid = workspaces.some(
            (workspace) => workspace.id === current.workspaceId,
          )
          if (existingStillValid) {
            return current
          }

          const autoWorkspaceId = workspaces[0]?.id ?? ''
          return {
            ...current,
            workspaceId: autoWorkspaceId,
          }
        })

        if (!options?.quiet) {
          if (workspaces.length === 0) {
            setStatus('No workspaces found for this API key.')
          } else {
            setStatus(`Loaded ${workspaces.length} workspace(s). Workspace ID auto-filled.`)
          }
        }
      } catch (error) {
        if (!options?.quiet) {
          const text = error instanceof Error ? error.message : String(error)
          setStatus(`Workspace lookup failed: ${text}`)
        }
      } finally {
        setIsLoadingWorkspaces(false)
      }
    },
    [settings.apiKey],
  )

  useEffect(() => {
    if (activeTab !== 'settings') {
      return
    }
    if (settings.apiKey.trim().length < 10) {
      return
    }

    const timeoutId = setTimeout(() => {
      void fetchWorkspacesFromApi({ quiet: true })
    }, 700)

    return () => {
      clearTimeout(timeoutId)
    }
  }, [activeTab, settings.apiKey, fetchWorkspacesFromApi])

  async function refreshAiModelCatalog(): Promise<void> {
    if (settings.aiProvider === 'custom_endpoint') {
      setAiModelCatalog([])
      setStatus('Custom endpoint selected. Model catalog is not available.')
      return
    }

    if (settings.aiApiKey.trim() === '') {
      setStatus(`Enter ${getAiProviderLabel(settings.aiProvider)} API key first.`)
      return
    }

    setIsLoadingAiModels(true)
    setStatus(`Loading ${getAiProviderLabel(settings.aiProvider)} model list...`)

    try {
      const models = await AIClient.listModels({
        provider: settings.aiProvider,
        apiKey: settings.aiApiKey,
        model: settings.aiModel,
        customEndpoint: settings.aiCustomEndpoint,
      })
      setAiModelCatalog(models)
      setSettings((current) => ({
        ...current,
        aiModel: current.aiModel.trim() !== '' ? current.aiModel : models[0] ?? '',
      }))
      setStatus(`Loaded ${models.length} model(s) from ${getAiProviderLabel(settings.aiProvider)}.`)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setStatus(`Model list failed: ${text}`)
    } finally {
      setIsLoadingAiModels(false)
    }
  }

  async function connectAndLoadAccounts(): Promise<void> {
    if (!canConnect) {
      setStatus('Enter both Publer API key and workspace ID first.')
      return
    }

    setIsLoading(true)
    setStatus('Loading Pinterest accounts...')

    try {
      const client = createClient()
      const pinterestAccounts = await client.getPinterestAccounts()
      setAccounts(pinterestAccounts)

      if (pinterestAccounts.length === 0) {
        setBoards([])
        setSettings((current) => ({
          ...current,
          selectedAccountId: '',
          selectedBoardIds: [],
          primaryBoardId: '',
        }))
        setStatus('Connected, but no Pinterest accounts were found in this workspace.')
        return
      }

      const preferredAccount =
        pinterestAccounts.find(
          (account) => String(account.id) === settings.selectedAccountId,
        ) ?? pinterestAccounts[0]
      await loadBoardsForAccount(preferredAccount.id, client)
      setStatus(`Connected. Found ${pinterestAccounts.length} Pinterest account(s).`)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setStatus(`Connection failed: ${text}`)
    } finally {
      setIsLoading(false)
    }
  }

  async function loadBoardsForAccount(
    accountId: string | number,
    existingClient?: PublerClient,
  ): Promise<void> {
    const client = existingClient ?? createClient()
    const accountBoards = await client.getPinterestBoards(accountId)
    const normalizedAccountId = String(accountId)

    setBoards(accountBoards)
    setBoardSearchInput('')
    setSettings((current) => {
      const sanitizedSelectedBoards = current.selectedBoardIds.filter((boardId) =>
        accountBoards.some((board) => board.id === boardId),
      )
      const nextPrimaryBoardId = sanitizedSelectedBoards.includes(current.primaryBoardId)
        ? current.primaryBoardId
        : sanitizedSelectedBoards[0] ?? ''

      return {
        ...current,
        selectedAccountId: normalizedAccountId,
        selectedBoardIds: sanitizedSelectedBoards,
        primaryBoardId: nextPrimaryBoardId,
      }
    })

    setStatus(`Loaded ${accountBoards.length} board(s) for selected account.`)
  }

  function createClient(): PublerClient {
    return new PublerClient({
      apiKey: settings.apiKey,
      workspaceId: settings.workspaceId,
    })
  }

  function generateRunJobId(): string {
    const seed = `${settings.workspaceId}:${Date.now()}:${Math.random()}`
    return `run-${Math.abs(hashString(seed))}`
  }

  function buildPinDraftFromImage(image: ScrapedImage): PinDraft {
    const copy = getCopyState(copyByImageId, image.id)
    const media = getMediaUploadState(mediaUploadByImageId, image.id)
    const publish = getSchedulePublishState(schedulePublishByImageId, image.id)
    const schedule = scheduleByImageId.get(image.id)

    let state: PinDraft['state'] = 'draft'
    if (publish.state === 'scheduled') {
      state = 'scheduled'
    } else if (publish.state === 'failed' || media.state === 'failed') {
      state = 'failed'
    } else if (
      (media.state === 'cached' || media.state === 'completed') &&
      hasGeneratedCopy(copy) &&
      schedule
    ) {
      state = 'ready'
    }

    const errors = [media.error, publish.error]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim())

    return {
      id: image.id,
      sourceImageUrl: image.image_url,
      sourceImageAlt: image.alt,
      contextHeading: image.nearest_heading,
      publerMediaId: media.mediaId,
      mediaJobId: media.jobId,
      title: copy.title,
      description: copy.description,
      altText: copy.altText,
      boardId: schedule?.boardId ?? '',
      scheduledAt: schedule?.scheduledAtIso ?? '',
      scheduleJobId: publish.scheduleJobId,
      scheduledPostId: publish.scheduledPostId,
      keywordsUsed: copy.keywordsUsed,
      state,
      errors,
    }
  }

  function buildRunJobSnapshot(
    jobId: string,
    statusValue: PinJobStatus,
    targetImages: ScrapedImage[],
    createdAtValue?: string,
  ): PinJob {
    const now = new Date().toISOString()
    const publerMediaJobIds = [...new Set(
      targetImages
        .map((image) => getMediaUploadState(mediaUploadByImageId, image.id).jobId)
        .filter((jobId): jobId is string => !!jobId),
    )]

    return {
      jobId,
      workspaceId: settings.workspaceId,
      apiKeySnapshot: settings.apiKey.trim(),
      sourceTitle: scrapeResult?.postTitle ?? '',
      publerScheduleJobId: lastScheduleJobId || undefined,
      publerMediaJobIds,
      status: statusValue,
      createdAt: createdAtValue ?? now,
      updatedAt: now,
      sourceUrl: scrapeResult?.canonicalUrl ?? '',
      settings: {
        startDate: scheduleSettings.startAtLocal,
        gapDays: scheduleSettings.gapDays,
        jitterDays: scheduleSettings.jitterDays,
        boardPool: [...settings.selectedBoardIds],
        primaryBoardId: settings.primaryBoardId,
        primaryShare: scheduleSettings.primarySharePercent,
      },
      pins: targetImages.map((image) => buildPinDraftFromImage(image)),
    }
  }

  async function ensureRunJob(
    statusValue: PinJobStatus,
    targetImages: ScrapedImage[],
  ): Promise<PinJob> {
    const jobs = await loadJobs()
    const existing = activeRunJobId
      ? jobs.find((job) => job.jobId === activeRunJobId)
      : undefined

    if (existing) {
      const next = buildRunJobSnapshot(
        existing.jobId,
        statusValue,
        targetImages,
        existing.createdAt,
      )
      next.publerScheduleJobId = existing.publerScheduleJobId
      await upsertJob(next)
      setActiveRunJobId(next.jobId)
      return next
    }

    const jobId = generateRunJobId()
    const next = buildRunJobSnapshot(jobId, statusValue, targetImages)
    await upsertJob(next)
    setActiveRunJobId(next.jobId)
    return next
  }

  async function persistRunJob(next: PinJob): Promise<void> {
    next.updatedAt = new Date().toISOString()
    await upsertJob(next)
    setActiveRunJobId(next.jobId)
    await syncCoverageFromJob(next)
  }

  function handleBoardToggle(boardId: string): void {
    setSettings((current) => {
      const alreadySelected = current.selectedBoardIds.includes(boardId)
      const nextSelectedBoardIds = alreadySelected
        ? current.selectedBoardIds.filter((id) => id !== boardId)
        : [...current.selectedBoardIds, boardId]

      const nextPrimaryBoardId = nextSelectedBoardIds.includes(current.primaryBoardId)
        ? current.primaryBoardId
        : nextSelectedBoardIds[0] ?? ''

      return {
        ...current,
        selectedBoardIds: nextSelectedBoardIds,
        primaryBoardId: nextPrimaryBoardId,
      }
    })
  }

  async function handleAccountChange(nextAccountId: string): Promise<void> {
    const selectedAccount = accounts.find(
      (account) => String(account.id) === nextAccountId,
    )
    const resolvedAccountId = selectedAccount?.id ?? nextAccountId

    setSettings((current) => ({
      ...current,
      selectedAccountId: String(resolvedAccountId),
      selectedBoardIds: [],
      primaryBoardId: '',
    }))

    setIsLoading(true)
    setStatus('Loading boards for selected account...')
    try {
      await loadBoardsForAccount(resolvedAccountId)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setStatus(`Failed to load boards: ${text}`)
    } finally {
      setIsLoading(false)
    }
  }

  function loadDemoBoards(): void {
    const demoAccountId = 'demo-pinterest'
    const demoBoards: PinterestBoard[] = [
      { accountId: demoAccountId, id: 'demo-home', name: 'Demo Home Decor' },
      { accountId: demoAccountId, id: 'demo-kitchen', name: 'Demo Kitchen Tips' },
      { accountId: demoAccountId, id: 'demo-diy', name: 'Demo DIY Projects' },
    ]

    setAccounts([{ id: demoAccountId, provider: 'pinterest', name: 'Demo Pinterest Account' }])
    setBoards(demoBoards)
    setSettings((current) => ({
      ...current,
      selectedAccountId: demoAccountId,
      selectedBoardIds: demoBoards.map((board) => board.id),
      primaryBoardId: demoBoards[0].id,
    }))
    setStatus('Demo boards loaded. You can test schedule preview without Publer API.')
  }

  async function scrapeCurrentTab(): Promise<void> {
    setIsLoading(true)
    setStatus('Scraping current tab...')

    try {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!currentTab?.id) {
        throw new Error('No active tab found.')
      }
      if (!currentTab.url || !/^https?:\/\//i.test(currentTab.url)) {
        throw new Error('Open a normal http/https webpage before running scraper.')
      }

      const response = await requestScrapeWithInjectionFallback(currentTab.id)
      if (!response?.ok) {
        throw new Error(response?.error ?? 'Scraper failed.')
      }

      const normalized = normalizeScrapeResult(response.data, currentTab.url ?? '')
      setScrapeResult(normalized)
      setSelectedImageIds(normalized.images.map((image) => image.id))
      setCopyByImageId({})
      setMediaUploadByImageId({})
      setSchedulePublishByImageId({})
      setLastScheduleJobId('')
      setActiveRunJobId('')
      setSelectedCopyIds(normalized.images.map((image) => image.id))
      await refreshCurrentArticleCoverage(normalized.canonicalUrl, normalized.images)
      setStatus(`Scrape complete. ${normalized.images.length} eligible image(s) found.`)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setStatus(`Scrape failed: ${text}`)
    } finally {
      setIsLoading(false)
    }
  }

  function toggleImageSelection(imageId: string): void {
    setSelectedImageIds((current) =>
      current.includes(imageId)
        ? current.filter((id) => id !== imageId)
        : [...current, imageId],
    )
  }

  function selectAllImages(): void {
    if (!scrapeResult) {
      return
    }
    setSelectedImageIds(scrapeResult.images.map((image) => image.id))
  }

  function clearImageSelection(): void {
    setSelectedImageIds([])
  }

  function toggleCopySelection(imageId: string): void {
    setSelectedCopyIds((current) =>
      current.includes(imageId)
        ? current.filter((id) => id !== imageId)
        : [...current, imageId],
    )
  }

  function updateCopyField(
    imageId: string,
    updater: (current: ImageCopyState) => ImageCopyState,
  ): void {
    setCopyByImageId((current) => {
      const next = { ...current }
      next[imageId] = updater(getCopyState(current, imageId))
      return next
    })
  }

  function updateMediaUploadField(
    imageId: string,
    updater: (current: MediaUploadState) => MediaUploadState,
  ): void {
    setMediaUploadByImageId((current) => {
      const next = { ...current }
      next[imageId] = updater(getMediaUploadState(current, imageId))
      return next
    })
  }

  function updateSchedulePublishField(
    imageId: string,
    updater: (current: SchedulePublishState) => SchedulePublishState,
  ): void {
    setSchedulePublishByImageId((current) => {
      const next = { ...current }
      next[imageId] = updater(getSchedulePublishState(current, imageId))
      return next
    })
  }

  async function generateTitlesForSelected(): Promise<void> {
    await runTitleGeneration(selectedCopyIds, 'selected')
  }

  async function generateTitlesForAll(): Promise<void> {
    await runTitleGeneration(selectedImages.map((image) => image.id), 'all')
  }

  async function generateDescriptionsForSelected(): Promise<void> {
    await runDescriptionGeneration(selectedCopyIds, 'selected')
  }

  async function generateDescriptionsForAll(): Promise<void> {
    await runDescriptionGeneration(selectedImages.map((image) => image.id), 'all')
  }

  async function runTitleGeneration(targetIds: string[], modeLabel: string): Promise<void> {
    if (!scrapeResult) {
      setStatus('Run scraper first before generating titles.')
      return
    }

    const targetSet = new Set(targetIds)
    const targetImages = selectedImages.filter((image) => targetSet.has(image.id))
    if (targetImages.length === 0) {
      setStatus('Select at least one image for title generation.')
      return
    }
    if (aiConfigError) {
      setStatus(aiConfigError)
      return
    }

    setIsGeneratingCopy(true)
    setStatus(`Step 1/2: Generating titles for ${targetImages.length} ${modeLabel} image(s)...`)

    try {
      const client = new AIClient({
        provider: settings.aiProvider,
        apiKey: settings.aiApiKey,
        model: settings.aiModel,
        customEndpoint: settings.aiCustomEndpoint,
      })
      const payload = buildAiPayloadForImages(targetImages)
      const generated = await client.generateTitles(payload)
      if (generated.length !== targetImages.length) {
        throw new Error(
          `AI returned ${generated.length} items for ${targetImages.length} target images.`,
        )
      }

      setCopyByImageId((current) => {
        const next = { ...current }
        targetImages.forEach((image, index) => {
          const previous = getCopyState(next, image.id)
          const row = sanitizeGeneratedCopy(generated[index])
          const generatedTitle = enforceArticleReflectionOnTitle(row.title, scrapeResult.postTitle)
          next[image.id] = {
            ...previous,
            title: previous.lockTitle && previous.title.trim() !== '' ? previous.title : generatedTitle,
            description: '',
            altText: previous.altText,
            keywordsUsed: row.keywordsUsed,
          }
        })
        return next
      })

      setStatus(
        `Step 1/2 complete: titles generated for ${targetImages.length} image(s). Now run description generation.`,
      )
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setStatus(`Title generation failed: ${text}`)
    } finally {
      setIsGeneratingCopy(false)
    }
  }

  async function runDescriptionGeneration(targetIds: string[], modeLabel: string): Promise<void> {
    if (!scrapeResult) {
      setStatus('Run scraper first before generating descriptions.')
      return
    }

    const targetSet = new Set(targetIds)
    const targetImages = selectedImages.filter((image) => targetSet.has(image.id))
    if (targetImages.length === 0) {
      setStatus('Select at least one image for description generation.')
      return
    }
    if (aiConfigError) {
      setStatus(aiConfigError)
      return
    }

    const titles = targetImages.map((image) => getCopyState(copyByImageId, image.id).title.trim())
    if (titles.some((title) => title === '')) {
      setStatus(
        'Step 2/2 requires titles first. Generate titles for all target images before descriptions.',
      )
      return
    }

    setIsGeneratingCopy(true)
    setStatus(
      `Step 2/2: Generating descriptions for ${targetImages.length} ${modeLabel} image(s)...`,
    )

    try {
      const client = new AIClient({
        provider: settings.aiProvider,
        apiKey: settings.aiApiKey,
        model: settings.aiModel,
        customEndpoint: settings.aiCustomEndpoint,
      })
      const payload = buildAiPayloadForImages(targetImages)
      const generated = await client.generateDescriptions(payload, titles)
      if (generated.length !== targetImages.length) {
        throw new Error(
          `AI returned ${generated.length} items for ${targetImages.length} target images.`,
        )
      }

      setCopyByImageId((current) => {
        const next = { ...current }
        targetImages.forEach((image, index) => {
          const previous = getCopyState(next, image.id)
          const row = sanitizeGeneratedCopy(generated[index])
          next[image.id] = {
            ...previous,
            title: previous.title,
            description: row.description,
            altText: previous.altText,
            keywordsUsed: row.keywordsUsed,
          }
        })
        return next
      })

      setStatus(`Step 2/2 complete: descriptions generated for ${targetImages.length} image(s).`)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setStatus(`Description generation failed: ${text}`)
    } finally {
      setIsGeneratingCopy(false)
    }
  }

  function buildAiPayloadForImages(targetImages: ScrapedImage[]): {
    post_title: string
    destination_url: string
    global_keywords?: string[]
    force_keywords: boolean
    title_style: TitleStyle
    images: Array<{
      image_url: string
      alt: string
      caption: string
      nearest_heading: string
      section_heading_path: string[]
      surrounding_text_snippet: string
      preferred_keywords: string[]
    }>
  } {
    if (!scrapeResult) {
      throw new Error('Scrape result unavailable for AI generation.')
    }

    const globalKeywords = parseKeywordsInput(globalKeywordsInput)
    return {
      post_title: scrapeResult.postTitle,
      destination_url: scrapeResult.canonicalUrl,
      global_keywords: globalKeywords.length > 0 ? globalKeywords : undefined,
      force_keywords: forceKeywords,
      title_style: titleStyle,
      images: targetImages.map((image) => ({
        image_url: image.image_url,
        alt: image.alt,
        caption: image.caption,
        nearest_heading: image.nearest_heading,
        section_heading_path: image.section_heading_path,
        surrounding_text_snippet: image.surrounding_text_snippet,
        preferred_keywords: parseKeywordsInput(
          getCopyState(copyByImageId, image.id).perImageKeywordsInput,
        ),
      })),
    }
  }

  async function uploadSelectedMediaToLibrary(): Promise<void> {
    if (!canConnect) {
      setStatus('Add Publer API key and workspace ID before media upload.')
      return
    }
    if (selectedImages.length === 0) {
      setStatus('Select images first before uploading media cache.')
      return
    }

    setIsUploadingMedia(true)
    setStatus(`Preparing media cache upload for ${selectedImages.length} image(s)...`)

    try {
      const client = createClient()
      const runJob = await ensureRunJob('uploading', selectedImages)
      runJob.status = 'uploading'
      await persistRunJob(runJob)
      const workspaceCache = await loadWorkspaceMediaCache(settings.workspaceId)
      const runtimeMediaCache: Record<string, string> = { ...workspaceCache }
      let processedCount = 0

      const updateRunJobPin = async (
        imageUrl: string,
        updater: (current: PinDraft) => PinDraft,
      ): Promise<void> => {
        const pinIndex = runJob.pins.findIndex((pin) => pin.sourceImageUrl === imageUrl)
        if (pinIndex < 0) {
          return
        }
        runJob.pins[pinIndex] = updater(runJob.pins[pinIndex])
        runJob.publerMediaJobIds = [...new Set(
          runJob.pins
            .map((pin) => pin.mediaJobId)
            .filter((jobId): jobId is string => !!jobId),
        )]
        await persistRunJob(runJob)
      }

      for (const image of selectedImages) {
        const cachedMediaId = runtimeMediaCache[image.image_url]
        if (cachedMediaId) {
          updateMediaUploadField(image.id, () => ({
            state: 'cached',
            mediaId: cachedMediaId,
          }))
          await updateRunJobPin(image.image_url, (current) => ({
            ...current,
            publerMediaId: cachedMediaId,
            state: current.state === 'failed' ? 'failed' : 'ready',
            errors: current.errors.filter((error) => error !== 'Media upload failed.'),
          }))
          processedCount += 1
          setStatus(`Media cache: ${processedCount}/${selectedImages.length} ready.`)
          continue
        }

        updateMediaUploadField(image.id, (current) => ({
          ...current,
          state: 'queued',
          error: undefined,
        }))

        try {
          const upload = await startMediaUploadWithQueueHandling({
            client,
            imageUrl: image.image_url,
            imageId: image.id,
            onUpdate: updateMediaUploadField,
          })

          updateMediaUploadField(image.id, (current) => ({
            ...current,
            state: 'queued',
            jobId: upload.jobId,
            error: undefined,
          }))
          await updateRunJobPin(image.image_url, (current) => ({
            ...current,
            mediaJobId: upload.jobId,
            errors: current.errors.filter((error) => error !== 'Media upload failed.'),
          }))
          const snapshot = await waitForMediaUploadCompletion({
            client,
            imageId: image.id,
            jobId: upload.jobId,
            onUpdate: updateMediaUploadField,
          })

          if (snapshot.state === 'completed' && snapshot.mediaId) {
            await cacheMediaId(settings.workspaceId, image.image_url, snapshot.mediaId)
            runtimeMediaCache[image.image_url] = snapshot.mediaId
            await updateRunJobPin(image.image_url, (current) => ({
              ...current,
              publerMediaId: snapshot.mediaId,
              state: current.state === 'failed' ? 'failed' : 'ready',
              errors: [],
            }))
            processedCount += 1
            setStatus(`Media cache: ${processedCount}/${selectedImages.length} ready.`)
          } else if (snapshot.state === 'completed' && !snapshot.mediaId) {
            updateMediaUploadField(image.id, () => ({
              state: 'failed',
              jobId: upload.jobId,
              error: 'Completed job did not include media ID.',
            }))
            await updateRunJobPin(image.image_url, (current) => ({
              ...current,
              state: 'failed',
              errors: appendError(current.errors, 'Completed job did not include media ID.'),
            }))
            processedCount += 1
            setStatus(`Media cache: ${processedCount}/${selectedImages.length} processed.`)
          } else if (snapshot.state === 'failed') {
            await updateRunJobPin(image.image_url, (current) => ({
              ...current,
              state: 'failed',
              errors: appendError(current.errors, snapshot.error ?? 'Media upload failed.'),
            }))
            processedCount += 1
            setStatus(`Media cache: ${processedCount}/${selectedImages.length} processed.`)
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          updateMediaUploadField(image.id, (current) => ({
            ...current,
              state: 'failed',
              error: text,
            }))
          await updateRunJobPin(image.image_url, (current) => ({
            ...current,
            state: 'failed',
            errors: appendError(current.errors, text),
          }))
          processedCount += 1
          setStatus(`Media cache: ${processedCount}/${selectedImages.length} processed.`)
        }
      }

      const anyMediaReady = runJob.pins.some((pin) => !!pin.publerMediaId)
      runJob.status = anyMediaReady ? 'completed' : 'failed'
      await persistRunJob(runJob)
      setStatus('Media cache upload cycle completed.')
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setStatus(`Media upload failed: ${text}`)
    } finally {
      setIsUploadingMedia(false)
    }
  }

  async function simulateMediaUpload(): Promise<void> {
    if (selectedImages.length === 0) {
      setStatus('Select images first before running media simulation.')
      return
    }

    setIsUploadingMedia(true)
    setStatus(`Simulating media upload for ${selectedImages.length} image(s)...`)

    try {
      for (const image of selectedImages) {
        updateMediaUploadField(image.id, () => ({ state: 'processing' }))
        await wait(200)
        updateMediaUploadField(image.id, () => ({
          state: 'completed',
          mediaId: `demo-${Math.abs(hashString(image.image_url))}`,
        }))
      }
      setStatus('Media upload simulation completed.')
    } finally {
      setIsUploadingMedia(false)
    }
  }

  async function submitScheduleToPubler(): Promise<void> {
    if (!canConnect) {
      setStatus('Add Publer API key and workspace ID before scheduling.')
      return
    }
    if (!scrapeResult) {
      setStatus('Run scraper first before scheduling.')
      return
    }
    if (schedulePreview.error) {
      setStatus(schedulePreview.error)
      return
    }
    if (selectedImages.length === 0) {
      setStatus('Select images first before scheduling.')
      return
    }

    const rows = selectedImages
      .map((image) => ({
        image,
        schedule: scheduleByImageId.get(image.id),
        media: getMediaUploadState(mediaUploadByImageId, image.id),
        copy: getCopyState(copyByImageId, image.id),
      }))
      .filter((item) => item.schedule !== undefined)

    const readyRows = rows.filter((row) => {
      const mediaReady = row.media.state === 'cached' || row.media.state === 'completed'
      return mediaReady && hasGeneratedCopy(row.copy) && !!row.media.mediaId
    })
    const minimumScheduleTime = Date.now() + 60_000
    const futureReadyRows = readyRows.filter((row) => {
      const scheduledAt = new Date(row.schedule!.scheduledAtIso).getTime()
      return Number.isFinite(scheduledAt) && scheduledAt >= minimumScheduleTime
    })

    if (futureReadyRows.length === 0) {
      setStatus(
        'No schedule-ready images with a publish time at least 1 minute in the future.',
      )
      return
    }

    setIsSchedulingPosts(true)
    setStatus(`Submitting ${futureReadyRows.length} post(s) to Publer schedule...`)

    let runJobForFailure: PinJob | null = null
    try {
      const runJob = await ensureRunJob('scheduling', selectedImages)
      runJobForFailure = runJob
      runJob.status = 'scheduling'
      await persistRunJob(runJob)

      const posts = futureReadyRows.map((row) => {
        const mediaItem: Record<string, unknown> = {
          id: row.media.mediaId,
          type: 'image',
        }
        const altText = row.copy.altText.trim()
        if (altText !== '') {
          mediaItem.alt_text = altText
        }

        return {
          networks: {
            pinterest: {
              type: 'photo',
              title: row.copy.title,
              text: row.copy.description,
              url: scrapeResult.canonicalUrl,
              media: [mediaItem],
            },
          },
          accounts: [
            {
              id: settings.selectedAccountId,
              scheduled_at: row.schedule!.scheduledAtIso,
              album_id: row.schedule!.boardId,
            },
          ],
        }
      })

      const client = createClient()
      const submit = await client.schedulePosts({
        bulk: {
          state: 'scheduled',
          posts,
        },
      })
      setLastScheduleJobId(submit.jobId)
      runJob.publerScheduleJobId = submit.jobId

      futureReadyRows.forEach((row) => {
        updateSchedulePublishField(row.image.id, () => ({
          state: 'queued',
          scheduleJobId: submit.jobId,
        }))

        const pinIndex = runJob.pins.findIndex(
          (pin) => pin.sourceImageUrl === row.image.image_url,
        )
        if (pinIndex >= 0) {
          const currentPin = runJob.pins[pinIndex]
          runJob.pins[pinIndex] = {
            ...currentPin,
            publerMediaId: row.media.mediaId,
            title: row.copy.title,
            description: row.copy.description,
            altText: row.copy.altText,
            boardId: row.schedule!.boardId,
            scheduledAt: row.schedule!.scheduledAtIso,
            scheduleJobId: submit.jobId,
            state: currentPin.state === 'failed' ? 'failed' : 'ready',
            errors: currentPin.errors.filter((error) => error !== 'Schedule publish failed.'),
          }
        }
      })
      await persistRunJob(runJob)

      const maxRounds = 120
      let round = 0
      while (round < maxRounds) {
        round += 1
        const snapshot = await client.getJobStatusSnapshot(submit.jobId)

        futureReadyRows.forEach((row) => {
          updateSchedulePublishField(row.image.id, (current) => ({
            ...current,
            state:
              snapshot.state === 'queued'
                ? 'queued'
                : snapshot.state === 'processing'
                  ? 'processing'
                  : snapshot.state === 'completed'
                    ? 'scheduled'
                    : 'failed',
            error: snapshot.state === 'failed' ? snapshot.error ?? 'Schedule failed.' : undefined,
          }))
        })

        if (snapshot.state === 'completed') {
          const outcomes = extractScheduleOutcomesFromJobRaw(snapshot.raw)
          if (outcomes.length > 0) {
            let failedCount = 0
            futureReadyRows.forEach((row, index) => {
              const outcome = outcomes[index]
              const failed = outcome ? isFailureStatus(outcome.status) || !!outcome.error : false
              if (failed) {
                failedCount += 1
              }
              updateSchedulePublishField(row.image.id, (current) => ({
                ...current,
                state: failed ? 'failed' : 'scheduled',
                scheduledPostId: outcome?.postId ?? current.scheduledPostId,
                error: failed ? outcome?.error ?? 'Schedule job returned failure for this post.' : undefined,
              }))

              const pinIndex = runJob.pins.findIndex(
                (pin) => pin.sourceImageUrl === row.image.image_url,
              )
              if (pinIndex >= 0) {
                const currentPin = runJob.pins[pinIndex]
                runJob.pins[pinIndex] = failed
                  ? {
                      ...currentPin,
                      state: 'failed',
                      scheduledPostId: outcome?.postId ?? currentPin.scheduledPostId,
                      errors: appendError(
                        currentPin.errors,
                        outcome?.error ?? 'Schedule publish failed.',
                      ),
                    }
                  : {
                      ...currentPin,
                      state: 'scheduled',
                      scheduledPostId: outcome?.postId ?? currentPin.scheduledPostId,
                      errors: [],
                    }
              }
            })

            runJob.status = failedCount === futureReadyRows.length ? 'failed' : 'completed'
            await persistRunJob(runJob)

            if (failedCount > 0) {
              setStatus(
                `Schedule job completed with ${failedCount} failed post(s). Check each row error and Publer Posts > Failed.`,
              )
            } else {
              setStatus(`Schedule job completed for ${futureReadyRows.length} post(s).`)
            }
            return
          }

          const postIds = extractPostIdsFromJobRaw(snapshot.raw)
          futureReadyRows.forEach((row, index) => {
            updateSchedulePublishField(row.image.id, (current) => ({
              ...current,
              state: 'scheduled',
              scheduledPostId: postIds[index] ?? current.scheduledPostId,
            }))

            const pinIndex = runJob.pins.findIndex(
              (pin) => pin.sourceImageUrl === row.image.image_url,
            )
            if (pinIndex >= 0) {
              const currentPin = runJob.pins[pinIndex]
              runJob.pins[pinIndex] = {
                ...currentPin,
                state: 'scheduled',
                scheduledPostId: postIds[index] ?? currentPin.scheduledPostId,
                errors: [],
              }
            }
          })
          runJob.status = 'completed'
          await persistRunJob(runJob)
          if (postIds.length === 0) {
            setStatus(
              'Schedule job completed but no post IDs were returned. Check Publer Calendar filters/workspace and Posts > Failed.',
            )
          } else {
            setStatus(`Schedule job completed for ${futureReadyRows.length} post(s).`)
          }
          return
        }

        if (snapshot.state === 'failed') {
          futureReadyRows.forEach((row) => {
            const pinIndex = runJob.pins.findIndex(
              (pin) => pin.sourceImageUrl === row.image.image_url,
            )
            if (pinIndex >= 0) {
              const currentPin = runJob.pins[pinIndex]
              runJob.pins[pinIndex] = {
                ...currentPin,
                state: 'failed',
                errors: appendError(
                  currentPin.errors,
                  snapshot.error ?? 'Schedule job failed.',
                ),
              }
            }
          })
          runJob.status = 'failed'
          await persistRunJob(runJob)
          setStatus(`Schedule job failed: ${snapshot.error ?? 'Unknown error.'}`)
          return
        }

        await wait(3000)
      }

      futureReadyRows.forEach((row) => {
        updateSchedulePublishField(row.image.id, (current) => ({
          ...current,
          state: 'failed',
          error: 'Timed out while waiting for schedule job completion.',
        }))

        const pinIndex = runJob.pins.findIndex((pin) => pin.sourceImageUrl === row.image.image_url)
        if (pinIndex >= 0) {
          const currentPin = runJob.pins[pinIndex]
          runJob.pins[pinIndex] = {
            ...currentPin,
            state: 'failed',
            errors: appendError(
              currentPin.errors,
              'Timed out while waiting for schedule job completion.',
            ),
          }
        }
      })
      runJob.status = 'failed'
      await persistRunJob(runJob)
      setStatus('Schedule polling timed out.')
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (runJobForFailure) {
        runJobForFailure.status = 'failed'
        await persistRunJob(runJobForFailure)
      }
      setStatus(`Schedule submission failed: ${text}`)
    } finally {
      setIsSchedulingPosts(false)
    }
  }

  async function simulateScheduleSubmission(): Promise<void> {
    if (selectedImages.length === 0) {
      setStatus('Select images first before schedule simulation.')
      return
    }

    const rows = selectedImages
      .map((image) => ({
        image,
        schedule: scheduleByImageId.get(image.id),
      }))
      .filter((row) => row.schedule !== undefined)

    if (rows.length === 0) {
      setStatus('No schedule rows available to simulate.')
      return
    }

    setIsSchedulingPosts(true)
    setStatus(`Simulating schedule submission for ${rows.length} image(s)...`)

    try {
      const fakeJobId = `demo-schedule-${Date.now()}`
      setLastScheduleJobId(fakeJobId)
      for (const row of rows) {
        updateSchedulePublishField(row.image.id, () => ({
          state: 'processing',
          scheduleJobId: fakeJobId,
        }))
        await wait(150)
        updateSchedulePublishField(row.image.id, () => ({
          state: 'scheduled',
          scheduleJobId: fakeJobId,
          scheduledPostId: `demo-post-${Math.abs(hashString(row.image.id))}`,
        }))
      }
      setStatus('Schedule simulation completed.')
    } finally {
      setIsSchedulingPosts(false)
    }
  }

  function exportRunReportCsv(): void {
    if (selectedImages.length === 0) {
      setStatus('Select images first before exporting report.')
      return
    }

    const header = [
      'image_url',
      'title',
      'board_id',
      'board_name',
      'scheduled_at',
      'status',
      'post_id',
      'media_id',
      'error',
    ]

    const rows = selectedImages.map((image) => {
      const copy = getCopyState(copyByImageId, image.id)
      const scheduleRow = scheduleByImageId.get(image.id)
      const publish = getSchedulePublishState(schedulePublishByImageId, image.id)
      const media = getMediaUploadState(mediaUploadByImageId, image.id)
      return [
        image.image_url,
        copy.title,
        scheduleRow?.boardId ?? '',
        scheduleRow?.boardName ?? '',
        scheduleRow?.scheduledAtIso ?? '',
        publish.state,
        publish.scheduledPostId ?? '',
        media.mediaId ?? '',
        publish.error ?? media.error ?? '',
      ]
    })

    const csvText = [header, ...rows]
      .map((row) => row.map((value) => csvEscape(String(value))).join(','))
      .join('\n')

    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = 'PinForge-report.csv'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(objectUrl)

    setStatus(`Exported CSV report for ${rows.length} image(s).`)
  }

  return (
    <main className="popup-shell">
      <header>
        <p className="eyebrow">PinForge</p>
        <h1>Pinterest Pin Scheduler</h1>
        <p className="subtitle">
          Scrape images, generate copy, and schedule Pinterest pins through Publer.
        </p>
      </header>

      <div className="tab-row">
        <button
          type="button"
          className={activeTab === 'run' ? 'tab-button active' : 'tab-button'}
          onClick={() => setActiveTab('run')}
        >
          Run
        </button>
        <button
          type="button"
          className={activeTab === 'settings' ? 'tab-button active' : 'tab-button'}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
        <button
          type="button"
          className={activeTab === 'done' ? 'tab-button active' : 'tab-button'}
          onClick={() => setActiveTab('done')}
        >
          Done
        </button>
      </div>

      {activeTab === 'settings' && (
        <>
      <section className="card">
        <label htmlFor="publer-api-key">Publer API Key</label>
        <input
          id="publer-api-key"
          type="password"
          placeholder="Bearer-API key"
          value={settings.apiKey}
          onChange={(event) =>
            setSettings((current) => ({ ...current, apiKey: event.target.value }))
          }
          onBlur={() => void fetchWorkspacesFromApi({ quiet: true })}
        />

        <label htmlFor="publer-workspace-id">Workspace ID</label>
        {workspaceOptions.length > 0 && (
          <select
            id="publer-workspace-select"
            value={settings.workspaceId}
            onChange={(event) =>
              setSettings((current) => ({ ...current, workspaceId: event.target.value }))
            }
          >
            {workspaceOptions.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} ({workspace.id})
              </option>
            ))}
          </select>
        )}
        <input
          id="publer-workspace-id"
          type="text"
          placeholder="Workspace ID (auto-filled when API key is valid)"
          value={settings.workspaceId}
          onChange={(event) =>
            setSettings((current) => ({ ...current, workspaceId: event.target.value }))
          }
        />

        <div className="actions">
          <button
            className="button-secondary"
            disabled={
              isLoading ||
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              isLoadingWorkspaces ||
              settings.apiKey.trim() === ''
            }
            onClick={() => void fetchWorkspacesFromApi()}
          >
            {isLoadingWorkspaces ? 'Loading Workspaces...' : 'Auto Fetch Workspace'}
          </button>
          <button
            disabled={isLoading || isGeneratingCopy || isUploadingMedia || isSchedulingPosts}
            onClick={() => void saveSettings()}
          >
            Save Settings
          </button>
        </div>
      </section>

      <section className="card">
        <p className="eyebrow">AI Provider Settings</p>
        <label htmlFor="ai-provider-select">AI Provider</label>
        <select
          id="ai-provider-select"
          value={settings.aiProvider}
          disabled={isLoading || isGeneratingCopy || isUploadingMedia || isSchedulingPosts}
          onChange={(event) => {
            const nextProvider = event.target.value as AIProvider
            setSettings((current) => ({
              ...current,
              aiProvider: nextProvider,
              aiModel: '',
            }))
            setAiModelCatalog([])
          }}
        >
          {AI_PROVIDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {settings.aiProvider === 'custom_endpoint' && (
          <>
            <label htmlFor="ai-custom-endpoint">Custom AI Endpoint</label>
            <input
              id="ai-custom-endpoint"
              type="url"
              placeholder="https://your-endpoint.example.com/generate"
              value={settings.aiCustomEndpoint}
              onChange={(event) =>
                setSettings((current) => ({ ...current, aiCustomEndpoint: event.target.value }))
              }
            />
            <p className="muted no-margin">
              Endpoint must return JSON with a `pins` array or direct array of pin rows.
            </p>
          </>
        )}

        {settings.aiProvider !== 'custom_endpoint' && (
          <>
            <label htmlFor="ai-api-key-input">
              {getAiProviderLabel(settings.aiProvider)} API Key
            </label>
            <input
              id="ai-api-key-input"
              type="password"
              placeholder={`${getAiProviderLabel(settings.aiProvider)} API key`}
              value={settings.aiApiKey}
              onChange={(event) =>
                setSettings((current) => ({ ...current, aiApiKey: event.target.value }))
              }
            />

            {aiModelCatalog.length > 0 && (
              <>
                <label htmlFor="ai-model-select">Model (from provider)</label>
                <select
                  id="ai-model-select"
                  value={aiModelCatalog.includes(settings.aiModel) ? settings.aiModel : ''}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, aiModel: event.target.value }))
                  }
                >
                  <option value="">Select a loaded model</option>
                  {aiModelCatalog.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </>
            )}

            <label htmlFor="ai-model-input">Model ID (editable)</label>
            <input
              id="ai-model-input"
              type="text"
              placeholder="Select above or type model id"
              value={settings.aiModel}
              onChange={(event) =>
                setSettings((current) => ({ ...current, aiModel: event.target.value }))
              }
            />

            <div className="actions">
              <button
                className="button-secondary"
                disabled={
                  isLoading ||
                  isGeneratingCopy ||
                  isUploadingMedia ||
                  isSchedulingPosts ||
                  isLoadingAiModels
                }
                onClick={() => void refreshAiModelCatalog()}
              >
                {isLoadingAiModels ? 'Loading Models...' : 'Load Full Model List'}
              </button>
            </div>
            <p className="muted no-margin">Loaded models: {aiModelCatalog.length}</p>
          </>
        )}

        {aiConfigError && <p className="error-text no-margin">{aiConfigError}</p>}
      </section>
        </>
      )}

      {activeTab === 'run' && (
        <>
      <section className="card card-account-board">
        <div className="actions">
          <button
            disabled={
              isLoading || isGeneratingCopy || isUploadingMedia || isSchedulingPosts || !canConnect
            }
            onClick={() => void connectAndLoadAccounts()}
          >
            Load Accounts
          </button>
          <button
            className="button-secondary"
            disabled={isLoading || isGeneratingCopy || isUploadingMedia || isSchedulingPosts}
            onClick={loadDemoBoards}
          >
            Use Demo Boards
          </button>
        </div>

        <label htmlFor="account-select">Pinterest Account</label>
        <select
          id="account-select"
          value={settings.selectedAccountId}
          disabled={
            isLoading ||
            isGeneratingCopy ||
            isUploadingMedia ||
            isSchedulingPosts ||
            accounts.length === 0
          }
          onChange={(event) => void handleAccountChange(event.target.value)}
        >
          {accounts.length === 0 && <option value="">No account loaded</option>}
          {accounts.map((account) => (
            <option key={String(account.id)} value={String(account.id)}>
              {account.name ?? `Account ${account.id}`}
            </option>
          ))}
        </select>

        <label>Boards ({settings.selectedBoardIds.length} selected)</label>
        <input
          type="text"
          placeholder="Search boards..."
          value={boardSearchInput}
          onChange={(event) => setBoardSearchInput(event.target.value)}
          disabled={boards.length === 0}
        />
        <div className="board-list">
          {boards.length === 0 && <p className="muted">No boards loaded for this account.</p>}
          {boards.length > 0 && filteredBoards.length === 0 && (
            <p className="muted">No boards match your search.</p>
          )}
          {filteredBoards.map((board) => (
            <label className="board-row" key={board.id}>
              <input
                type="checkbox"
                checked={settings.selectedBoardIds.includes(board.id)}
                onChange={() => handleBoardToggle(board.id)}
              />
              <span>{board.name}</span>
            </label>
          ))}
        </div>

        <label htmlFor="primary-board-select">Primary Board</label>
        <select
          id="primary-board-select"
          value={settings.primaryBoardId}
          disabled={selectedBoards.length === 0}
          onChange={(event) =>
            setSettings((current) => ({ ...current, primaryBoardId: event.target.value }))
          }
        >
          {selectedBoards.length === 0 && <option value="">Select boards first</option>}
          {selectedBoards.map((board) => (
            <option key={board.id} value={board.id}>
              {board.name}
            </option>
          ))}
        </select>
      </section>

      <section className="card card-scrape">
        <div className="actions">
          <button
            disabled={isLoading || isGeneratingCopy || isUploadingMedia || isSchedulingPosts}
            onClick={() => void scrapeCurrentTab()}
          >
            Use Current Tab
          </button>
          <button
            disabled={
              isLoading ||
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              !scrapeResult ||
              scrapeResult.images.length === 0
            }
            onClick={selectAllImages}
          >
            Select All
          </button>
          <button
            disabled={
              isLoading ||
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedImageCount === 0
            }
            className="button-secondary"
            onClick={clearImageSelection}
          >
            Clear Selection
          </button>
          <button
            disabled={
              isLoading ||
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              !currentArticleCoverage ||
              !scrapeResult
            }
            className="button-secondary"
            onClick={selectOnlyUnscheduledImages}
          >
            Select Unscheduled Only
          </button>
        </div>

        {!scrapeResult && <p className="muted">No scrape run yet.</p>}

        {scrapeResult && (
          <>
            <div className="preview-box">
              <p>
                <strong>Post:</strong> {scrapeResult.postTitle}
              </p>
              <p>
                <strong>URL:</strong> {scrapeResult.canonicalUrl}
              </p>
              <p>
                <strong>Eligible images:</strong> {scrapeResult.images.length}
              </p>
              <p>
                <strong>Selected:</strong> {selectedImageCount}
              </p>
              {currentArticleCoverage && (
                <p>
                  <strong>Coverage:</strong> {currentArticleCoverage.scheduledImages}/
                  {currentArticleCoverage.totalImages} scheduled ({currentArticleCoverage.coveragePercent}
                  %) - {formatCoverageStatus(currentArticleCoverage.status)}
                </p>
              )}
            </div>

            {scrapeResult.images.length === 0 && (
              <p className="muted">No eligible images found for current tab.</p>
            )}

            {scrapeResult.images.length > 0 && (
              <div className="image-list">
                {scrapeResult.images.map((image) => {
                  const isSelected = selectedImageIds.includes(image.id)
                  return (
                    <article key={image.id} className={`image-item${isSelected ? ' selected' : ''}`}>
                      <div className="image-select">
                        <input
                          className="image-checkbox"
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleImageSelection(image.id)}
                        />
                      </div>
                      <img
                        src={image.image_url}
                        alt={image.alt || 'Post image'}
                        className="image-thumb"
                        loading="lazy"
                      />
                      <div className="image-meta">
                        <p>
                          <strong>Heading:</strong> {image.nearest_heading || 'N/A'}
                        </p>
                        <p>
                          <strong>Path:</strong>{' '}
                          {image.section_heading_path.length > 0
                            ? image.section_heading_path.join(' > ')
                            : 'N/A'}
                        </p>
                        <p>
                          <strong>Caption:</strong> {trimText(image.caption || 'N/A', 120)}
                        </p>
                        <p>
                          <strong>Alt:</strong> {trimText(image.alt || 'N/A', 120)}
                        </p>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </>
        )}
      </section>
      <section className="card card-schedule-settings">
        <p className="eyebrow">Schedule Settings</p>
        <div className="schedule-grid">
          <label htmlFor="start-at-input">
            Start Date/Time
            <input
              id="start-at-input"
              type="datetime-local"
              value={scheduleSettings.startAtLocal}
              onChange={(event) =>
                setScheduleSettings((current) => ({
                  ...current,
                  startAtLocal: event.target.value,
                }))
              }
            />
          </label>

          <label htmlFor="gap-days-input">
            Gap Days
            <input
              id="gap-days-input"
              type="number"
              min={1}
              step={1}
              value={scheduleSettings.gapDays}
              onChange={(event) =>
                setScheduleSettings((current) => ({
                  ...current,
                  gapDays: clampInt(event.target.value, 1, 3650),
                }))
              }
            />
          </label>

          <label htmlFor="jitter-days-input">
            Jitter Days
            <input
              id="jitter-days-input"
              type="number"
              min={0}
              step={1}
              value={scheduleSettings.jitterDays}
              onChange={(event) =>
                setScheduleSettings((current) => ({
                  ...current,
                  jitterDays: clampInt(event.target.value, 0, 365),
                }))
              }
            />
          </label>

          <label htmlFor="primary-share-input">
            Primary Share (%)
            <input
              id="primary-share-input"
              type="number"
              min={0}
              max={100}
              step={1}
              value={scheduleSettings.primarySharePercent}
              onChange={(event) =>
                setScheduleSettings((current) => ({
                  ...current,
                  primarySharePercent: clampInt(event.target.value, 0, 100),
                }))
              }
            />
          </label>
        </div>

        {schedulePreview.error && <p className="error-text">{schedulePreview.error}</p>}
        {!schedulePreview.error && schedulePreview.rows.length > 0 && (
          <>
            <p className="muted no-margin">
              Preview rows: {schedulePreview.rows.length}. Distribution:{' '}
              {schedulePreview.boardSummary}
            </p>
            <div className="schedule-list">
              {schedulePreview.rows.map((row, index) => (
                <article className="schedule-item" key={`${row.image.id}:${row.scheduledAtIso}`}>
                  <img
                    src={row.image.image_url}
                    alt={row.image.alt || 'Scheduled image'}
                    className="schedule-thumb"
                  />
                  <div className="schedule-meta">
                    <p>
                      <strong>#{index + 1}</strong>{' '}
                      {trimText(row.image.nearest_heading || 'No heading', 80)}
                    </p>
                    <p>
                      <strong>Board:</strong> {row.boardName}
                    </p>
                    <p>
                      <strong>At:</strong> {formatDateTime(row.scheduledAtIso)}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="card card-media-upload">
        <p className="eyebrow">Media Cache Upload</p>
        <div className="actions">
          <button
            disabled={
              isLoading ||
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedImages.length === 0 ||
              !canConnect
            }
            onClick={() => void uploadSelectedMediaToLibrary()}
          >
            Upload Selected To Publer Library
          </button>
          <button
            className="button-secondary"
            disabled={
              isLoading ||
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedImages.length === 0
            }
            onClick={() => void simulateMediaUpload()}
          >
            Simulate Media Upload
          </button>
        </div>
        <p className="muted no-margin">
          Media ready: {selectedMediaUploadedCount}/{selectedImages.length}
        </p>
        {selectedImages.length > 0 && (
          <div className="media-status-list">
            {selectedImages.map((image) => {
              const media = getMediaUploadState(mediaUploadByImageId, image.id)
              return (
                <article className="media-status-item" key={`media:${image.id}`}>
                  <img
                    src={image.image_url}
                    alt={image.alt || 'Media image'}
                    className="media-status-thumb"
                  />
                  <div className="media-status-meta">
                    <p>
                      <strong>Status:</strong>{' '}
                      <span className={`status-pill status-${media.state}`}>{media.state}</span>
                    </p>
                    <p>
                      <strong>Media ID:</strong> {media.mediaId ?? 'N/A'}
                    </p>
                    <p>
                      <strong>Job ID:</strong> {media.jobId ?? 'N/A'}
                    </p>
                    {media.error && (
                      <p className="error-text no-margin">
                        <strong>Error:</strong> {trimText(media.error, 180)}
                      </p>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section className="card card-upload-schedule">
        <p className="eyebrow">Upload + Schedule</p>
        <div className="actions">
          <button
            disabled={
              isLoading ||
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedScheduleReadyCount === 0 ||
              !canConnect
            }
            onClick={() => void submitScheduleToPubler()}
          >
            Submit Schedule To Publer
          </button>
          <button
            className="button-secondary"
            disabled={
              isLoading ||
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedImages.length === 0
            }
            onClick={() => void simulateScheduleSubmission()}
          >
            Simulate Schedule
          </button>
          <button
            className="button-secondary"
            disabled={
              isLoading ||
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedImages.length === 0
            }
            onClick={exportRunReportCsv}
          >
            Export CSV Report
          </button>
        </div>

        <p className="muted no-margin">
          Schedule-ready: {selectedScheduleReadyCount}/{selectedImages.length}. Scheduled:{' '}
          {selectedScheduledCount}/{selectedImages.length}
        </p>
        {lastScheduleJobId && (
          <p className="muted no-margin">
            Last schedule job: <strong>{lastScheduleJobId}</strong>
          </p>
        )}

        {selectedImages.length > 0 && (
          <div className="media-status-list">
            {selectedImages.map((image) => {
              const publish = getSchedulePublishState(schedulePublishByImageId, image.id)
              return (
                <article className="media-status-item" key={`schedule:${image.id}`}>
                  <img
                    src={image.image_url}
                    alt={image.alt || 'Schedule image'}
                    className="media-status-thumb"
                  />
                  <div className="media-status-meta">
                    <p>
                      <strong>Status:</strong>{' '}
                      <span className={`status-pill status-${publish.state}`}>{publish.state}</span>
                    </p>
                    <p>
                      <strong>Schedule Job:</strong> {publish.scheduleJobId ?? 'N/A'}
                    </p>
                    <p>
                      <strong>Post ID:</strong> {publish.scheduledPostId ?? 'N/A'}
                    </p>
                    {publish.error && (
                      <p className="error-text no-margin">
                        <strong>Error:</strong> {trimText(publish.error, 180)}
                      </p>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section className="card card-ai-copy">
        <p className="eyebrow">AI Copy</p>
        <p className="muted no-margin">
          Provider: {getAiProviderLabel(settings.aiProvider)}. Model:{' '}
          {settings.aiModel.trim() !== '' ? settings.aiModel : 'not set'}
        </p>
        <p className="muted no-margin">Edit provider/model in the Settings tab.</p>

        {aiConfigError && <p className="error-text no-margin">{aiConfigError}</p>}

        <label htmlFor="title-style-select">Title Style</label>
        <select
          id="title-style-select"
          value={titleStyle}
          onChange={(event) => setTitleStyle(event.target.value as TitleStyle)}
        >
          {TITLE_STYLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label htmlFor="global-keywords-input">Global Keywords (comma or newline separated)</label>
        <textarea
          id="global-keywords-input"
          className="copy-textarea"
          rows={2}
          placeholder="example: home decor, small apartment ideas"
          value={globalKeywordsInput}
          onChange={(event) => setGlobalKeywordsInput(event.target.value)}
        />

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={forceKeywords}
            onChange={(event) => setForceKeywords(event.target.checked)}
          />
          <span>Force include keywords (off = let AI choose relevant keywords)</span>
        </label>

        <div className="actions">
          <button
            disabled={
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedCopyIds.length === 0 ||
              aiConfigError !== null
            }
            onClick={() => void generateTitlesForSelected()}
          >
            Step 1: Generate Titles (Selected)
          </button>
          <button
            disabled={
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedImages.length === 0 ||
              aiConfigError !== null
            }
            className="button-secondary"
            onClick={() => void generateTitlesForAll()}
          >
            Step 1: Generate Titles (All)
          </button>
          <button
            disabled={
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedCopyIds.length === 0 ||
              aiConfigError !== null
            }
            onClick={() => void generateDescriptionsForSelected()}
          >
            Step 2: Generate Descriptions (Selected)
          </button>
          <button
            disabled={
              isGeneratingCopy ||
              isUploadingMedia ||
              isSchedulingPosts ||
              selectedImages.length === 0 ||
              aiConfigError !== null
            }
            className="button-secondary"
            onClick={() => void generateDescriptionsForAll()}
          >
            Step 2: Generate Descriptions (All)
          </button>
        </div>

        <p className="muted no-margin">
          Titles: {generatedTitleCount}/{selectedImages.length}. Descriptions:{' '}
          {generatedDescriptionCount}/{selectedImages.length}. Complete copy: {copiedImageCount}/
          {selectedImages.length}. Selected targets: {selectedCopyIds.length}
        </p>

        {selectedImages.length === 0 && (
          <p className="muted">Select images first to generate copy.</p>
        )}

        {selectedImages.length > 0 && (
          <div className="copy-list">
            {selectedImages.map((image, index) => {
              const copy = getCopyState(copyByImageId, image.id)
              const scheduleRow = scheduleByImageId.get(image.id)
              const selectedForCopy = selectedCopyIds.includes(image.id)
              return (
                <article className="copy-item" key={image.id}>
                  <div className="copy-item-head">
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={selectedForCopy}
                        onChange={() => toggleCopySelection(image.id)}
                      />
                      <span>#{index + 1}</span>
                    </label>
                    <img
                      src={image.image_url}
                      alt={image.alt || 'Pin image'}
                      className="copy-thumb"
                    />
                    <div className="copy-head-meta">
                      <p>
                        <strong>Board:</strong> {scheduleRow?.boardName ?? 'N/A'}
                      </p>
                      <p>
                        <strong>At:</strong>{' '}
                        {scheduleRow ? formatDateTime(scheduleRow.scheduledAtIso) : 'N/A'}
                      </p>
                    </div>
                  </div>

                  <label>Per-image Keywords</label>
                  <input
                    type="text"
                    placeholder="keyword1, keyword2"
                    value={copy.perImageKeywordsInput}
                    onChange={(event) =>
                      updateCopyField(image.id, (current) => ({
                        ...current,
                        perImageKeywordsInput: event.target.value,
                      }))
                    }
                  />

                  <label>Title (max 100)</label>
                  <input
                    type="text"
                    value={copy.title}
                    onChange={(event) =>
                      updateCopyField(image.id, (current) => ({
                        ...current,
                        title: sanitizeCopyText(event.target.value, 100),
                      }))
                    }
                  />

                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={copy.lockTitle}
                      onChange={(event) =>
                        updateCopyField(image.id, (current) => ({
                          ...current,
                          lockTitle: event.target.checked,
                        }))
                      }
                    />
                    <span>Lock title during regenerate</span>
                  </label>

                  <label>Description (max 500)</label>
                  <textarea
                    className="copy-textarea"
                    rows={4}
                    value={copy.description}
                    onChange={(event) =>
                      updateCopyField(image.id, (current) => ({
                        ...current,
                        description: sanitizeCopyText(event.target.value, 500),
                      }))
                    }
                  />

                  <label>Alt text (manual, optional)</label>
                  <input
                    type="text"
                    value={copy.altText}
                    onChange={(event) =>
                      updateCopyField(image.id, (current) => ({
                        ...current,
                        altText: sanitizeCopyText(event.target.value, 200),
                      }))
                    }
                  />

                  <p className="muted no-margin">
                    Keywords used:{' '}
                    {copy.keywordsUsed.length > 0 ? copy.keywordsUsed.join(', ') : 'N/A'}
                  </p>
                </article>
              )
            })}
          </div>
        )}
      </section>
        </>
      )}

      {activeTab === 'done' && (
        <section className="card card-done-list">
          <p className="eyebrow">Article Coverage</p>
          <input
            type="text"
            placeholder="Search by article title or URL..."
            value={coverageSearchInput}
            onChange={(event) => setCoverageSearchInput(event.target.value)}
          />
          <p className="muted no-margin">
            Records: {filteredCoverageRecords.length}
            {settings.workspaceId.trim() !== '' ? ' (current workspace)' : ' (all workspaces)'}
          </p>

          {filteredCoverageRecords.length === 0 && (
            <p className="muted">No article coverage found yet.</p>
          )}

          {filteredCoverageRecords.length > 0 && (
            <div className="done-list">
              {filteredCoverageRecords.map((record) => (
                <article key={`${record.workspaceId}:${record.canonicalUrl}`} className="done-item">
                  <p>
                    <strong>{record.sourceTitle || '(Untitled article)'}</strong>
                  </p>
                  <p>
                    <strong>Status:</strong>{' '}
                    <span className={`status-pill status-${toCoverageStatusClass(record.status)}`}>
                      {formatCoverageStatus(record.status)}
                    </span>
                  </p>
                  <p>
                    <strong>Coverage:</strong> {record.scheduledImages}/{record.totalImages} (
                    {record.coveragePercent}%)
                  </p>
                  <p>
                    <strong>Failed:</strong> {record.failedImages} | <strong>Pending:</strong>{' '}
                    {record.pendingImages}
                  </p>
                  <p>
                    <strong>Updated:</strong> {formatDateTime(record.updatedAt)}
                  </p>
                  <p className="done-url">
                    <a href={record.canonicalUrl} target="_blank" rel="noreferrer">
                      {record.canonicalUrl}
                    </a>
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <footer className="status">
        <strong>Status:</strong> {status}
      </footer>
    </main>
  )
}
async function requestScrapeWithInjectionFallback(
  tabId: number,
): Promise<{ ok?: boolean; data?: unknown; error?: string }> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: 'PINFORGE_SCRAPE' })) as {
      ok?: boolean
      data?: unknown
      error?: string
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('Receiving end does not exist')) {
      throw error
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['scraper.js'],
  })

  return (await chrome.tabs.sendMessage(tabId, { type: 'PINFORGE_SCRAPE' })) as {
    ok?: boolean
    data?: unknown
    error?: string
  }
}

function normalizeScrapeResult(data: unknown, fallbackUrl: string): ScrapeResultView {
  const value = isObject(data) ? data : {}
  const postTitle =
    typeof value.post_title === 'string' && value.post_title.trim() !== ''
      ? value.post_title.trim()
      : '(Untitled)'
  const canonicalUrl =
    typeof value.canonical_url === 'string' && value.canonical_url.trim() !== ''
      ? value.canonical_url.trim()
      : fallbackUrl

  const imagesInput = Array.isArray(value.images) ? value.images : []
  const images: ScrapedImage[] = imagesInput
    .map((rawImage, index) => toScrapedImage(rawImage, index))
    .filter((item): item is ScrapedImage => item !== null)

  return { postTitle, canonicalUrl: normalizeArticleUrl(canonicalUrl), images }
}

function toScrapedImage(value: unknown, index: number): ScrapedImage | null {
  if (!isObject(value) || typeof value.image_url !== 'string' || value.image_url.trim() === '') {
    return null
  }

  const imageUrl = value.image_url.trim()
  const sectionHeadingPath = Array.isArray(value.section_heading_path)
    ? value.section_heading_path.filter((item): item is string => typeof item === 'string')
    : []

  return {
    id: `${index}:${imageUrl}`,
    image_url: imageUrl,
    alt: typeof value.alt === 'string' ? value.alt : '',
    caption: typeof value.caption === 'string' ? value.caption : '',
    nearest_heading: typeof value.nearest_heading === 'string' ? value.nearest_heading : '',
    section_heading_path: sectionHeadingPath,
    surrounding_text_snippet:
      typeof value.surrounding_text_snippet === 'string'
        ? value.surrounding_text_snippet
        : '',
  }
}

function buildSchedulePreview(input: {
  selectedImages: ScrapedImage[]
  allBoards: PinterestBoard[]
  selectedBoardIds: string[]
  primaryBoardId: string
  scheduleSettings: ScheduleSettings
}): { rows: SchedulePreviewRow[]; error: string; boardSummary: string } {
  const uniqueBoardIds = [...new Set(input.selectedBoardIds)].filter((id) => id.trim() !== '')

  if (input.selectedImages.length === 0) {
    return { rows: [], error: 'Select at least one image to preview schedule.', boardSummary: '' }
  }
  if (uniqueBoardIds.length === 0) {
    return {
      rows: [],
      error: 'Select at least one board to generate preview schedule.',
      boardSummary: '',
    }
  }
  if (!input.scheduleSettings.startAtLocal) {
    return { rows: [], error: 'Start date/time is required.', boardSummary: '' }
  }

  const effectivePrimaryBoardId = uniqueBoardIds.includes(input.primaryBoardId)
    ? input.primaryBoardId
    : uniqueBoardIds[0]
  const secondaryBoardIds = uniqueBoardIds.filter((id) => id !== effectivePrimaryBoardId)

  try {
    const boardSequence = buildWeightedBoardSequence({
      totalPins: input.selectedImages.length,
      primaryBoardId: effectivePrimaryBoardId,
      secondaryBoardIds,
      primaryShare: input.scheduleSettings.primarySharePercent / 100,
    })

    const scheduledAt = buildSchedule({
      startAt: new Date(input.scheduleSettings.startAtLocal),
      count: input.selectedImages.length,
      gapDays: input.scheduleSettings.gapDays,
      jitterDays: input.scheduleSettings.jitterDays,
      minuteStepMinutes: 1,
    })

    if (
      boardSequence.length !== input.selectedImages.length ||
      scheduledAt.length !== input.selectedImages.length
    ) {
      throw new Error('Schedule preview generation produced mismatched row count.')
    }

    const boardNameById = new Map(input.allBoards.map((board) => [board.id, board.name]))
    const rows: SchedulePreviewRow[] = input.selectedImages.map((image, index) => {
      const boardId = boardSequence[index]
      return {
        image,
        boardId,
        boardName: boardNameById.get(boardId) ?? `Board ${boardId}`,
        scheduledAtIso: scheduledAt[index],
      }
    })

    const boardCounts = new Map<string, number>()
    rows.forEach((row) => {
      boardCounts.set(row.boardId, (boardCounts.get(row.boardId) ?? 0) + 1)
    })
    const boardSummary = [...boardCounts.entries()]
      .map(([boardId, count]) => `${boardNameById.get(boardId) ?? boardId}: ${count}`)
      .join(', ')

    return { rows, error: '', boardSummary }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { rows: [], error: `Schedule preview failed: ${text}`, boardSummary: '' }
  }
}

function getMediaUploadState(
  mediaByImageId: Record<string, MediaUploadState>,
  imageId: string,
): MediaUploadState {
  return mediaByImageId[imageId] ?? { state: 'idle' }
}

function getSchedulePublishState(
  publishByImageId: Record<string, SchedulePublishState>,
  imageId: string,
): SchedulePublishState {
  return publishByImageId[imageId] ?? { state: 'idle' }
}

function applyUploadSnapshot(input: {
  snapshot: PublerJobStatusSnapshot
  imageId: string
  onUpdate: (imageId: string, updater: (current: MediaUploadState) => MediaUploadState) => void
}): void {
  input.onUpdate(input.imageId, (current) => ({
    ...current,
    state: input.snapshot.state,
    mediaId: input.snapshot.mediaId ?? current.mediaId,
    error: input.snapshot.error,
  }))
}

async function startMediaUploadWithQueueHandling(input: {
  client: PublerClient
  imageUrl: string
  imageId: string
  onUpdate: (imageId: string, updater: (current: MediaUploadState) => MediaUploadState) => void
}): Promise<{ jobId: string }> {
  const maxAttempts = 80
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await input.client.uploadMediaFromUrl(input.imageUrl, {
        inLibrary: true,
        directUpload: true,
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const shouldRetry = isMediaFromUrlQueueLimitError(text) && attempt < maxAttempts - 1
      if (!shouldRetry) {
        throw error
      }

      input.onUpdate(input.imageId, (current) => ({
        ...current,
        state: 'queued',
        error: 'Waiting for previous Publer media download job to finish...',
      }))
      await wait(3000)
    }
  }

  throw new Error('Timed out waiting for Publer media queue availability.')
}

async function waitForMediaUploadCompletion(input: {
  client: PublerClient
  imageId: string
  jobId: string
  onUpdate: (imageId: string, updater: (current: MediaUploadState) => MediaUploadState) => void
}): Promise<PublerJobStatusSnapshot> {
  const maxRounds = 120
  for (let round = 0; round < maxRounds; round += 1) {
    const snapshot = await input.client.getJobStatusSnapshot(input.jobId)
    applyUploadSnapshot({
      snapshot,
      imageId: input.imageId,
      onUpdate: input.onUpdate,
    })

    if (snapshot.state === 'completed' || snapshot.state === 'failed') {
      return snapshot
    }

    await wait(3000)
  }

  const timeoutSnapshot: PublerJobStatusSnapshot = {
    state: 'failed',
    error: 'Timed out while waiting for Publer media job completion.',
    raw: {},
  }
  input.onUpdate(input.imageId, () => ({
    state: 'failed',
    jobId: input.jobId,
    error: timeoutSnapshot.error,
  }))
  return timeoutSnapshot
}

function isMediaFromUrlQueueLimitError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('please wait until your other download media from url jobs have finished') ||
    normalized.includes('download media from url jobs have finished')
  )
}

function extractPostIdsFromJobRaw(raw: Record<string, unknown>): string[] {
  const ids: string[] = []
  collectPostIds(raw, ids)
  return ids
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
  if (typeof value !== 'object') {
    return
  }

  const objectValue = value as Record<string, unknown>
  const postId =
    findFirstStringOrNumberInObject(objectValue, ['post_id', 'postId']) ??
    findFirstStringOrNumberInObject(objectValue, ['id'])
  const status = findFirstStringInObject(objectValue, ['status', 'state', 'result'])
  const error = findFirstErrorInObject(objectValue)

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

  Object.values(objectValue).forEach((nested) => {
    collectScheduleOutcomes(nested, outcomes)
  })
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
        if (typeof value === 'object' && value !== null) {
          const message = (value as Record<string, unknown>).message
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

function collectPostIds(value: unknown, output: string[]): void {
  if (!value) {
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectPostIds(item, output))
    return
  }

  if (typeof value !== 'object') {
    return
  }

  const objectValue = value as Record<string, unknown>
  for (const [key, currentValue] of Object.entries(objectValue)) {
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

function getCopyState(
  copyByImageId: Record<string, ImageCopyState>,
  imageId: string,
): ImageCopyState {
  return (
    copyByImageId[imageId] ?? {
      title: '',
      description: '',
      altText: '',
      keywordsUsed: [],
      perImageKeywordsInput: '',
      lockTitle: false,
    }
  )
}

function hasGeneratedCopy(copy: ImageCopyState | undefined): boolean {
  if (!copy) {
    return false
  }
  return copy.title.trim() !== '' && copy.description.trim() !== ''
}

function mergeCoverageState(
  previous: ArticleImageCoverage['state'] | undefined,
  next: ArticleImageCoverage['state'],
): ArticleImageCoverage['state'] {
  if (previous === 'scheduled') {
    return 'scheduled'
  }
  if (previous === 'failed' && next === 'pending') {
    return 'failed'
  }
  return next
}

function deriveCoverageStatus(
  totalImages: number,
  scheduledImages: number,
  failedImages: number,
  pendingImages: number,
): ArticleCoverageStatus {
  if (totalImages === 0) {
    return 'not_started'
  }
  if (scheduledImages === totalImages) {
    return 'fully_scheduled'
  }
  if (failedImages === totalImages) {
    return 'failed'
  }
  if (scheduledImages > 0) {
    return 'partially_scheduled'
  }
  if (pendingImages > 0) {
    return 'in_progress'
  }
  return 'not_started'
}

function formatCoverageStatus(status: ArticleCoverageStatus): string {
  switch (status) {
    case 'fully_scheduled':
      return 'Fully Scheduled'
    case 'partially_scheduled':
      return 'Partially Scheduled'
    case 'in_progress':
      return 'In Progress'
    case 'failed':
      return 'Failed'
    case 'not_started':
    default:
      return 'Not Started'
  }
}

function toCoverageStatusClass(status: ArticleCoverageStatus): string {
  switch (status) {
    case 'fully_scheduled':
      return 'scheduled'
    case 'partially_scheduled':
    case 'in_progress':
      return 'processing'
    case 'failed':
      return 'failed'
    case 'not_started':
    default:
      return 'idle'
  }
}

function sanitizeGeneratedCopy(row: PinCopy): {
  title: string
  description: string
  keywordsUsed: string[]
} {
  return {
    title: sanitizeCopyText(row.title, 100),
    description: sanitizeCopyText(row.description, 500),
    keywordsUsed: (row.keywords_used ?? [])
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword !== ''),
  }
}

const TITLE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'your',
  'into',
  'about',
  'are',
  'was',
  'were',
  'will',
  'have',
  'has',
  'had',
  'our',
  'you',
  'how',
  'why',
  'what',
  'when',
  'where',
  'which',
  'their',
  'them',
  'they',
  'its',
  'it',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'or',
  'as',
  'is',
  'be',
])

function enforceArticleReflectionOnTitle(title: string, postTitle: string): string {
  const cleanTitle = sanitizeCopyText(title, 100)
  const articleTokens = extractTitleTokens(postTitle)
  if (articleTokens.length === 0) {
    return cleanTitle
  }

  const titleTokens = new Set(extractTitleTokens(cleanTitle))
  const hasOverlap = articleTokens.some((token) => titleTokens.has(token))
  if (hasOverlap) {
    return cleanTitle
  }

  const cue = buildArticleCue(postTitle)
  if (cue === '') {
    return cleanTitle
  }

  return sanitizeCopyText(`${cue}: ${cleanTitle}`, 100)
}

function buildArticleCue(postTitle: string): string {
  const tokens = extractTitleTokens(postTitle)
  if (tokens.length === 0) {
    return sanitizeCopyText(postTitle, 35)
  }

  const cueTokens = tokens.slice(0, 3)
  return cueTokens.map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(' ')
}

function extractTitleTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TITLE_STOPWORDS.has(token))
}

function sanitizeCopyText(value: string, maxLength: number): string {
  const withoutHashtags = value.replace(/(^|\s)#\w+/g, ' ')
  const normalizedSpace = withoutHashtags.replace(/\s+/g, ' ').trim()
  return normalizedSpace.slice(0, maxLength)
}

function parseKeywordsInput(value: string): string[] {
  const parts = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return [...new Set(parts)]
}

function appendError(existing: string[], reason: string): string[] {
  const normalized = reason.trim()
  if (normalized === '') {
    return existing
  }
  if (existing.includes(normalized)) {
    return existing
  }
  return [...existing, normalized]
}

function csvEscape(value: string): string {
  const normalized = value.replace(/\r?\n/g, ' ').trim()
  const escaped = normalized.replace(/"/g, '""')
  return `"${escaped}"`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function trimText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength - 3)}...`
}

function getDefaultStartAtLocal(): string {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return formatDateTimeLocalInput(date)
}

function formatDateTimeLocalInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function formatDateTime(isoDate: string): string {
  const value = new Date(isoDate)
  if (Number.isNaN(value.getTime())) {
    return isoDate
  }
  return value.toLocaleString()
}

function clampInt(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return min
  }
  return Math.max(min, Math.min(max, parsed))
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), milliseconds)
  })
}

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return hash
}

function getAiProviderLabel(provider: AIProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'gemini':
      return 'Gemini'
    case 'openrouter':
      return 'OpenRouter'
    case 'custom_endpoint':
    default:
      return 'Custom endpoint'
  }
}

function getAiConfigurationError(settings: SettingsState): string | null {
  if (settings.aiProvider === 'custom_endpoint') {
    if (settings.aiCustomEndpoint.trim() === '') {
      return 'Set custom AI endpoint before generating copy.'
    }
    return null
  }

  if (settings.aiApiKey.trim() === '') {
    return `Set ${getAiProviderLabel(settings.aiProvider)} API key before generating copy.`
  }
  if (settings.aiModel.trim() === '') {
    return `Set ${getAiProviderLabel(settings.aiProvider)} model before generating copy.`
  }
  return null
}
