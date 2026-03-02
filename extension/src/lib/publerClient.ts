const PUBLER_BASE_URL = 'https://app.publer.com/api/v1'

export interface PublerClientConfig {
  apiKey: string
  workspaceId: string
}

export interface PublerWorkspace {
  id: string
  name: string
}

export interface PublerAccount {
  id: number | string
  provider: string
  name?: string
}

export interface PublerMediaAlbum {
  id: string
  name: string
}

export interface PublerMediaOptions {
  account_id: string | number
  albums?: PublerMediaAlbum[]
}

export interface PinterestBoard {
  accountId: string
  id: string
  name: string
}

export interface PublerMediaUploadOptions {
  inLibrary?: boolean
  directUpload?: boolean
  name?: string
  caption?: string
  source?: string
}

export interface PublerJobStatusSnapshot {
  state: 'queued' | 'processing' | 'completed' | 'failed'
  mediaId?: string
  error?: string
  raw: Record<string, unknown>
}

export interface PublerScheduleRequest {
  bulk: {
    state: 'scheduled'
    posts: Array<Record<string, unknown>>
  }
}

export class PublerClient {
  private readonly apiKey: string
  private readonly workspaceId: string

  constructor(config: PublerClientConfig) {
    this.apiKey = config.apiKey.trim()
    this.workspaceId = config.workspaceId.trim()
  }

  async getAccounts(): Promise<PublerAccount[]> {
    const payload = await this.request<unknown>('/accounts')
    return this.extractArray(payload).map((item) => ({
      id: this.pickStringOrNumber(item, ['id', 'account_id']) ?? '',
      provider: String(this.pickStringOrNumber(item, ['provider']) ?? ''),
      name: String(this.pickStringOrNumber(item, ['name', 'username']) ?? 'Untitled account'),
    }))
  }

  async getWorkspaces(): Promise<PublerWorkspace[]> {
    const payload = await this.request<unknown>('/workspaces')
    return this.extractArray(payload)
      .map((item) => ({
        id: String(this.pickStringOrNumber(item, ['id', 'workspace_id', 'workspaceId']) ?? ''),
        name: String(this.pickStringOrNumber(item, ['name', 'title']) ?? 'Untitled workspace'),
      }))
      .filter((workspace) => workspace.id.trim() !== '')
  }

  async getPinterestAccounts(): Promise<PublerAccount[]> {
    const accounts = await this.getAccounts()
    return accounts.filter((account) => account.provider === 'pinterest')
  }

  async getMediaOptions(accountIds: Array<number | string>): Promise<PublerMediaOptions[]> {
    const query = accountIds
      .map((accountId) => `accounts[]=${encodeURIComponent(String(accountId))}`)
      .join('&')

    const payload = await this.request<unknown>(
      `/workspaces/${encodeURIComponent(this.workspaceId)}/media_options?${query}`,
    )
    return this.extractArray(payload).map((item) => ({
      account_id: this.pickStringOrNumber(item, ['account_id', 'accountId']) ?? '',
      albums: this.extractArray((item as Record<string, unknown>).albums).map((album) => ({
        id: String(this.pickStringOrNumber(album, ['id']) ?? ''),
        name: String(this.pickStringOrNumber(album, ['name']) ?? 'Untitled board'),
      })),
    }))
  }

  async getPinterestBoards(accountId: number | string): Promise<PinterestBoard[]> {
    const mediaOptions = await this.getMediaOptions([accountId])

    return mediaOptions.flatMap((option) =>
      (option.albums ?? [])
        .filter((album) => album.id && album.name)
        .map((album) => ({
          accountId: String(option.account_id),
          id: String(album.id),
          name: album.name,
        })),
    )
  }

