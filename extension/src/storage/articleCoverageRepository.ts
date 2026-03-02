export type ArticleCoverageStatus =
  | 'not_started'
  | 'in_progress'
  | 'partially_scheduled'
  | 'fully_scheduled'
  | 'failed'

export type ArticleImageCoverageState = 'pending' | 'scheduled' | 'failed'

export interface ArticleImageCoverage {
  imageUrl: string
  imageFingerprint: string
  state: ArticleImageCoverageState
  scheduledPostId?: string
  boardId?: string
  scheduledAt?: string
  lastError?: string
  updatedAt: string
}

export interface ArticleCoverageRecord {
  workspaceId: string
  canonicalUrl: string
  sourceTitle: string
  status: ArticleCoverageStatus
  totalImages: number
  scheduledImages: number
  failedImages: number
  pendingImages: number
  coveragePercent: number
  runJobIds: string[]
  images: ArticleImageCoverage[]
  createdAt: string
  updatedAt: string
}

const ARTICLE_COVERAGE_KEY = 'pinforge.articleCoverage'

function getStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Chrome storage is unavailable in this context.')
  }

  return chrome.storage.local
}

export function normalizeArticleUrl(url: string): string {
  const raw = url.trim()
  if (raw === '') {
    return ''
  }

  try {
    const parsed = new URL(raw)
    parsed.hash = ''
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1)
    }
    return parsed.toString()
  } catch {
    return raw
  }
}

export function buildImageFingerprint(imageUrl: string): string {
  const raw = imageUrl.trim()
  if (raw === '') {
    return ''
  }

  try {
    const parsed = new URL(raw)
    parsed.hash = ''
    parsed.search = ''
    return `${parsed.host.toLowerCase()}${parsed.pathname}`
  } catch {
    return raw
  }
}

function buildCoverageKey(workspaceId: string, canonicalUrl: string): string {
  return `${workspaceId.trim()}::${normalizeArticleUrl(canonicalUrl)}`
}

type CoverageRegistry = Record<string, ArticleCoverageRecord>

export async function loadCoverageRegistry(): Promise<CoverageRegistry> {
  const storage = getStorageArea()
  const data = await storage.get(ARTICLE_COVERAGE_KEY)
  const value = data[ARTICLE_COVERAGE_KEY]
  if (!value || typeof value !== 'object') {
    return {}
  }

  return value as CoverageRegistry
}

export async function saveCoverageRegistry(registry: CoverageRegistry): Promise<void> {
  const storage = getStorageArea()
  await storage.set({ [ARTICLE_COVERAGE_KEY]: registry })
}

export async function getArticleCoverageRecord(
  workspaceId: string,
  canonicalUrl: string,
): Promise<ArticleCoverageRecord | undefined> {
  const registry = await loadCoverageRegistry()
  return registry[buildCoverageKey(workspaceId, canonicalUrl)]
}

export async function upsertArticleCoverageRecord(
  record: ArticleCoverageRecord,
): Promise<void> {
  const registry = await loadCoverageRegistry()
  registry[buildCoverageKey(record.workspaceId, record.canonicalUrl)] = record
  await saveCoverageRegistry(registry)
}

export async function listArticleCoverageRecords(
  workspaceId?: string,
): Promise<ArticleCoverageRecord[]> {
  const registry = await loadCoverageRegistry()
  const entries = Object.values(registry)
  const filtered = workspaceId
    ? entries.filter((entry) => entry.workspaceId === workspaceId)
    : entries

  return filtered
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

