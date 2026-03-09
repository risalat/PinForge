export interface StudioClientConfig {
  baseUrl: string
  apiKey: string
}

export interface StudioImagePayload {
  url: string
  alt?: string
  caption?: string
  nearestHeading?: string
  sectionHeadingPath?: string[]
  surroundingTextSnippet?: string
}

export interface StudioGeneratePayload {
  postUrl: string
  title: string
  domain?: string
  keywords?: string[]
  images: StudioImagePayload[]
}

export interface StudioTempUploadMetadata {
  sourceUrl?: string
  alt?: string
  caption?: string
  nearestHeading?: string
  sectionHeadingPath?: string[]
  surroundingTextSnippet?: string
  filename?: string
}

export interface StudioTempUploadResult {
  assetUrl: string
  raw: unknown
}

export function normalizeStudioBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (trimmed === '') {
    return ''
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Studio Base URL is invalid.')
  }

  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/+$/, '')
}

export class StudioClient {
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(config: StudioClientConfig) {
    this.baseUrl = normalizeStudioBaseUrl(config.baseUrl)
    this.apiKey = config.apiKey.trim()
  }

  async generatePins(payload: StudioGeneratePayload): Promise<unknown> {
    this.assertConfigured()
    return this.requestJson('/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  }

  async uploadTempImage(
    file: File,
    metadata: StudioTempUploadMetadata = {},
  ): Promise<StudioTempUploadResult> {
    this.assertConfigured()

    const form = new FormData()
    form.append('file', file, metadata.filename?.trim() || file.name || 'pinforge-image')

    Object.entries(metadata).forEach(([key, value]) => {
      if (key === 'filename' || value === undefined || value === null) {
        return
      }

      if (Array.isArray(value)) {
        form.append(key, JSON.stringify(value))
        return
      }

      const text = String(value).trim()
      if (text !== '') {
        form.append(key, text)
      }
    })

    const raw = await this.requestJson('/api/uploads/temp', {
      method: 'POST',
      body: form,
    })
    const assetUrl = extractStudioAssetUrl(raw)
    if (!assetUrl) {
      throw new Error('Studio temp upload succeeded but no asset URL/reference was returned.')
    }

    return { assetUrl, raw }
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.apiKey}`)

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    })

    const payload = await parseResponsePayload(response)
    if (!response.ok) {
      throw new Error(
        `Studio request failed (${response.status} ${response.statusText}): ${extractErrorMessage(payload)}`,
      )
    }

    return payload
  }

  private assertConfigured(): void {
    if (this.baseUrl === '') {
      throw new Error('Studio Base URL is required.')
    }
    if (this.apiKey === '') {
      throw new Error('Studio API key is required.')
    }
  }
}

export async function generatePins(
  config: StudioClientConfig,
  payload: StudioGeneratePayload,
): Promise<unknown> {
  return new StudioClient(config).generatePins(payload)
}

export async function uploadTempImage(
  config: StudioClientConfig,
  file: File,
  metadata: StudioTempUploadMetadata = {},
): Promise<StudioTempUploadResult> {
  return new StudioClient(config).uploadTempImage(file, metadata)
}

export function extractStudioAssetUrl(payload: unknown): string | null {
  return findFirstStringByKeys(payload, [
    'assetUrl',
    'asset_url',
    'url',
    'publicUrl',
    'public_url',
    'fileUrl',
    'file_url',
    'location',
    'src',
  ])
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.trim() === '') {
    return {}
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return JSON.parse(text) as unknown
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function extractErrorMessage(payload: unknown): string {
  const directText = extractStringPayload(payload)
  if (directText) {
    return directText
  }

  const nestedText = findFirstStringByKeys(payload, [
    'error',
    'message',
    'detail',
    'details',
    'reason',
  ])
  return nestedText ?? 'Unknown Studio error.'
}

function extractStringPayload(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.trim() !== '') {
    return payload.trim()
  }
  return null
}

function findFirstStringByKeys(payload: unknown, keys: string[]): string | null {
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    return trimmed === '' ? null : trimmed
  }

  if (!isObject(payload)) {
    return null
  }

  for (const key of keys) {
    const directValue = payload[key]
    if (typeof directValue === 'string' && directValue.trim() !== '') {
      return directValue.trim()
    }
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = findFirstStringByKeys(item, keys)
        if (nested) {
          return nested
        }
      }
      continue
    }

    if (isObject(value)) {
      const nested = findFirstStringByKeys(value, keys)
      if (nested) {
        return nested
      }
    }
  }

  return null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
