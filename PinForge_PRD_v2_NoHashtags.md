# PRD — PinForge (Chrome Extension)  
Automated Pinterest Pin generation + Publer bulk scheduling from WordPress posts

## 1) Summary
You manage multiple WordPress sites. A single post may contain 10–45+ images, but you currently “Pin it” image-by-image and each pin ends up with the same (repetitive) title/description. This project builds a **Chrome extension** that, given a post URL (or the current tab), will:

1. Extract the post’s images + nearby context (H2/H3, caption, alt, etc.)
2. Generate **unique, relevant Pin titles + descriptions per image** using AI, optionally guided by your own keyword lists
3. Upload/copy images into Publer’s Media Library for reliability
4. Bulk schedule pins to Pinterest via Publer API with:
   - customizable **gap days** (e.g., 7/15/30/45/etc.)
   - optional **jitter** (e.g., ±2–4 days) for natural spacing
   - **multi-board distribution** with a **Primary board weight** (e.g., 60% primary + remaining across others)
5. Track Publer acceptance and processing using Publer’s async **job status** endpoint

**Goal UX:** per post, configure → generate → schedule in **5–10 minutes** with minimal clicks.

## 2) Goals & Success Metrics
### Goals
- **One post → many pins**: create N pins (N = selected images) from a single URL.
- **Unique pin copy**: each pin has a distinct title + description derived from image context + post title.
- **Custom scheduling**: user-defined gap days; multi-year schedules supported.
- **Board strategy**: primary board bias + round-robin to secondary boards.
- **Reliability**: prefer Publer media IDs (cached media) rather than hotlink-only publishing.

### Success metrics
- Time per post: **≤ 10 minutes** for 20 images (after first-time setup).
- Publish pipeline success: **≥ 95%** pins scheduled successfully in Publer.
- Copy uniqueness: **≤ 10%** of pins flagged as “too similar” by the duplicate checker.

## 3) Non-Goals (MVP)
- Automatic image editing/design creation (e.g., adding overlays) — future.
- Auto-choosing “best performing” pins based on analytics — future.
- Multi-account Pinterest scheduling in one run — keep to one Pinterest account per run.

## 4) Constraints & Dependencies
- Publer API is available to **Business** users and uses the base URL `https://app.publer.com/api/v1/`.
- Bulk scheduling supports **up to 500 posts per request**.
- Publer Pinterest limitations include **500-char description**, board required, and recommended vertical images.
- Media upload options:
  - direct upload `POST /media` (multipart/form-data)
  - upload from URL `POST /media/from-url` (async; returns `job_id`)
- Creating posts is async (returns a `job_id`) and status is monitored via `GET /job_status/{job_id}`.
- Fetching Pinterest boards uses Publer’s **Media Options** endpoint (boards are “albums”).

## 5) Users / Personas
- **Risalat (Primary user):** SEO/Pinterest-driven site owner who wants to evergreen-schedule pins from existing posts with minimal repetitive work.

## 6) User Stories
1. As a user, I can paste a post URL (or use current tab) and see all eligible images extracted.
2. As a user, I can select multiple boards and mark one board as **Primary** with a percentage (50–60%).
3. As a user, I can set “gap days” and optional “jitter days” and preview the schedule dates.
4. As a user, I can provide a global list of keywords and/or per-image keywords to guide title/description generation.
5. As a user, I can review/edit generated titles and descriptions before scheduling.
6. As a user, I can click “Upload + Schedule” and see progress until Publer confirms completion.

## 7) Functional Requirements (MVP)

### 7.1 URL input & page parsing
**Input modes**
- “Use current tab”
- “Paste URL”

**Extraction**
- Post title (H1 + `<title>` fallback)
- Canonical URL (preferred) and final destination URL
- Meta description (optional)
- Headings structure (H2/H3 + section text)
- Content images:
  - gather from `<article>`/main content container if possible
  - exclude logos/icons/sprites (heuristics: width/height < 350px, file name contains `logo`, `icon`, `sprite`, etc.)
  - dedupe by normalized URL (strip querystrings like `?resize=...`), and by perceptual hash if implemented later
  - pick best `srcset` candidate (largest width)

