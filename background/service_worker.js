// PageSnap — Background Service Worker
importScripts('/lib/db.js');

// ── Recording state (lives here, survives popup close) ───────────────────────
const rec = {
  status: 'idle',        // idle | recording | paused
  startTime: 0,
  pausedAt: 0,
  totalPausedMs: 0,
  overlayTabId: null,
  lastKnownSize: 0,      // updated via poll from offscreen
};

// ── Single message listener ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Fire-and-forget overlay signals — handle inline, no async needed
  if (message.action === 'OVERLAY_PAUSE_CLICKED') {
    if (rec.status === 'recording') pauseRecording();
    else if (rec.status === 'paused') resumeRecording();
    return false;
  }
  if (message.action === 'OVERLAY_STOP_CLICKED') {
    stopRecording().catch(console.error);
    return false;
  }
  if (message.action === 'OVERLAY_GET_STATE') {
    if (rec.overlayTabId && rec.overlayTabId === sender.tab?.id) {
      broadcastOverlay({
        action: 'OVERLAY_STATE',
        status: rec.status,
        startTime: rec.startTime,
        totalPausedMs: rec.totalPausedMs,
      });
    }
    return false;
  }
  if (message.action === 'OFFSCREEN_SIZE_UPDATE') {
    rec.lastKnownSize = message.size || 0;
    return false;
  }

  // All async actions — must return true to keep channel open
  (async () => {
    try {
      switch (message.action) {

        // ── Screenshots ────────────────────────────────────────────────────
        case 'CAPTURE_VISIBLE': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const result = await captureVisible(tab, message.opts);
          sendResponse({ success: true, data: result });
          break;
        }
        case 'CAPTURE_FULLPAGE': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const result = await captureFullPage(tab, message.opts);
          sendResponse({ success: true, data: result });
          break;
        }

        // ── Recording ──────────────────────────────────────────────────────
        case 'REC_COUNTDOWN': {
          const result = await runCountdownThenRecord(message.tabId, message.opts);
          sendResponse(result);
          break;
        }
        case 'REC_PAUSE': {
          pauseRecording();
          sendResponse({ success: true });
          break;
        }
        case 'REC_RESUME': {
          resumeRecording();
          sendResponse({ success: true });
          break;
        }
        case 'REC_STOP': {
          const result = await stopRecording();
          sendResponse(result);
          break;
        }
        case 'REC_STATUS': {
          sendResponse({
            success: true,
            status: rec.status,
            elapsed: getElapsed(),
            size: rec.lastKnownSize,
          });
          break;
        }
        case 'REC_DISCARD': {
          await discardRecording();
          sendResponse({ success: true });
          break;
        }

        // ── Downloads ──────────────────────────────────────────────────────
        case 'DOWNLOAD': {
          await chrome.downloads.download({
            url: message.url,
            filename: message.filename,
            saveAs: message.saveAs || false,
          });
          sendResponse({ success: true });
          break;
        }

        // ── History ────────────────────────────────────────────────────────
        case 'GET_HISTORY': {
          sendResponse({ success: true, data: await getHistory() });
          break;
        }
        case 'DELETE_HISTORY_ITEM': {
          await deleteHistoryItem(message.id);
          sendResponse({ success: true });
          break;
        }
        case 'CLEAR_HISTORY': {
          await clearHistory();
          sendResponse({ success: true });
          break;
        }

        // ── Tab info ───────────────────────────────────────────────────────
        case 'GET_TAB_INFO': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) throw new Error('No active tab');
          sendResponse({ success: true, data: { title: tab.title, url: tab.url, id: tab.id } });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action: ' + message.action });
      }
    } catch (err) {
      console.error('[PageSnap SW]', message.action, err);
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true; // keep port open for async
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const { capturePrefs = {} } = await chrome.storage.local.get('capturePrefs');
  const opts = { format: capturePrefs.format || 'png', scale: capturePrefs.scale || 2 };
  if (command === 'capture-visible') {
    captureVisible(tab, opts).catch(console.error);
  } else if (command === 'capture-fullpage') {
    captureFullPage(tab, opts).catch(console.error);
  }
});

// ── URL guard ─────────────────────────────────────────────────────────────────
function isRestrictedUrl(url = '') {
  if (!url) return true;
  return !url.startsWith('http://') && !url.startsWith('https://');
}

const RESTRICTED_MSG =
  'Cannot capture this page — browser internal pages (chrome://, about:, etc.) are restricted.';

