# PinForge Extension

Chrome Extension (Manifest V3) workspace prepared for the PinForge MVP:

- React + TypeScript + Vite
- `@crxjs/vite-plugin` for MV3 build output
- Background service worker + content scraper + popup UI structure
- Core utility modules for Publer API, scheduling, board allocation, validation, and storage

## Prerequisites

- Node.js LTS (tested on `v24.14.0`)
- npm (tested on `11.9.0`)

## Install

```bash
npm install
```

## Development

```bash
npm run dev
```

## Quality checks

```bash
npm run typecheck
npm run lint
npm run test
```

## Build extension

```bash
npm run build
```

Build artifacts are generated in `dist/`.

## Package zip (fixed location)

```bash
npm run package
```

This always writes and overwrites:

- `../build/PinForge-extension.zip`

## Load in Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked"
4. Select the `extension/dist` folder