**Per-image context package**
- `image_url` (best candidate)
- `alt` (if present)
- `caption` (figure/figcaption or WP caption)
- `nearest_heading` (closest preceding H2/H3)
- `section_heading_path` (H2 → H3 if applicable)
- `surrounding_text_snippet` (optional; 1–2 sentences near the image)

### 7.2 Keyword guidance (optional)
Support two keyword sources:
- **Global keywords**: list applied across all pins
- **Per-image keywords**: override/additional keywords for specific images

Keyword use policy:
- Use 1–3 keywords per pin title/description to avoid spammy stuffing.
- Prefer using keywords that match the image’s nearest heading/alt/caption.
- Provide a UI toggle: “Let AI choose relevant keywords” vs “Force include these keywords”.
- **No hashtags**: Never add `#hashtags` to titles or descriptions.

### 7.3 AI copy generation
**Input to AI** (single call per post; returns N items)
- Post title
- Site/brand name (optional)
- Destination URL
- For each image: the context package above
- Keyword lists + constraints
- Tone rules (Pinterest-friendly, not clickbait, not repetitive)

**Output from AI** (strict JSON)
For each image:
- `title` (max 100 chars recommended)
- `description` (max 500 chars enforced)
- `alt_text` (optional; short, descriptive)
- `keywords_used` (optional list for audit)

**Post-processing**
- Strip any `#` hashtag tokens if generated accidentally

- Enforce length limits (truncate + rewrite if needed)
- Similarity check across titles (e.g., cosine similarity or basic n-gram overlap); re-run only the worst offenders
- Ensure each title is meaningfully tied to the post topic (must contain 1–2 anchor terms from post title or its synonyms)

### 7.4 Board selection & distribution
User selects:
- Pinterest account
- Board pool (multi-select)
- Primary board
- Primary share % (default 60%)

Algorithm: **Weighted Round Robin**
- Allocate `round(N * primaryShare)` pins to primary board
- Allocate remainder evenly across other boards
- Avoid same board twice in a row when possible

### 7.5 Scheduling engine (custom gap + jitter)
User selects:
- Start date/time (default: next day at a saved hour)
- Gap days (integer, user-defined)
- Optional jitter days (0–X)
- Optional “quiet hours” (e.g., schedule between 9am–9pm local)

Output:
- `scheduled_at[i] = start + i * gapDays ± random(0..jitterDays)`
- Keep monotonic increasing (if jitter would go backward, clamp forward)
- Add 1–2 minute offsets to prevent collisions (Publer supports precise timestamps).

Timezone:
- Default to Asia/Dhaka offset in timestamps (user-configurable).

### 7.6 Publer API integration
**Auth**
- API Key in `Authorization: Bearer-API ...`
- `Publer-Workspace-Id` required header
- Scopes needed: `workspaces`, `accounts`, `media`, `posts`

**Fetch accounts**
- `GET /accounts` to list connected accounts
- Filter provider = `pinterest`

**Fetch boards**
- `GET /workspaces/{workspace_id}/media_options?accounts[]=...` to retrieve Pinterest boards (albums)

**Media ingestion (reliability-first)**
Preferred flow:
1. Upload each image to Publer Media Library:
   - Either `POST /media/from-url` (async)
   - Or `POST /media` direct upload (fallback if URL-fetch fails)
2. Poll `GET /job_status/{job_id}` until complete
3. Store mapping: `source_image_url → publer_media_id` (cache)

**Bulk schedule**
- Use `POST /posts/schedule` with bulk payload (up to 500 posts)
- Pinterest payload uses `networks.pinterest` with `type: "photo"`, `title`, `text`, `url` and board via `accounts[].album_id`
- Response returns `job_id`; poll job status until completion

### 7.7 Job/status monitoring (extension state tracking)
The extension must track two async pipelines:
1) Media uploads (from-url jobs)
2) Bulk schedule jobs

Status UI:
- per job: “queued → processing → completed/failed”
- per pin: show success/fail and error message if available

