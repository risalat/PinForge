import { validatePinCopyBatch, type PinCopy } from './validators'

export type AIProvider = 'custom_endpoint' | 'openai' | 'gemini' | 'openrouter'
export type TitleStyle = 'balanced' | 'seo' | 'curiosity' | 'benefit'

export interface AIProviderConfig {
  provider: AIProvider
  apiKey?: string
  model?: string
  customEndpoint?: string
}

export interface ImageContextInput {
  image_url: string
  alt?: string
  caption?: string
  nearest_heading?: string
  section_heading_path?: string[]
  surrounding_text_snippet?: string
  preferred_keywords?: string[]
}

export interface GenerateCopyRequest {
  post_title: string
  destination_url: string
  global_keywords?: string[]
  force_keywords?: boolean
  title_style?: TitleStyle
  images: ImageContextInput[]
  generation_mode?: 'full' | 'titles' | 'descriptions'
  existing_titles?: string[]
}

const OPENAI_BASE_URL = 'https://api.openai.com'
const OPENROUTER_BASE_URL = 'https://openrouter.ai'
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

export class AIClient {
  private readonly config: AIProviderConfig

  constructor(config?: AIProviderConfig) {
    this.config = {
      provider: config?.provider ?? 'custom_endpoint',
      apiKey: config?.apiKey ?? '',
      model: config?.model ?? '',
      customEndpoint: config?.customEndpoint ?? import.meta.env.VITE_COPY_ENDPOINT ?? '',
    }
  }

  static async listModels(config: AIProviderConfig): Promise<string[]> {
    const client = new AIClient(config)
    return client.listModels()
  }

  async listModels(): Promise<string[]> {
    switch (this.config.provider) {
      case 'openai':
        return this.listOpenAIModels()
      case 'openrouter':
        return this.listOpenRouterModels()
      case 'gemini':
        return this.listGeminiModels()
      case 'custom_endpoint':
      default:
        return []
    }
  }

  async generateCopy(payload: GenerateCopyRequest): Promise<PinCopy[]> {
    if (payload.images.length === 0) {
      throw new Error('No images provided for AI copy generation.')
    }

    switch (this.config.provider) {
      case 'openai':
        return this.generateViaOpenAI(payload)
      case 'openrouter':
        return this.generateViaOpenRouter(payload)
      case 'gemini':
        return this.generateViaGemini(payload)
      case 'custom_endpoint':
      default:
        return this.generateViaCustomEndpoint(payload)
    }
  }

  async generateTitles(payload: GenerateCopyRequest): Promise<PinCopy[]> {
    return this.generateCopy({
      ...payload,
      generation_mode: 'titles',
    })
  }

  async generateDescriptions(
    payload: GenerateCopyRequest,
    titles: string[],
  ): Promise<PinCopy[]> {
    if (titles.length !== payload.images.length) {
      throw new Error(
        `Description generation requires ${payload.images.length} titles, received ${titles.length}.`,
      )
    }

    return this.generateCopy({
      ...payload,
      generation_mode: 'descriptions',
      existing_titles: titles,
    })
  }

  private async generateViaCustomEndpoint(payload: GenerateCopyRequest): Promise<PinCopy[]> {
    const endpoint = this.config.customEndpoint?.trim() ?? ''
    if (!endpoint) {
      throw new Error(
        'AI endpoint is not configured. Set VITE_COPY_ENDPOINT or provide custom endpoint.',
      )
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `AI copy generation failed (${response.status} ${response.statusText}): ${text}`,
      )
    }