// ── captureVisible ────────────────────────────────────────────────────────────
async function captureVisible(tab, opts = {}) {
  if (isRestrictedUrl(tab.url)) throw new Error(RESTRICTED_MSG);

  // Read CSS viewport width so scale=1 can downscale device pixels → CSS pixels
  let cssWidth = null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.innerWidth,
    });
    cssWidth = res.result;
  } catch (_) { /* conversion falls back to native size */ }

  const raw = await captureWithRetry(tab.windowId);
  const dataUrl = await convertCapture(raw, opts, cssWidth);
  return saveToHistory({
    type: 'visible', format: normalizeFormat(opts.format), dataUrl,
    title: tab.title, url: tab.url, timestamp: Date.now(),
  });
}

// ── captureFullPage ───────────────────────────────────────────────────────────

// Chrome allows ~2 captureVisibleTab calls/sec. We stay well under that.
const CAPTURE_DELAY_MS = 700;   // ms to wait after scroll before capturing
const MAX_CANVAS_PX    = 16384; // hard cap to avoid OOM on very tall pages

async function captureFullPage(tab, opts = {}) {
  if (isRestrictedUrl(tab.url)) throw new Error(RESTRICTED_MSG);

  // 1. Read dimensions
  let dims;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        scrollHeight: Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight),
        scrollWidth:  Math.max(document.body?.scrollWidth  || 0, document.documentElement.scrollWidth),
        viewportHeight: window.innerHeight,
        viewportWidth:  window.innerWidth,
        origScrollY:    window.scrollY,
      }),
    });
    dims = res.result;
  } catch (e) {
    throw new Error('Could not read page dimensions: ' + e.message);
  }

  const { scrollWidth, viewportHeight, viewportWidth, origScrollY } = dims;
  const scrollHeight = Math.min(dims.scrollHeight, MAX_CANVAS_PX);

  // 2. Catalogue fixed/sticky elements (hidden later) + hide scrollbar visually.
  // IMPORTANT: never set overflow:hidden — that breaks window.scrollTo entirely.
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      window.__psnap_fixed = [];
      document.querySelectorAll('*').forEach(el => {
        const pos = window.getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          window.__psnap_fixed.push({ el, vis: el.style.visibility });
        }
      });
      // Hide scrollbar via CSS only — this doesn't affect scrollability
      if (!document.getElementById('__psnap_scrollbar_hide')) {
        const st = document.createElement('style');
        st.id = '__psnap_scrollbar_hide';
        st.textContent = [
          'html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{display:none!important}',
          'html,body{scrollbar-width:none!important}',
        ].join('');
        document.head.appendChild(st);
      }
    },
  });

  // 3. Scroll to top and let page settle
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const el = document.scrollingElement || document.documentElement;
      el.scrollTop = 0;
    },
  });
  await sleep(500); // settle + lazy-load trigger

  // Capture strip 0 (top of page, fixed elements still visible)
  await sleep(CAPTURE_DELAY_MS);
  const strip0 = await captureWithRetry(tab.windowId);

  // NOW hide fixed/sticky elements for all subsequent strips
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      (window.__psnap_fixed || []).forEach(({ el }) => {
        el.style.setProperty('visibility', 'hidden', 'important');
      });
    },
  });
  await sleep(100);

  // 4. Scroll + capture remaining strips
  const strips = [{ dataUrl: strip0, scrollY: 0 }];
  let scrollY     = 0;
  let lastScrollY = -1;
  let stallCount  = 0;

  while (true) {
    // Re-read scrollHeight each iteration — lazy-loaded content grows the page
    const [dimCheck] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.scrollingElement || document.documentElement;
        return Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement.scrollHeight,
          el.scrollHeight
        );
      },
    });
    const liveScrollHeight = Math.min(dimCheck.result, MAX_CANVAS_PX);

    // Done if this strip already covers the bottom
    if (scrollY + viewportHeight >= liveScrollHeight) break;

    const nextY = scrollY + viewportHeight;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (y) => {
        const el = document.scrollingElement || document.documentElement;
        el.scrollTop = y;
        // Some SPAs only respond to window.scrollTo — try both
        window.scrollTo({ top: y, behavior: 'instant' });
      },
      args: [nextY],
    });

    // Wait for paint + lazy content
    await sleep(CAPTURE_DELAY_MS);

    // Read back actual scroll position
    const [posCheck] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.scrollingElement || document.documentElement;
        return el.scrollTop || window.scrollY;
      },
    });
    const actualY = posCheck.result;

    if (actualY === lastScrollY) {
      // Page didn't move — try window.scrollBy directly as fallback
      stallCount++;
      if (stallCount >= 2) break; // give up after 2 consecutive stalls
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (y) => window.scrollBy(0, y),
        args: [viewportHeight],
      });
      await sleep(400);
      const [recheck] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.scrollY,
      });
      if (recheck.result === lastScrollY) break; // truly stuck
      scrollY = recheck.result;
    } else {
      stallCount = 0;
      lastScrollY = actualY;
      scrollY = actualY;
    }

    const dataUrl = await captureWithRetry(tab.windowId);
    strips.push({ dataUrl, scrollY });
  }

  // 5. Restore fixed elements, scrollbar, and original scroll
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      (window.__psnap_fixed || []).forEach(({ el, vis }) => {
        el.style.visibility = vis;
      });
      delete window.__psnap_fixed;
      const st = document.getElementById('__psnap_scrollbar_hide');
      if (st) st.remove();
    },
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (y) => window.scrollTo({ top: y, behavior: 'instant' }),
    args: [origScrollY],
  });

  const stitched = await stitchStrips(strips, scrollWidth, scrollHeight, viewportWidth, viewportHeight, opts);
  return saveToHistory({
    type: 'fullpage', format: normalizeFormat(opts.format), dataUrl: stitched,
    title: tab.title, url: tab.url, timestamp: Date.now(),
  });
}