MV3 background constraints:
- Use `chrome.alarms` + `chrome.storage` to continue polling even if the service worker sleeps.
- If browser closes, resume polling on next open and show last known job state.

### 7.8 Preview + edit before scheduling
Show a table:
- image thumbnail
- board
- scheduled date/time
- title (editable)
- description (editable)
- keyword chips (optional)

Allow:
- “Regenerate selected pins”
- “Regenerate all”
- “Lock this title” (AI won’t overwrite on regenerate)

## 8) Data Model (Extension)
### `PinJob`
- `jobId` (local)
- `workspaceId`
- `publerScheduleJobId`
- `publerMediaJobIds[]`
- `status` (draft | uploading | scheduling | completed | failed)
- `createdAt`, `updatedAt`
- `sourceUrl`
- `settings` (gapDays, jitterDays, startDate, board rules)
- `pins[]` (PinDraft array)

### `PinDraft`
- `id` (uuid)
- `sourceImageUrl`
- `publerMediaId` (optional until uploaded)
- `title`, `description`, `altText`
- `boardId`
- `scheduledAt`
- `keywordsUsed[]`
- `state` (draft | ready | scheduled | failed)
- `errors[]`

## 9) Edge Cases & Handling
- Image URL upload fails (403 hotlink): fallback to direct upload `POST /media` if extension can fetch the image; otherwise instruct to allow hotlinking or use backend fetcher.
- Too-large images: warn if > 20MB (Pinterest recommendation) and offer to downscale in future.
- Duplicate images: dedupe by normalized URL; show “duplicates collapsed” badge.
- Missing headings/caption/alt: AI uses post title + general section text only.
- Publer scope errors (403): prompt user to re-create API key with required scopes.

## 10) Security & Key Management
Two supported modes:
1) **Extension-only (fastest)**  
   - Store Publer API key + AI key in `chrome.storage.sync` (or local)  
   - Pros: simplest  
   - Cons: keys live in browser; harder to rotate across machines

2) **Extension + tiny backend (recommended)**  
   - Backend stores keys; extension calls backend with a short-lived session token  
   - Pros: better security, easier key rotation, can do “direct upload” reliably by fetching images server-side  
   - Cons: slightly more setup (Vercel/Cloudflare Worker)

MVP can start extension-only and upgrade.

## 11) Testing & Acceptance Criteria
### Unit tests
- URL normalization + dedupe
- schedule generator monotonicity with jitter
- weighted round robin distribution
- AI output validator (JSON schema + limits)

### Integration tests
- Accounts + boards fetch works
- Media from-url upload job completes; media IDs cached
- Bulk schedule job completes; pins appear in Publer calendar

### Acceptance criteria (MVP)
- From a WP post with 20 images, user can schedule 20 pins across multiple boards with custom gap and jitter in < 10 minutes.
- Titles/descriptions differ meaningfully across pins and include contextual cues from headings/captions.
- Job monitoring clearly shows completion/failures and allows re-run for failed items.

## 12) Future Enhancements (Post-MVP)
- Per-board “topic rules” (e.g., certain keywords → certain boards)
- Auto-generate UTM parameters with pin index + board id
- Analytics feedback loop (pull Publer post insights)
- Canva templates / overlay text generation
- Batch mode: paste 10 URLs and schedule across a year automatically

## 13) References (Publer API docs)
- Base URL & Business access: https://publer.com/docs/api-reference/introduction
- Authentication headers: https://publer.com/docs/getting-started/authentication
- Quickstart (job_id + polling example): https://publer.com/docs/getting-started/quickstart
- Creating posts (async jobs): https://publer.com/docs/posting/create-posts
- Bulk scheduling (up to 500): https://publer.com/docs/posting/create-posts/publishing-methods/bulk-scheduling
- Pinterest pins with link URL format: https://publer.com/docs/posting/create-posts/content-types/platform-specific-formats/pinterest-pins-with-a-link-url
- Media handling + job_status: https://publer.com/docs/posting/create-posts/media-handling
- Media API reference: https://publer.com/docs/api-reference/media