    const data = (await response.json()) as unknown
    return validatePinCopyBatch(this.extractCandidateArray(data))
  }

  private async generateViaOpenAI(payload: GenerateCopyRequest): Promise<PinCopy[]> {
    const apiKey = this.requireApiKey('OpenAI')
    const model = this.requireModel('OpenAI')

    const response = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: this.buildMessages(payload),
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `OpenAI copy generation failed (${response.status} ${response.statusText}): ${text}`,
      )
    }

    const json = (await response.json()) as Record<string, unknown>
    const content = this.extractChatContent(json)
    const parsed = this.parseJsonText(content)
    return validatePinCopyBatch(this.extractCandidateArray(parsed))
  }

  private async generateViaOpenRouter(payload: GenerateCopyRequest): Promise<PinCopy[]> {
    const apiKey = this.requireApiKey('OpenRouter')
    const model = this.requireModel('OpenRouter')

    const response = await fetch(`${OPENROUTER_BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: this.buildMessages(payload),
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `OpenRouter copy generation failed (${response.status} ${response.statusText}): ${text}`,
      )
    }

    const json = (await response.json()) as Record<string, unknown>
    const content = this.extractChatContent(json)
    const parsed = this.parseJsonText(content)
    return validatePinCopyBatch(this.extractCandidateArray(parsed))
  }

  private async generateViaGemini(payload: GenerateCopyRequest): Promise<PinCopy[]> {
    const apiKey = this.requireApiKey('Gemini')
    const model = this.normalizeGeminiModel(this.requireModel('Gemini'))

    const response = await fetch(
      `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: this.buildUserPrompt(payload) }],
            },
          ],
        }),
      },
    )

    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `Gemini copy generation failed (${response.status} ${response.statusText}): ${text}`,
      )
    }

    const json = (await response.json()) as Record<string, unknown>
    const content = this.extractGeminiContent(json)
    const parsed = this.parseJsonText(content)
    return validatePinCopyBatch(this.extractCandidateArray(parsed))
  }

  private async listOpenAIModels(): Promise<string[]> {
    const apiKey = this.requireApiKey('OpenAI')
    const response = await fetch(`${OPENAI_BASE_URL}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `OpenAI model list failed (${response.status} ${response.statusText}): ${text}`,
      )
    }

    const json = (await response.json()) as Record<string, unknown>
    return this.extractModelIds(json)
  }

  private async listOpenRouterModels(): Promise<string[]> {
    const apiKey = this.requireApiKey('OpenRouter')
    const response = await fetch(`${OPENROUTER_BASE_URL}/api/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `OpenRouter model list failed (${response.status} ${response.statusText}): ${text}`,
      )
    }

    const json = (await response.json()) as Record<string, unknown>
    return this.extractModelIds(json)
  }

  private async listGeminiModels(): Promise<string[]> {
    const apiKey = this.requireApiKey('Gemini')
    let nextPageToken = ''
    const models: string[] = []
    let safetyCounter = 0

    while (safetyCounter < 30) {
      safetyCounter += 1
      const query = new URLSearchParams({ key: apiKey })
      if (nextPageToken) {
        query.set('pageToken', nextPageToken)
      }

      const response = await fetch(`${GEMINI_BASE_URL}/v1beta/models?${query.toString()}`, {
        method: 'GET',
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(
          `Gemini model list failed (${response.status} ${response.statusText}): ${text}`,
        )
      }

      const json = (await response.json()) as Record<string, unknown>
      const entries = Array.isArray(json.models) ? json.models : []
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) {
          continue
        }
        const objectEntry = entry as Record<string, unknown>
        const supported = Array.isArray(objectEntry.supportedGenerationMethods)
          ? objectEntry.supportedGenerationMethods
          : []
        const supportsGenerateContent = supported.some(
          (value) => typeof value === 'string' && value === 'generateContent',
        )
        if (!supportsGenerateContent) {
          continue
        }

        const name = objectEntry.name
        if (typeof name === 'string' && name.trim() !== '') {
          models.push(this.normalizeGeminiModel(name))
        }
      }

      const token = json.nextPageToken
      if (typeof token === 'string' && token.trim() !== '') {
        nextPageToken = token
      } else {
        break
      }
    }

    return [...new Set(models)].sort((a, b) => a.localeCompare(b))
  }

  private buildMessages(payload: GenerateCopyRequest): Array<Record<string, string>> {
    return [
      {
        role: 'system',
        content:
          'You write Pinterest copy. Return valid JSON only. No markdown. No hashtags.',
      },
      { role: 'user', content: this.buildUserPrompt(payload) },
    ]
  }

  private buildUserPrompt(payload: GenerateCopyRequest): string {
    if (payload.generation_mode === 'titles') {
      return [
        'Step 1: Generate a concise, specific Pinterest title for each image using page and image context.',
        'Each title MUST clearly show it belongs to the same article while highlighting that image\'s specific angle.',
        'Title pattern guideline: [article context cue from post title] + [image-specific angle].',
        this.buildTitleStyleInstruction(payload.title_style ?? 'balanced'),
        'Use nearest heading/caption/surrounding text to create the angle. Avoid generic titles.',
        'Return JSON with this shape: {"pins":[{"title":"...","description":"...","keywords_used":["..."]}]}',
        'In this step, set description exactly to "pending description" for every item.',
        'Rules: title <= 100 chars, no hashtags, avoid repetitive wording across images.',
        `Post title: ${payload.post_title}`,
        `Destination URL: ${payload.destination_url}`,
        `Global keywords: ${(payload.global_keywords ?? []).join(', ') || 'none'}`,
        `Force keywords: ${payload.force_keywords ? 'yes' : 'no'}`,
        `Images payload (length=${payload.images.length}):`,
        JSON.stringify(payload.images, null, 2),
      ].join('\n')
    }

    if (payload.generation_mode === 'descriptions') {
      return [
        'Step 2: Generate Pinterest descriptions for the provided fixed titles.',
        'Return JSON with this shape: {"pins":[{"title":"...","description":"...","keywords_used":["..."]}]}',
        'Keep each title exactly as provided. Do not rewrite or shorten titles.',
        'Generate only description content that matches each title and image context.',
        'Rules: description <= 500 chars, no hashtags, clear and non-repetitive.',
        `Post title: ${payload.post_title}`,
        `Destination URL: ${payload.destination_url}`,
        `Global keywords: ${(payload.global_keywords ?? []).join(', ') || 'none'}`,
        `Force keywords: ${payload.force_keywords ? 'yes' : 'no'}`,
        `Existing titles (length=${(payload.existing_titles ?? []).length}):`,
        JSON.stringify(payload.existing_titles ?? [], null, 2),
        `Images payload (length=${payload.images.length}):`,
        JSON.stringify(payload.images, null, 2),
      ].join('\n')
    }

    return [
      'Generate unique Pinterest pin copy for each image.',
      'Return JSON with this shape: {"pins":[{"title":"...","description":"...","keywords_used":["..."]}]}',
      `Rules: title <= 100 chars, description <= 500 chars, no hashtags, non-repetitive.`,
      `Post title: ${payload.post_title}`,
      `Destination URL: ${payload.destination_url}`,
      `Global keywords: ${(payload.global_keywords ?? []).join(', ') || 'none'}`,
      `Force keywords: ${payload.force_keywords ? 'yes' : 'no'}`,
      `Images payload (length=${payload.images.length}):`,
      JSON.stringify(payload.images, null, 2),
    ].join('\n')
  }

  private buildTitleStyleInstruction(style: TitleStyle): string {
    switch (style) {
      case 'seo':
        return 'Style: SEO-focused. Front-load relevant topic terms; be clear and searchable, not clickbait.'
      case 'curiosity':
        return 'Style: Curiosity hook. Spark interest with a specific promise, while staying truthful and concrete.'
      case 'benefit':
        return 'Style: Benefit-led. Emphasize practical outcome/value the reader gets from this pin.'
      case 'balanced':
      default:
        return 'Style: Balanced. Mix context clarity, specificity, and a light engagement hook.'
    }
  }

  private extractCandidateArray(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value
    }

    if (typeof value !== 'object' || value === null) {
      return []
    }

    const objectValue = value as Record<string, unknown>
    const keys = ['pins', 'items', 'results', 'data', 'output']
    for (const key of keys) {
      if (Array.isArray(objectValue[key])) {
        return objectValue[key]
      }
    }

    return []
  }

  private extractChatContent(response: Record<string, unknown>): string {
    const choices = Array.isArray(response.choices) ? response.choices : []
    const first = choices[0]
    if (!first || typeof first !== 'object') {
      throw new Error('AI response did not include choices.')
    }

    const message = (first as Record<string, unknown>).message
    if (!message || typeof message !== 'object') {
      throw new Error('AI response did not include message content.')
    }

    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      const textPart = content.find(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).text === 'string',
      ) as Record<string, unknown> | undefined
      if (textPart && typeof textPart.text === 'string') {
        return textPart.text
      }
    }

    throw new Error('AI response content was empty.')
  }

  private extractGeminiContent(response: Record<string, unknown>): string {
    const candidates = Array.isArray(response.candidates) ? response.candidates : []
    const first = candidates[0]
    if (!first || typeof first !== 'object') {
      throw new Error('Gemini response did not include candidates.')
    }

    const content = (first as Record<string, unknown>).content
    if (!content || typeof content !== 'object') {
      throw new Error('Gemini response did not include content.')
    }

    const parts = Array.isArray((content as Record<string, unknown>).parts)
      ? ((content as Record<string, unknown>).parts as unknown[])
      : []
    const firstText = parts.find(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as Record<string, unknown>).text === 'string',
    ) as Record<string, unknown> | undefined

    if (!firstText || typeof firstText.text !== 'string') {
      throw new Error('Gemini response did not include text output.')
    }

    return firstText.text
  }

  private parseJsonText(text: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      const firstBrace = text.indexOf('{')
      const lastBrace = text.lastIndexOf('}')
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1))
      }

      const firstBracket = text.indexOf('[')
      const lastBracket = text.lastIndexOf(']')
      if (firstBracket >= 0 && lastBracket > firstBracket) {
        return JSON.parse(text.slice(firstBracket, lastBracket + 1))
      }
      throw new Error('Model response was not valid JSON.')
    }
  }

  private extractModelIds(response: Record<string, unknown>): string[] {
    const data = Array.isArray(response.data) ? response.data : []
    const ids = data
      .map((item) =>
        typeof item === 'object' && item !== null
          ? (item as Record<string, unknown>).id
          : undefined,
      )
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')

    return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
  }

  private normalizeGeminiModel(model: string): string {
    return model.replace(/^models\//, '')
  }

  private requireApiKey(label: string): string {
    const key = this.config.apiKey?.trim() ?? ''
    if (!key) {
      throw new Error(`${label} API key is required.`)
    }
    return key
  }

  private requireModel(label: string): string {
    const model = this.config.model?.trim() ?? ''
    if (!model) {
      throw new Error(`${label} model is required.`)
    }
    return model
  }
}
