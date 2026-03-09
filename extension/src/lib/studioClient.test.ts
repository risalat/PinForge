import { describe, expect, it } from 'vitest'
import { extractStudioAssetUrl, normalizeStudioBaseUrl } from './studioClient'

describe('normalizeStudioBaseUrl', () => {
  it('removes trailing slashes and query fragments', () => {
    expect(
      normalizeStudioBaseUrl('https://pin-forge-studio.vercel.app///?preview=1#section'),
    ).toBe('https://pin-forge-studio.vercel.app')
  })

  it('returns empty string when base url is blank', () => {
    expect(normalizeStudioBaseUrl('   ')).toBe('')
  })
})

describe('extractStudioAssetUrl', () => {
  it('reads nested asset URLs from upload responses', () => {
    expect(
      extractStudioAssetUrl({
        success: true,
        data: {
          asset: {
            url: 'https://pin-forge-studio.vercel.app/uploads/temp/example.png',
          },
        },
      }),
    ).toBe('https://pin-forge-studio.vercel.app/uploads/temp/example.png')
  })

  it('returns null when no asset URL is present', () => {
    expect(extractStudioAssetUrl({ ok: true, data: {} })).toBeNull()
  })
})