// Retry captureVisibleTab up to 4 times with exponential backoff on quota errors
async function captureWithRetry(windowId, attempts = 4) {
  let lastErr;
  let delay = 700; // start at 700ms, well past the 1-per-500ms quota
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      lastErr = e;
      const isQuota = e.message?.includes('MAX_CAPTURE_VISIBLE_TAB') ||
                      e.message?.includes('quota') ||
                      e.message?.includes('rate');
      if (!isQuota) throw e;           // non-quota error — don't retry
      console.warn(`[PageSnap] captureVisibleTab quota hit, retry ${i + 1} in ${delay}ms`);
      await sleep(delay);
      delay *= 2;                      // 700 → 1400 → 2800 → 5600
    }
  }
  throw lastErr;
}

// ── Format / scale conversion ────────────────────────────────────────────────
function normalizeFormat(fmt) {
  return fmt === 'jpg' || fmt === 'webp' ? fmt : 'png';
}

function formatToMime(fmt) {
  return { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[normalizeFormat(fmt)];
}

// Applies output format and scale (1× = CSS pixels, 2× = native device pixels).
// cssWidth is the page's CSS pixel width of the same region; null skips scaling.
async function convertCapture(dataUrl, opts = {}, cssWidth = null) {
  const format = normalizeFormat(opts.format);
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const wantDownscale = opts.scale === 1 && cssWidth && bitmap.width > cssWidth;

  if (format === 'png' && !wantDownscale) {
    bitmap.close();
    return dataUrl; // already the right format and size
  }

  const outW = wantDownscale ? Math.round(cssWidth) : bitmap.width;
  const outH = wantDownscale ? Math.round(bitmap.height * (cssWidth / bitmap.width)) : bitmap.height;
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (format === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH); }
  ctx.drawImage(bitmap, 0, 0, outW, outH);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: formatToMime(format), quality: 0.92 });
  return blobToDataUrl(blob);
}

