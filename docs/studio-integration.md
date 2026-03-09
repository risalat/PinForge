# PinForge Studio Integration

## Settings

Studio configuration lives in the extension popup `Settings` tab alongside the existing Publer and AI settings.

New saved settings:

- `studioBaseUrl`
- `studioApiKey`

Default Studio base URL:

- `https://pin-forge-studio.vercel.app`

The Studio API key is stored in the same Chrome local settings object already used by the extension. The UI masks the key input and shows only a masked preview.

## Auth

All Studio requests use:

```http
Authorization: Bearer <api_key>
```

The popup sends requests to the user-configured Studio base URL and normalizes trailing slashes before calling the backend.

## Studio Tab

The popup now includes a separate `Studio` tab. This tab:

- reuses the existing scraper output from the current article page
- reuses the same image selection model already used by the Publer workflow
- lets the user review the article title, URL, domain, keywords, and selected images
- sends selected image/article context to Studio without changing the Publer scheduling flow

The existing `Run` tab remains the Publer scheduling workflow and is not routed through Studio.

## Generate Payload

The Studio generate request is built from the existing scraper context using this shape:

```json
{
  "postUrl": "https://example.com/post",
  "title": "Example article title",
  "domain": "example.com",
  "keywords": ["keyword one", "keyword two"],
  "images": [
    {
      "url": "https://example.com/image.jpg",
      "alt": "Image alt",
      "caption": "Figure caption",
      "nearestHeading": "Section heading",
      "sectionHeadingPath": ["Parent heading", "Child heading"],
      "surroundingTextSnippet": "Nearby article text"
    }
  ]
}
```

## Temp Upload Fallback

Studio uses two endpoints:

- `POST /api/generate`
- `POST /api/uploads/temp`

Image handling rules:

- If an image source is a normal `http` or `https` URL, that URL is sent directly in the generate payload.
- If an image source is `blob:`, `data:`, or another non-HTTP source, the extension asks the content script to resolve the image data, uploads it to `POST /api/uploads/temp`, and then uses the returned Studio asset URL/reference in the final generate payload.

This fallback is isolated to the Studio workflow only. Publer media upload and scheduling behavior remain unchanged.
