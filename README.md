# PageSnap

Screenshots, full-page snaps, and tab recording for Chrome — with a built-in annotation editor and a video trim editor. No external services, no telemetry; everything stays on your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)

## Features

- **Visible-area & full-page capture** — scroll-and-stitch full-page screenshots with lazy-load handling and fixed/sticky header hiding. Choose PNG, JPG, or WebP, and 1× (CSS px) or 2× (device px) output scale.
- **Tab recording** — records tab video + audio via `tabCapture` and an offscreen `MediaRecorder`. Configurable resolution, frame rate, and format (WebM/MP4); tab-only or tab+mic audio (the tab stays audible while recording); pause/resume; a draggable on-page overlay with countdown and live timer. Recording keeps running if you close the popup.
- **Annotation editor** — pen, line, arrow, rectangle, ellipse, text, highlighter, pixelate/redact, and eraser tools, with zoom/pan and undo/redo. Annotations live on their own canvas layer so the eraser can never damage the underlying screenshot.
- **Trim editor** — set in/out points on a timeline, preview the selection, then export just that range. Re-encodes in real time via `captureStream()` + `MediaRecorder`, so audio is preserved with no external dependencies.
- **History** — the last 50 captures, with thumbnails, one-click re-download, and per-item delete. Metadata lives in `chrome.storage.local`; the actual image/video data lives in IndexedDB, so it survives service-worker restarts and never hits the 10MB storage quota.
- **Keyboard shortcuts** — `Alt+S` capture visible area, `Alt+F` capture full page.

## Install

### From source (recommended for now)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium-based browser).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder — the one containing `manifest.json`.

### Packaged zip

To produce a distributable zip (e.g. for the Chrome Web Store dashboard):

```bash
zip -r pagesnap.zip manifest.json background content offscreen popup annotate editor lib icons
```

## Project layout

```
manifest.json                    extension manifest (MV3)
background/service_worker.js     capture orchestration, recording state, history
offscreen/                       offscreen document hosting MediaRecorder
content/overlay.js               on-page recording overlay (injected on demand)
popup/                           toolbar popup UI
annotate/                        screenshot annotation editor
editor/                          video trim editor
lib/db.js                        shared IndexedDB media store
icons/                           extension icons
```

## How it works

- **Capture** — the service worker drives `chrome.tabs.captureVisibleTab`, scrolling and stitching strips together on an `OffscreenCanvas` for full-page shots.
- **Recording** — the service worker requests a media stream ID via `tabCapture`, then hands it to a hidden offscreen document that runs `getUserMedia` + `MediaRecorder` (service workers can't access media APIs directly). Audio is routed through a Web Audio graph so the tab stays audible while also being recorded.
- **Storage** — screenshots and video blobs are written to IndexedDB (`lib/db.js`), shared across the popup, editors, and service worker. Only small metadata (title, timestamp, type) goes into `chrome.storage.local`, keeping well clear of its 10MB quota.
- **Trimming** — the trim editor plays the selected range through a hidden `<video>` element, captures its output stream, and re-encodes it with `MediaRecorder`. This avoids bundling ffmpeg/wasm at the cost of trimming taking roughly as long as the clip itself.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `tabs` | Identify and capture the current tab |
| `scripting` | Read page dimensions, scroll during full-page capture, inject the recording overlay |
| `tabCapture` | Record tab video/audio |
| `offscreen` | Run `MediaRecorder` outside the service worker |
| `storage` | Persist settings and capture history metadata |
| `downloads` | Auto-save captures and recordings to disk |

## Contributing

Issues and pull requests are welcome. Please keep changes focused and match the existing code style — no new build tooling or external runtime dependencies unless there's a strong reason.

## License

[MIT](LICENSE) © Mahesh Paul J