// ── stitchStrips ──────────────────────────────────────────────────────────────
async function stitchStrips(strips, totalCssW, totalCssH, vpCssW, vpCssH, opts = {}) {
  // Measure actual pixel size from first strip
  const firstBlob   = await (await fetch(strips[0].dataUrl)).blob();
  const firstBitmap = await createImageBitmap(firstBlob);
  const dpr         = firstBitmap.width / vpCssW;
  firstBitmap.close();

  const canvasW  = Math.round(totalCssW * dpr);
  const canvasH  = Math.round(totalCssH * dpr);
  const stripPxH = Math.round(vpCssH    * dpr);

  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx    = canvas.getContext('2d');

  for (let i = 0; i < strips.length; i++) {
    const { dataUrl, scrollY } = strips[i];
    const blob   = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const drawY  = Math.round(scrollY * dpr);
    const isLast = i === strips.length - 1;

    if (isLast) {
      const remaining = canvasH - drawY;
      const srcY      = Math.max(0, bitmap.height - remaining);
      ctx.drawImage(bitmap, 0, srcY, bitmap.width, remaining, 0, drawY, canvasW, remaining);
    } else {
      ctx.drawImage(bitmap, 0, 0, bitmap.width, stripPxH, 0, drawY, canvasW, stripPxH);
    }
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const stitched = await blobToDataUrl(blob);
  return convertCapture(stitched, opts, totalCssW);
}

// ── Recording ─────────────────────────────────────────────────────────────────

// Runs countdown in SW (popup-independent), then gets streamId and starts.
// streamId must be obtained in SW right before use — the token is short-lived.
async function runCountdownThenRecord(tabId, opts = {}) {
  if (rec.status !== 'idle') return { success: false, error: 'Already recording' };

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (_) {}
  if (!tab) return { success: false, error: 'Tab not found' };
  if (isRestrictedUrl(tab.url)) return { success: false, error: 'Cannot record browser internal pages.' };

  rec.overlayTabId = tabId;
  await injectOverlay(tabId);

  // Countdown — broadcast each tick to the overlay
  const n = opts.countdown ?? 0;
  for (let i = n; i > 0; i--) {
    broadcastOverlay({ action: 'OVERLAY_STATE', status: 'countdown', n: i });
    await sleep(1000);
  }

  // Get a fresh streamId NOW — right before handing to offscreen
  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tabId },
        (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        }
      );
    });
  } catch (e) {
    removeOverlay(tabId);
    rec.overlayTabId = null;
    return { success: false, error: 'tabCapture.getMediaStreamId failed: ' + e.message };
  }

  try {
    await ensureOffscreen();
    const response = await sendToOffscreen('OFFSCREEN_START', { streamId, opts });
    if (!response?.success) {
      removeOverlay(tabId);
      rec.overlayTabId = null;
      return { success: false, error: response?.error || 'Offscreen start failed' };
    }

    rec.status        = 'recording';
    rec.startTime     = Date.now();
    rec.totalPausedMs = 0;
    rec.pausedAt      = 0;
    rec.lastKnownSize = 0;

    broadcastOverlay({ action: 'OVERLAY_STATE', status: 'recording', startTime: rec.startTime, totalPausedMs: 0 });
    return { success: true };
  } catch (e) {
    removeOverlay(tabId);
    rec.overlayTabId = null;
    return { success: false, error: e.message };
  }
}

function pauseRecording() {
  if (rec.status !== 'recording') return;
  rec.status   = 'paused';
  rec.pausedAt = Date.now();
  sendToOffscreen('OFFSCREEN_PAUSE', {}).catch(() => {});
  broadcastOverlay({ action: 'OVERLAY_STATE', status: 'paused', elapsed: getElapsed() });
}

function resumeRecording() {
  if (rec.status !== 'paused') return;
  rec.totalPausedMs += (Date.now() - rec.pausedAt);
  rec.pausedAt  = 0;
  rec.status    = 'recording';
  sendToOffscreen('OFFSCREEN_RESUME', {}).catch(() => {});
  broadcastOverlay({ action: 'OVERLAY_STATE', status: 'recording', startTime: rec.startTime, totalPausedMs: rec.totalPausedMs });
}

async function stopRecording() {
  if (rec.status === 'idle') return { success: false, error: 'Not recording' };

  // Snapshot elapsed before clearing state
  const elapsed = getElapsed();

  // Clear state before async ops to prevent double-stop
  rec.status = 'idle';

  if (rec.overlayTabId) {
    removeOverlay(rec.overlayTabId);
    rec.overlayTabId = null;
  }

  // Pre-assign the history id so the offscreen doc (which owns the Blob)
  // can persist it to IndexedDB directly — no cross-context blob fetch.
  const entryId = makeEntryId();

  let response;
  try {
    response = await sendToOffscreen('OFFSCREEN_STOP', { entryId });
  } catch (e) {
    return { success: false, error: 'Offscreen stop failed: ' + e.message };
  }

  if (!response?.success) return { success: false, error: response?.error || 'Stop failed' };

  const duration = formatDuration(elapsed);
  const entry = await saveToHistory({
    id: entryId,
    type: 'video',
    dataUrl: null,
    title: 'Screen Recording',
    url: '',
    timestamp: Date.now(),
    duration,
    durationMs: elapsed,
    size: response.size,
    mimeType: response.mimeType,
  }, true);

  // Auto-download — blob: URLs work correctly with chrome.downloads
  const ext = response.mimeType?.includes('mp4') ? 'mp4' : 'webm';
  const filename = (await buildAutoFilename('recording')) + '.' + ext;
  try {
    await chrome.downloads.download({ url: response.blobUrl, filename, saveAs: false });
  } catch (e) {
    console.warn('[PageSnap] Video download failed:', e.message);
  }
  // Let the offscreen doc free the blob URL once the download has started
  sendToOffscreen('OFFSCREEN_REVOKE', { url: response.blobUrl, delayMs: 60_000 }).catch(() => {});

  rec.startTime     = 0;
  rec.totalPausedMs = 0;
  rec.lastKnownSize = 0;

  return { success: true, data: entry, entryId: entry.id, duration, size: response.size };
}

