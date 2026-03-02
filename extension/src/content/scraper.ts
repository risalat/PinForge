interface ScrapedImage {
  image_url: string
  alt: string
  caption: string
  nearest_heading: string
  section_heading_path: string[]
  surrounding_text_snippet: string
}

interface ScrapeResult {
  post_title: string
  canonical_url: string
  images: ScrapedImage[]
}

const MIN_DIMENSION = 350
const IGNORE_NAME_PATTERN = /(logo|icon|sprite)/i

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'PINFORGE_SCRAPE') {
    return false
  }

  try {
    const data = scrapePage()
    sendResponse({ ok: true, data })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    sendResponse({ ok: false, error: text })
  }

  return true
})

function scrapePage(): ScrapeResult {
  let images = [...document.querySelectorAll<HTMLImageElement>('article img, main img')]
  if (images.length === 0) {
    images = [...document.querySelectorAll<HTMLImageElement>('img')]
  }

  const dedupe = new Set<string>()
  const results: ScrapedImage[] = []

  for (const image of images) {
    if (shouldSkipImage(image)) {
      continue
    }

    const imageUrl = normalizeImageUrl(getImageSource(image))
    if (!imageUrl || dedupe.has(imageUrl)) {
      continue
    }
    dedupe.add(imageUrl)

    const headingContext = findHeadingContext(image)

    results.push({
      image_url: imageUrl,
      alt: image.alt?.trim() ?? '',
      caption: getCaption(image),
      nearest_heading: headingContext.nearest_heading,
      section_heading_path: headingContext.section_heading_path,
      surrounding_text_snippet: getSurroundingText(image),
    })
  }

  return {
    post_title: getPostTitle(),
    canonical_url: getCanonicalUrl(),
    images: results,
  }
}

function shouldSkipImage(image: HTMLImageElement): boolean {
  const source = getImageSource(image)
  const normalized = normalizeImageUrl(source)
  if (!normalized) {
    return true
  }

  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
    return true
  }

  return IGNORE_NAME_PATTERN.test(normalized)
}

function getImageSource(image: HTMLImageElement): string {
  return (
    image.currentSrc ||
    image.src ||
    image.getAttribute('data-src') ||
    image.getAttribute('data-lazy-src') ||
    image.getAttribute('data-original') ||
    ''
  )
}

function normalizeImageUrl(url: string): string {
  if (!url) {
    return ''
  }

  try {
    const value = new URL(url, window.location.href)
    value.search = ''
    value.hash = ''
    return value.toString()
  } catch {
    return ''
  }
}

function getPostTitle(): string {
  const h1 = document.querySelector('article h1, main h1, h1')
  if (h1?.textContent?.trim()) {
    return h1.textContent.trim()
  }
  return document.title
}

function getCanonicalUrl(): string {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  return canonical?.href || window.location.href
}

function getCaption(image: HTMLImageElement): string {
  const figure = image.closest('figure')
  const figcaption = figure?.querySelector('figcaption')
  if (figcaption?.textContent?.trim()) {
    return figcaption.textContent.trim()
  }

  const wpCaption = image.closest('.wp-caption')?.querySelector('.wp-caption-text')
  if (wpCaption?.textContent?.trim()) {
    return wpCaption.textContent.trim()
  }

  return ''
}

function findHeadingContext(image: HTMLImageElement): {
  nearest_heading: string
  section_heading_path: string[]
} {
  const container = image.closest('article, main') ?? document.body
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node === image) {
          return NodeFilter.FILTER_ACCEPT
        }
        if (node instanceof HTMLElement && (node.tagName === 'H2' || node.tagName === 'H3')) {
          return NodeFilter.FILTER_ACCEPT
        }
        return NodeFilter.FILTER_SKIP
      },
    },
  )

  let currentH2 = ''
  let currentH3 = ''
  let node = walker.nextNode()

  while (node) {
    if (node === image) {
      const sectionHeadingPath: string[] = []
      if (currentH2) {
        sectionHeadingPath.push(currentH2)
      }
      if (currentH3) {
        sectionHeadingPath.push(currentH3)
      }

      return {
        nearest_heading: currentH3 || currentH2,
        section_heading_path: sectionHeadingPath,
      }
    }

    if (node instanceof HTMLElement && node.tagName === 'H2') {
      currentH2 = node.textContent?.trim() ?? ''
      currentH3 = ''
    }

    if (node instanceof HTMLElement && node.tagName === 'H3') {
      currentH3 = node.textContent?.trim() ?? ''
    }

    node = walker.nextNode()
  }

  return { nearest_heading: '', section_heading_path: [] }
}

function getSurroundingText(image: HTMLImageElement): string {
  const paragraph =
    image.closest('p') ??
    image.parentElement?.querySelector('p') ??
    image.parentElement?.previousElementSibling

  return paragraph?.textContent?.trim().slice(0, 240) ?? ''
}