  async getJobStatus(jobId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/job_status/${encodeURIComponent(jobId)}`)
  }

  async uploadMediaFromUrl(
    imageUrl: string,
    options?: PublerMediaUploadOptions,
  ): Promise<{ jobId: string }> {
    const mediaEntry: Record<string, unknown> = {
      url: imageUrl,
    }
    if (options?.name && options.name.trim() !== '') {
      mediaEntry.name = options.name.trim()
    }
    if (options?.caption && options.caption.trim() !== '') {
      mediaEntry.caption = options.caption.trim()
    }
    if (options?.source && options.source.trim() !== '') {
      mediaEntry.source = options.source.trim()
    }

    const payload = await this.request<unknown>('/media/from-url', {
      method: 'POST',
      body: JSON.stringify({
        media: [mediaEntry],
        type: 'single',
        in_library: options?.inLibrary ?? true,
        direct_upload: options?.directUpload ?? false,
      }),
    })

    const objectPayload = this.isObject(payload) ? payload : {}
    const jobId = this.findFirstStringOrNumber(objectPayload, ['job_id', 'jobId', 'id'])
    if (!jobId) {
      throw new Error('Publer media upload did not return a job_id.')
    }

    return { jobId: String(jobId) }
  }

  async getJobStatusSnapshot(jobId: string): Promise<PublerJobStatusSnapshot> {
    const raw = await this.getJobStatus(jobId)
    return this.toJobStatusSnapshot(raw)
  }

  async schedulePosts(payload: PublerScheduleRequest): Promise<{ jobId: string }> {
    const response = await this.request<unknown>('/posts/schedule', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    const objectPayload = this.isObject(response) ? response : {}
    const jobId = this.findFirstStringOrNumber(objectPayload, ['job_id', 'jobId', 'id'])
    if (!jobId) {
      throw new Error('Publer schedule request did not return a job_id.')
    }

    return { jobId: String(jobId) }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    headers.set('Content-Type', 'application/json')
    headers.set('Authorization', `Bearer-API ${this.apiKey}`)
    if (this.workspaceId) {
      headers.set('Publer-Workspace-Id', this.workspaceId)
    }

    const response = await fetch(`${PUBLER_BASE_URL}${path}`, {
      ...init,
      headers,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `Publer API request failed (${response.status} ${response.statusText}): ${errorText}`,
      )
    }

    return (await response.json()) as T
  }

  private extractArray(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => this.isObject(item))
    }

    if (!this.isObject(value)) {
      return []
    }

    const keys = ['data', 'results', 'items']
    for (const key of keys) {
      const candidate = value[key]
      if (Array.isArray(candidate)) {
        return candidate.filter(
          (item): item is Record<string, unknown> => this.isObject(item),
        )
      }
    }

    return []
  }

  private pickStringOrNumber(
    source: Record<string, unknown>,
    keys: string[],
  ): string | number | undefined {
    for (const key of keys) {
      const value = source[key]
      if (typeof value === 'string' || typeof value === 'number') {
        return value
      }
    }
    return undefined
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  private toJobStatusSnapshot(raw: Record<string, unknown>): PublerJobStatusSnapshot {
    const statusValue = this.findFirstString(raw, ['status', 'state', 'job_status']) ?? ''
    const lowerStatus = statusValue.toLowerCase()
    const mediaId = this.findFirstStringOrNumber(raw, ['media_id', 'mediaId', 'id'])
    const errorValue =
      this.findFirstString(raw, ['error', 'message', 'reason', 'details']) ?? undefined

    if (this.matchesAny(lowerStatus, ['fail', 'error', 'rejected', 'cancel'])) {
      return { state: 'failed', error: errorValue ?? 'Job failed.', raw }
    }

    if (this.matchesAny(lowerStatus, ['complete', 'done', 'success'])) {
      return {
        state: 'completed',
        mediaId: mediaId ? String(mediaId) : undefined,
        raw,
      }
    }

    if (this.matchesAny(lowerStatus, ['queue', 'pending', 'wait'])) {
      return { state: 'queued', raw }
    }

    return { state: 'processing', raw }
  }

  private findFirstString(
    value: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const direct = value[key]
      if (typeof direct === 'string' && direct.trim() !== '') {
        return direct
      }
    }

    for (const candidate of Object.values(value)) {
      if (this.isObject(candidate)) {
        const nested = this.findFirstString(candidate, keys)
        if (nested) {
          return nested
        }
      }
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          if (this.isObject(item)) {
            const nested = this.findFirstString(item, keys)
            if (nested) {
              return nested
            }
          }
        }
      }
    }

    return undefined
  }

  private findFirstStringOrNumber(
    value: Record<string, unknown>,
    keys: string[],
  ): string | number | undefined {
    for (const key of keys) {
      const direct = value[key]
      if (
        (typeof direct === 'string' && direct.trim() !== '') ||
        typeof direct === 'number'
      ) {
        return direct
      }
    }

    for (const candidate of Object.values(value)) {
      if (this.isObject(candidate)) {
        const nested = this.findFirstStringOrNumber(candidate, keys)
        if (nested !== undefined) {
          return nested
        }
      }
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          if (this.isObject(item)) {
            const nested = this.findFirstStringOrNumber(item, keys)
            if (nested !== undefined) {
              return nested
            }
          }
        }
      }
    }

    return undefined
  }

  private matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some((pattern) => value.includes(pattern))
  }
}
