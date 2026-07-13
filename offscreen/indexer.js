// PageSnap — Semantic search indexer (runs in the offscreen document).
// Loads a quantized CLIP model via the vendored Transformers.js, computes
// image + text embeddings, indexes captures into IndexedDB, and ranks
// searches. Kept in the offscreen doc because the service worker can't use
// WebGPU/WASM/DOM, and the popup is too short-lived for indexing.

import {
  env,
  AutoTokenizer, CLIPTextModelWithProjection,
  AutoProcessor, CLIPVisionModelWithProjection,
  RawImage,
} from '../lib/vendor/transformers-3.7.6.min.js';

const MODEL_ID  = 'Xenova/clip-vit-base-patch32';
const MODEL_TAG = 'clip-b32-q8';        // bump if the model/dtype changes → forces reindex
const DTYPE     = 'q8';                  // quantized (~40MB download)
const CACHE_NAME = 'transformers-cache'; // where Transformers.js caches weights

const VIDEO_MAX_FRAMES   = 16;   // cap frames sampled per recording
const VIDEO_MIN_STEP_SEC = 3;    // don't sample closer than this
const SEARCH_TOP_K       = 30;

// ── Transformers.js environment ──────────────────────────────────────────────
env.allowLocalModels = false;                 // weights come from the HF hub
env.useBrowserCache  = true;                  // …and are cached in the Cache API
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/vendor/');
env.backends.onnx.wasm.proxy      = false;    // no worker — avoids MV3 CSP issues
env.backends.onnx.wasm.numThreads = 1;        // extension pages aren't cross-origin isolated

// ── Model state ──────────────────────────────────────────────────────────────
let tokenizer = null, textModel = null, processor = null, visionModel = null;
let device = null;              // 'webgpu' | 'wasm'
let loadPromise = null;         // de-dupe concurrent loads

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'indexer') return false;
  (async () => {
    try {
      switch (msg.action) {
        case 'PING':         sendResponse({ ok: true, loaded: !!visionModel, device }); break;
        case 'LOAD_MODEL':   await loadModel(); sendResponse({ success: true, device }); break;
        case 'INDEX_ENTRY':  sendResponse(await indexEntry(msg.entry)); break;
        case 'INDEX_ALL':    sendResponse(await indexAll(msg.entries)); break;
        case 'SEARCH':       sendResponse(await search(msg.query)); break;
        case 'DELETE_MODEL': sendResponse(await deleteModel()); break;
        default: sendResponse({ success: false, error: 'Unknown indexer action: ' + msg.action });
      }
    } catch (e) {
      console.error('[PageSnap indexer]', msg.action, e);
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
});

// ── Model loading (with aggregated download progress) ────────────────────────
function loadModel() {
  if (visionModel) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const files = new Map(); // file → { loaded, total }
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.file) {
        files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        const pct = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
        broadcast({ action: 'AI_PROGRESS', phase: 'download', pct, file: p.file });
      }
    };

    const prefer = ('gpu' in navigator) ? 'webgpu' : 'wasm';
    try {
      await loadOn(prefer, progress_callback);
    } catch (e) {
      if (prefer === 'webgpu') {
        console.warn('[indexer] WebGPU load failed, falling back to WASM:', e.message);
        broadcast({ action: 'AI_PROGRESS', phase: 'download', pct: 0, file: 'wasm fallback' });
        resetModel();
        await loadOn('wasm', progress_callback);
      } else {
        throw e;
      }
    }
    broadcast({ action: 'AI_PROGRESS', phase: 'download', pct: 100 });
  })().finally(() => { loadPromise = null; });

  return loadPromise;
}

async function loadOn(dev, progress_callback) {
  const opts = { dtype: DTYPE, device: dev, progress_callback };
  tokenizer   = await AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback });
  textModel   = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, opts);
  processor   = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
  visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, opts);
  device = dev;
}

function resetModel() {
  tokenizer = textModel = processor = visionModel = null;
  device = null;
}

async function deleteModel() {
  resetModel();
  try { await caches.delete(CACHE_NAME); } catch (_) {}
  try { await PSDB.embClear(); } catch (_) {}
  return { success: true };
}

// ── Embedding helpers ────────────────────────────────────────────────────────
function l2normalize(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / norm;
  return out;
}

// CLIP projection models return { text_embeds | image_embeds, last_hidden_state }.
// Pick the projected-embedding tensor by name, falling back to the smaller 2-D
// output if the runtime ever names it differently.
function pickEmbedding(output, preferredKey) {
  if (output[preferredKey]?.data) return output[preferredKey].data;
  let best = null;
  for (const t of Object.values(output)) {
    if (!t?.data || !t?.dims) continue;
    if (!best || t.data.length < best.data.length) best = t;
  }
  if (!best) throw new Error('model produced no embedding output');
  return best.data;
}

