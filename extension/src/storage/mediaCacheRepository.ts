const MEDIA_CACHE_KEY = 'pinforge.mediaCache'

type MediaCacheByWorkspace = Record<string, Record<string, string>>

function getStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Chrome storage is unavailable in this context.')
  }

  return chrome.storage.local
}

async function loadAllCaches(): Promise<MediaCacheByWorkspace> {
  const storage = getStorageArea()
  const data = await storage.get(MEDIA_CACHE_KEY)
  const value = data[MEDIA_CACHE_KEY]
  if (!value || typeof value !== 'object') {
    return {}
  }

  return value as MediaCacheByWorkspace
}

async function saveAllCaches(value: MediaCacheByWorkspace): Promise<void> {
  const storage = getStorageArea()
  await storage.set({ [MEDIA_CACHE_KEY]: value })
}

export async function loadWorkspaceMediaCache(
  workspaceId: string,
): Promise<Record<string, string>> {
  const allCaches = await loadAllCaches()
  return allCaches[workspaceId] ?? {}
}

export async function getCachedMediaId(
  workspaceId: string,
  sourceImageUrl: string,
): Promise<string | undefined> {
  const workspaceCache = await loadWorkspaceMediaCache(workspaceId)
  const mediaId = workspaceCache[sourceImageUrl]
  if (!mediaId || mediaId.trim() === '') {
    return undefined
  }
  return mediaId
}

export async function cacheMediaId(
  workspaceId: string,
  sourceImageUrl: string,
  mediaId: string,
): Promise<void> {
  const allCaches = await loadAllCaches()
  const workspaceCache = allCaches[workspaceId] ?? {}
  allCaches[workspaceId] = {
    ...workspaceCache,
    [sourceImageUrl]: mediaId,
  }
  await saveAllCaches(allCaches)
}