async function discardRecording() {
  if (rec.overlayTabId) { removeOverlay(rec.overlayTabId); rec.overlayTabId = null; }
  rec.status = 'idle'; rec.startTime = 0; rec.totalPausedMs = 0; rec.lastKnownSize = 0;
  await sendToOffscreen('OFFSCREEN_DISCARD', {}).catch(() => {});
}

function getElapsed() {
  if (!rec.startTime) return 0;
  if (rec.status === 'paused') {
    return (rec.pausedAt || Date.now()) - rec.startTime - rec.totalPausedMs;
  }
  return Date.now() - rec.startTime - rec.totalPausedMs;
}

// ── Offscreen ─────────────────────────────────────────────────────────────────
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (!has) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'PageSnap: MediaRecorder for tab recording',
    });
  }
  // Ping until the offscreen doc's message listener is ready (up to 2s)
  for (let i = 0; i < 20; i++) {
    try {
      const pong = await sendToOffscreen('OFFSCREEN_PING', {});
      if (pong?.ok) return; // ready
    } catch (_) {}
    await sleep(100);
  }
}

function sendToOffscreen(action, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: 'offscreen', action, ...extra }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// ── Overlay ───────────────────────────────────────────────────────────────────
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/overlay.js'] });
  } catch (e) {
    console.warn('[PageSnap] Overlay inject failed:', e.message);
  }
}

function removeOverlay(tabId) {
  chrome.tabs.sendMessage(tabId, { action: 'OVERLAY_REMOVE' }).catch(() => {});
}

function broadcastOverlay(msg) {
  if (rec.overlayTabId != null) {
    chrome.tabs.sendMessage(rec.overlayTabId, msg).catch(() => {});
  }
}

// ── Auto-download ─────────────────────────────────────────────────────────────
async function buildAutoFilename(type) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const template = settings.filenameTemplate || 'pagesnap_{type}_{date}_{time}';
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  let name = template
    .replace('{date}', date).replace('{time}', time).replace('{type}', type);
  if (!template.includes('{date}') && !template.includes('{time}')) {
    name += `_${date}_${time}`; // template without timestamps — avoid filename collisions
  }
  return name.replace(/[<>:"/\\|?*]/g, '-');
}

async function autoDownload(entry) {
  if (!entry?.dataUrl) return;
  try {
    const filename = (await buildAutoFilename(entry.type)) + '.' + (entry.format || 'png');
    await chrome.downloads.download({ url: entry.dataUrl, filename, saveAs: false });
  } catch (e) {
    console.warn('[PageSnap] Auto-download failed:', e.message);
  }
}

// ── History ───────────────────────────────────────────────────────────────────
// Metadata lives in chrome.storage.local (small); media lives in IndexedDB.
const HISTORY_LIMIT = 50;

function makeEntryId() {
  return `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function saveToHistory(entry, skipAutoDownload = false) {
  entry.id = entry.id || makeEntryId();

  if (entry.dataUrl) {
    await PSDB.put(entry.id, entry.dataUrl);
  }

  // Save metadata only to storage — strip the dataUrl
  const stored = { ...entry, dataUrl: null };
  const { history = [] } = await chrome.storage.local.get('history');
  const next = [stored, ...history];
  const kept = next.slice(0, HISTORY_LIMIT);
  const pruned = next.slice(HISTORY_LIMIT);
  await chrome.storage.local.set({ history: kept });
  for (const old of pruned) {
    PSDB.remove(old.id).catch(() => {});
  }

  if (!skipAutoDownload && entry.dataUrl) {
    autoDownload(entry); // fire and forget
  }
  return entry; // return with dataUrl still attached for immediate popup use
}

async function getHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  return history;
}

async function deleteHistoryItem(id) {
  const { history = [] } = await chrome.storage.local.get('history');
  await chrome.storage.local.set({ history: history.filter(h => h.id !== id) });
  await PSDB.remove(id).catch(() => {});
}

async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
  await PSDB.clear().catch(() => {});
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDuration(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