async function embedText(text) {
  await loadModel();
  const inputs = tokenizer([text], { padding: true, truncation: true });
  const output = await textModel(inputs);
  return l2normalize(pickEmbedding(output, 'text_embeds'));
}

async function embedImage(rawImage) {
  await loadModel();
  const inputs = await processor(rawImage);
  const output = await visionModel(inputs);
  return l2normalize(pickEmbedding(output, 'image_embeds'));
}

async function rawImageFromBlobOrDataUrl(src) {
  const blob = (src instanceof Blob) ? src : await (await fetch(src)).blob();
  return RawImage.fromBlob(blob);
}

// ── Indexing ─────────────────────────────────────────────────────────────────
async function indexEntry(entry) {
  await loadModel();
  const media = await PSDB.get(entry.id);
  if (media == null) return { success: false, error: 'media missing' };

  let frames;
  if (entry.type === 'video') {
    frames = await embedVideoFrames(media, entry.durationMs);
  } else {
    const img = await rawImageFromBlobOrDataUrl(media);
    frames = [{ t: null, v: await embedImage(img) }];
  }

  if (!frames.length) return { success: false, error: 'no frames embedded' };
  await PSDB.embPut(entry.id, { model: MODEL_TAG, at: Date.now(), frames });
  return { success: true, frames: frames.length };
}

async function indexAll(entries) {
  await loadModel();
  const existing = await PSDB.embAll();
  const indexed = new Map(existing.map(e => [e.id, e.value?.model]));

  const todo = entries.filter(e => indexed.get(e.id) !== MODEL_TAG);
  let done = 0;
  broadcast({ action: 'AI_PROGRESS', phase: 'index', done, total: todo.length });

  for (const entry of todo) {
    try { await indexEntry(entry); } catch (e) { console.warn('[indexer] skip', entry.id, e.message); }
    done++;
    broadcast({ action: 'AI_PROGRESS', phase: 'index', done, total: todo.length });
  }
  return { success: true, indexed: done, skipped: entries.length - todo.length };
}

// Sample frames across a recording and embed each. Returns [{ t, v }].
async function embedVideoFrames(blob, durationMs) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.src = url;

  try {
    const duration = await resolveDuration(video, durationMs);
    const step = Math.max(VIDEO_MIN_STEP_SEC, duration / VIDEO_MAX_FRAMES);
    const times = [];
    for (let t = Math.min(0.3, duration / 2); t < duration && times.length < VIDEO_MAX_FRAMES; t += step) {
      times.push(t);
    }

    const canvas = document.createElement('canvas');
    const scale = video.videoWidth > 640 ? 640 / video.videoWidth : 1;
    canvas.width  = Math.max(1, Math.round(video.videoWidth  * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d');

    const frames = [];
    for (const t of times) {
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frameBlob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
      if (!frameBlob) continue;
      const img = await RawImage.fromBlob(frameBlob);
      frames.push({ t, v: await embedImage(img) });
    }
    return frames;
  } finally {
    video.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

// MediaRecorder webm reports Infinity duration; fall back to recorded ms, and
// as a last resort force Chrome to compute it via a far seek.
function resolveDuration(v, fallbackMs) {
  return new Promise((resolve, reject) => {
    const done = (d) => resolve(d);
    const onMeta = () => {
      if (isFinite(v.duration) && v.duration > 0) { v.currentTime = 0; return done(v.duration); }
      if (fallbackMs > 0) return done(fallbackMs / 1000);
      v.currentTime = 1e9;
      v.addEventListener('durationchange', function d2() {
        if (isFinite(v.duration) && v.duration > 0) {
          v.removeEventListener('durationchange', d2);
          v.currentTime = 0; done(v.duration);
        }
      });
    };
    if (v.readyState >= 1) onMeta();
    else v.addEventListener('loadedmetadata', onMeta, { once: true });
    v.addEventListener('error', () => reject(new Error('video decode error')), { once: true });
    setTimeout(() => { if (fallbackMs > 0) done(fallbackMs / 1000); else reject(new Error('duration timeout')); }, 8000);
  });
}

function seekTo(v, t) {
  return new Promise((resolve) => {
    const onSeek = () => resolve();
    v.addEventListener('seeked', onSeek, { once: true });
    v.currentTime = t;
    // Guard against a seek that never fires
    setTimeout(resolve, 3000);
  });
}

// ── Search ───────────────────────────────────────────────────────────────────
async function search(query) {
  const q = await embedText(query);
  const all = await PSDB.embAll();
  const results = [];

  for (const { id, value } of all) {
    if (!value?.frames?.length) continue;
    let best = -1, bestT = null;
    for (const f of value.frames) {
      let dot = 0;
      const v = f.v;
      for (let i = 0; i < v.length; i++) dot += v[i] * q[i];
      if (dot > best) { best = dot; bestT = f.t; }
    }
    results.push({ id, score: best, t: bestT });
  }

  results.sort((a, b) => b.score - a.score);
  return { success: true, results: results.slice(0, SEARCH_TOP_K) };
}
