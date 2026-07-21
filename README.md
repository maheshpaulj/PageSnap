<p align="center">
  <img src="icons/banner.png" alt="PageSnap — one extension to capture everything" width="100%" />
</p>

# PageSnap

Screenshots, full-page snaps, and tab recording for Chrome — with a built-in annotation editor and a video trim editor. No external services, no telemetry; everything stays on your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)

## Features

- **Visible-area & full-page capture** — scroll-and-stitch full-page screenshots with lazy-load handling and fixed/sticky header hiding. Choose PNG, JPG, or WebP, and 1× (CSS px) or 2× (device px) output scale.
- **Tab recording** — records tab video + audio via `tabCapture` and an offscreen `MediaRecorder`. Configurable resolution, frame rate, and format (WebM/MP4); tab-only or tab+mic audio (the tab stays audible while recording); pause/resume; a draggable on-page overlay with countdown and live timer. Recording keeps running if you close the popup.
- **Annotation editor** — pen, line, arrow, rectangle, ellipse, text, highlighter, pixelate/redact, and eraser tools, with zoom/pan and undo/redo. Annotations live on their own canvas layer so the eraser can never damage the underlying screenshot.
- **Trim editor** — set in/out points on a timeline, preview the selection, then export just that range. Re-encodes in real time via `captureStream()` + `MediaRecorder`, so audio is preserved with no external dependencies.
- **AI search** — find captures by what they *look like* ("the dark dashboard with a chart"), not just their title. A small CLIP model (~40MB, quantized) runs entirely on-device via a vendored [Transformers.js](https://github.com/huggingface/transformers.js); it embeds each screenshot — and sampled frames of each recording — so a video hit deep-links straight to the matching moment. Opt-in: the model is only downloaded if you choose to enable it, and keyword search on titles works without it.
- **History** — the last 50 captures, with thumbnails, one-click re-download, and per-item delete. Filter by all/screenshots/videos and sort newest/oldest. Metadata lives in `chrome.storage.local`; the actual image/video data (and search embeddings) live in IndexedDB, so they survive service-worker restarts and never hit the 10MB storage quota.
- **Keyboard shortcuts** — `Alt+S` capture visible area, `Alt+F` capture full page.

> **Privacy note:** enabling AI search downloads the CLIP model weights once from the Hugging Face CDN, after which everything (indexing and searching) happens locally — your captures are never uploaded. The model can be deleted anytime from Settings, and auto-indexing can be turned off.

## Install

1. Grab the latest zip from **[Releases](https://github.com/CityIsBetter/PageSnap/releases/latest)** and extract it to a folder.
2. Open `chrome://extensions` in Chrome (or any Chromium-based browser).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the extracted folder — the one containing `manifest.json`.

Building from source instead? Clone the repo and load it unpacked the same way — no build step required.

### Packaging a release zip

```bash
zip -r pagesnap.zip manifest.json background content offscreen popup annotate editor lib icons
```

## Project layout

```
manifest.json                    extension manifest (MV3)
background/service_worker.js     capture orchestration, recording state, history
offscreen/                       offscreen document hosting MediaRecorder
content/overlay.js               on-page recording overlay (injected on demand)
offscreen/indexer.js             CLIP semantic-search indexer (Transformers.js)
popup/                           toolbar popup UI (Capture / Record / Search / History)
annotate/                        screenshot annotation editor
editor/                          video trim editor
lib/db.js                        shared IndexedDB store (media + embeddings)
lib/vendor/                      vendored Transformers.js + ONNX runtime wasm
icons/                           extension icons
```

## How it works

- **Capture** — the service worker drives `chrome.tabs.captureVisibleTab`, scrolling and stitching strips together on an `OffscreenCanvas` for full-page shots.
- **Recording** — the service worker requests a media stream ID via `tabCapture`, then hands it to a hidden offscreen document that runs `getUserMedia` + `MediaRecorder` (service workers can't access media APIs directly). Audio is routed through a Web Audio graph so the tab stays audible while also being recorded.
- **Storage** — screenshots and video blobs are written to IndexedDB (`lib/db.js`), shared across the popup, editors, and service worker. Only small metadata (title, timestamp, type) goes into `chrome.storage.local`, keeping well clear of its 10MB quota.
- **Trimming** — the trim editor plays the selected range through a hidden `<video>` element, captures its output stream, and re-encodes it with `MediaRecorder`. This avoids bundling ffmpeg/wasm at the cost of trimming taking roughly as long as the clip itself.
- **AI search** — the offscreen document hosts a CLIP model (Transformers.js + ONNX runtime, both vendored under `lib/vendor/`). Screenshots and sampled video frames are embedded into 512-d vectors stored in IndexedDB. A query is embedded the same way and ranked by cosine similarity — one text embedding per search, so queries are near-instant; the expensive image embedding happens once, at capture time. Prefers WebGPU, falls back to WASM.

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
