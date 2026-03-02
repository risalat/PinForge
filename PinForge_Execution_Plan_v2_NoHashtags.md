# Execution Plan — Build PinForge with Codex (Chrome Extension + optional backend)

## 0) Tech Stack Choices
### MVP (Extension-only)
- Chrome Extension Manifest V3
- UI: React + Vite (or plain TS/HTML for speed)
- Storage: `chrome.storage.local` (jobs, settings, cache)
- Background: MV3 service worker + `chrome.alarms` for polling jobs
- Networking: `fetch` to Publer API (`https://app.publer.com/api/v1/`)

### Recommended upgrade (Small backend)
- Cloudflare Worker or Vercel Serverless
- Backend holds Publer + AI keys
- Optional: backend fetches images and direct-uploads to Publer for maximum reliability (Publer supports direct uploads to `/media`).

## 1) Milestones (ship MVP fast)

### Milestone 1 — Publer connectivity (Accounts + Boards)
**Tasks**
- Settings screen: save `Publer API Key`, `Workspace ID`
- Implement:
  - `GET /accounts` and filter `provider: pinterest`
  - `GET /workspaces/{workspace_id}/media_options?...` and list Pinterest boards
- Add “Test Connection” button (shows Pinterest accounts + board count)

**Done when**
- User can select Pinterest account and boards in the UI.

### Milestone 2 — WP scraper + image list
**Tasks**
- “Use current tab” → run content script to extract:
  - post title
  - canonical URL
  - headings map (H2/H3)
  - image list + per-image context
- Build image grid UI with:
  - thumbnails
  - checkbox select
  - show detected heading/caption/alt

**Done when**
- User sees a clean list of eligible images and can select/deselect.

### Milestone 3 — Scheduling engine + board distribution
**Tasks**
- Inputs:
  - start date/time
  - gapDays (custom integer)
  - jitterDays (0..X)
  - primary board + share %
- Implement:
  - weighted round-robin board sequence
  - schedule generator (monotonic, jitter)
- Preview table: board + scheduled time per selected image

**Done when**
- Preview matches expected spacing and board weighting.

### Milestone 4 — AI generation (titles first, then descriptions)
**Tasks**
- Implement AI provider wrapper (OpenAI or Gemini)
- Define strict JSON schema output:
  - title, description, alt_text, keywords_used
- UI:
  - keyword input (global + per-image)
  - “Generate copy” button
  - inline editing + lock

**Done when**
- User can generate unique copy for N images and edit before scheduling.

### Milestone 5 — Media caching in Publer (reliability mode)
**Tasks**
- Implement `POST /media/from-url` with `in_library=true` and `direct_upload` option toggle
- Poll `GET /job_status/{job_id}` until completed
- Cache mapping `sourceImageUrl → publerMediaId` in local storage
- Show progress bar + per-image status

**Done when**
- All selected images have Publer media IDs (or clear failure reasons).

### Milestone 6 — Bulk schedule pins
**Tasks**
- Build bulk payload for `POST /posts/schedule` (up to 500)
- Pinterest format:
  - `networks.pinterest.type="photo"`
  - `title`, `text`, `url`
  - `accounts[].album_id` board required
  - attach Publer media IDs
- Submit and poll schedule job status until complete
- Save scheduled post IDs (if returned) for audit

**Done when**
- Pins appear in Publer calendar on expected boards/dates.

### Milestone 7 — Robust job monitoring + resume
**Tasks**
- Persist all jobs and states in storage
- Use `chrome.alarms` to poll every X seconds/minutes while jobs pending
- On extension open: resume polling any pending jobs
- Export report: CSV of image → title → board → scheduled_at → status

**Done when**
- Closing/reopening Chrome doesn’t lose state; user can see completion results.

## 2) File/Folder Structure (suggested)
- `extension/`
  - `manifest.json`
  - `src/background/` (service worker, alarms, polling)
  - `src/content/` (scraper)
  - `src/ui/` (popup + pages)
  - `src/lib/`
    - `publerClient.ts` (accounts, media_options, media upload, posts schedule, job status)
    - `scheduler.ts` (gap/jitter)
    - `boardAllocator.ts` (weighted round robin)
    - `aiClient.ts` (provider wrapper)
    - `validators.ts` (schema + limits)
  - `src/storage/` (job repo, caches)
- `backend/` (optional)
  - `api/generate-copy`
  - `api/upload-media`
  - `api/schedule`

## 3) Codex Implementation Notes (how to drive the agent)
Give Codex these constraints:
- “No UI bloat: single-page wizard: **Select Images → Boards → Schedule → Copy → Upload+Schedule → Results**”
- “Never schedule without previewing the generated `scheduled_at` list”
- “Every Publer request must include both headers (Authorization + Workspace)”
- “Use async job polling for `/media/from-url` and `/posts/schedule`”
- “Stop if any step returns 401/403 and surface actionable error”

## 4) QA Checklist (practical)
- Works on WP classic editor posts + Gutenberg
- Handles lazy-loaded images (`data-src`, `data-lazy-src`)
- Dedupe avoids double-scheduling
- Titles/descriptions stay within Pinterest constraints (desc ≤ 500 chars)
- Board weighting matches slider
- Schedules are monotonic and roughly spaced by gap ± jitter

## 5) Launch Checklist
- Store versioned settings per workspace
- Provide “Dry Run” mode (build payload but don’t send)
- Provide “Re-run failed only” action
- Backup/export job report to CSV/JSON

## 6) References (Publer API docs)
- API intro/base URL: https://publer.com/docs/api-reference/introduction
- Bulk scheduling: https://publer.com/docs/posting/create-posts/publishing-methods/bulk-scheduling
- Pinterest pin format: https://publer.com/docs/posting/create-posts/content-types/platform-specific-formats/pinterest-pins-with-a-link-url
- Media handling + job status: https://publer.com/docs/posting/create-posts/media-handling
- Creating posts (async jobs): https://publer.com/docs/posting/create-posts
