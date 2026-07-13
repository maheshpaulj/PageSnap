// ── PageSnap Popup JS ──────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  captureMode: 'visible',
  format: 'png',
  scale: 2,
  delay: 0,
  currentCapture: null,

  // Recording (mirrors SW state)
  recFps: 30,
  recResolution: '1280x720',
  recFormat: 'webm',
  recAudio: 'off',
  recCountdown: 3,
  recStatus: 'idle',
  recEntryId: null,
  recDuration: '',
  recSize: 0,
  recTimerInterval: null,
  recStartTime: 0,
  recTotalPausedMs: 0,
  recPausedAt: 0,

  // Settings
  autoCopy: false,
  showPreview: true,
  filenameTemplate: 'pagesnap_{type}_{date}_{time}',
  theme: 'dark',

  // History view
  historyFilter: 'all',   // all | image | video
  historySort: 'newest',  // newest | oldest
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ════════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  await loadAllSettings();
  applyTheme(state.theme);
  await loadPageInfo();
  await refreshHistory();
  await syncRecordingState();
  bindAll();
  await initAiSearch();
});

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS — persisted
// ════════════════════════════════════════════════════════════════════════════

async function loadAllSettings() {
  const { settings = {}, capturePrefs = {} } = await chrome.storage.local.get(['settings', 'capturePrefs']);

  state.captureMode    = capturePrefs.captureMode    ?? 'visible';
  state.format         = capturePrefs.format         ?? 'png';
  state.scale          = capturePrefs.scale          ?? 2;
  state.delay          = capturePrefs.delay          ?? 0;
  state.recFps         = capturePrefs.recFps         ?? 30;
  state.recResolution  = capturePrefs.recResolution  ?? '1280x720';
  state.recFormat      = capturePrefs.recFormat      ?? 'webm';
  state.recAudio       = capturePrefs.recAudio       ?? 'off';
  state.recCountdown   = capturePrefs.recCountdown   ?? 3;

  state.autoCopy         = settings.autoCopy         ?? false;
  state.showPreview      = settings.showPreview      ?? true;
  state.filenameTemplate = settings.filenameTemplate ?? 'pagesnap_{type}_{date}_{time}';
  state.theme            = settings.theme            ?? 'dark';

  applyPrefsToUI();
  applySettingsToUI();
}

function applyPrefsToUI() {
  $$('.mode-card').forEach(c => c.classList.toggle('active', c.dataset.mode === state.captureMode));
  setSegmented('#format-picker',     state.format);
  setSegmented('#scale-picker',      String(state.scale));
  setSegmented('#fps-picker',        String(state.recFps));
  setSegmented('#rec-format-picker', state.recFormat);
  setSegmented('#audio-picker',      state.recAudio);
  $('#delay-slider').value        = state.delay;
  $('#delay-val').textContent     = `${state.delay}s`;
  $('#countdown-slider').value    = state.recCountdown;
  $('#countdown-val').textContent = `${state.recCountdown}s`;
  $('#rec-resolution').value      = state.recResolution;
}

function applySettingsToUI() {
  $('#setting-autocopy').checked = state.autoCopy;
  $('#setting-preview').checked  = state.showPreview;
  $('#setting-filename').value   = state.filenameTemplate;
  setSegmented('#theme-picker', state.theme);
}

async function saveCapturePrefs() {
  await chrome.storage.local.set({ capturePrefs: {
    captureMode: state.captureMode, format: state.format, scale: state.scale,
    delay: state.delay, recFps: state.recFps, recResolution: state.recResolution,
    recFormat: state.recFormat, recAudio: state.recAudio, recCountdown: state.recCountdown,
  }});
}

async function saveAppSettings() {
  await chrome.storage.local.set({ settings: {
    autoCopy: state.autoCopy, showPreview: state.showPreview,
    filenameTemplate: state.filenameTemplate, theme: state.theme,
  }});
}

// ════════════════════════════════════════════════════════════════════════════
// PAGE INFO
// ════════════════════════════════════════════════════════════════════════════

async function loadPageInfo() {
  try {
    const res = await sendBg({ action: 'GET_TAB_INFO' });
    if (!res.success) return;
    const { title, url } = res.data;
    $('#page-title').textContent = title || url;
    // Chrome's built-in favicon cache — no external requests
    const favUrl = new URL(chrome.runtime.getURL('/_favicon/'));
    favUrl.searchParams.set('pageUrl', url);
    favUrl.searchParams.set('size', '16');
    const favicon = document.createElement('img');
    favicon.src = favUrl.toString();
    favicon.width = 12; favicon.height = 12;
    $('#page-favicon').innerHTML = '';
    $('#page-favicon').appendChild(favicon);
  } catch (e) {
    $('#page-title').textContent = 'Unknown page';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BIND ALL
// ════════════════════════════════════════════════════════════════════════════

function bindAll() {
  // Tabs
  $$('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  // Capture mode cards
  $$('.mode-card').forEach(card => card.addEventListener('click', () => {
    $$('.mode-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    state.captureMode = card.dataset.mode;
    saveCapturePrefs();
  }));

  // Capture settings
  bindSegmented('#format-picker', (v) => { state.format = v; saveCapturePrefs(); });
  bindSegmented('#scale-picker',  (v) => { state.scale = parseInt(v); saveCapturePrefs(); });
  $('#delay-slider').addEventListener('input', (e) => {
    state.delay = parseInt(e.target.value);
    $('#delay-val').textContent = `${state.delay}s`;
    saveCapturePrefs();
  });

  // Capture actions
  $('#btn-capture').addEventListener('click', handleCapture);
  $('#btn-copy').addEventListener('click', handleCopyCapture);
  $('#btn-annotate').addEventListener('click', handleAnnotate);
  $('#btn-discard').addEventListener('click', handleDiscardCapture);

  // Record settings
  bindSegmented('#fps-picker',        (v) => { state.recFps = parseInt(v); saveCapturePrefs(); });
  bindSegmented('#rec-format-picker', (v) => { state.recFormat = v; saveCapturePrefs(); });
  bindSegmented('#audio-picker',      (v) => { state.recAudio = v; saveCapturePrefs(); });
  $('#rec-resolution').addEventListener('change', (e) => { state.recResolution = e.target.value; saveCapturePrefs(); });
  $('#countdown-slider').addEventListener('input', (e) => {
    state.recCountdown = parseInt(e.target.value);
    $('#countdown-val').textContent = `${state.recCountdown}s`;
    saveCapturePrefs();
  });

  // Record controls
  $('#btn-record-start').addEventListener('click', beginRecording);
  $('#btn-rec-pause').addEventListener('click',   handleRecPause);
  $('#btn-rec-stop').addEventListener('click',    handleRecStop);
  $('#btn-rec-resume').addEventListener('click',  handleRecResume);
  $('#btn-rec-stop2').addEventListener('click',   handleRecStop);
  $('#btn-rec-trim').addEventListener('click',    handleRecTrim);
  $('#btn-rec-save').addEventListener('click',    handleRecSave);
  $('#btn-rec-discard').addEventListener('click', handleRecDiscard);

  // History
  $('#btn-clear-history').addEventListener('click', clearHistory);
  $('#btn-export-all').addEventListener('click', exportAll);
  bindSegmented('#history-filter', (v) => { state.historyFilter = v; refreshHistory(); });
  $('#history-sort').addEventListener('click', () => {
    state.historySort = state.historySort === 'newest' ? 'oldest' : 'newest';
    $('#history-sort-label').textContent = state.historySort === 'newest' ? 'Newest' : 'Oldest';
    refreshHistory();
  });

  // Settings modal
  $('#btn-settings').addEventListener('click', () => $('#settings-modal').classList.remove('hidden'));
  $('#close-settings').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
  $('#settings-modal').addEventListener('click', (e) => {
    if (e.target === $('#settings-modal')) $('#settings-modal').classList.add('hidden');
  });
  $('#setting-autocopy').addEventListener('change', (e) => { state.autoCopy = e.target.checked; saveAppSettings(); });
  $('#setting-preview').addEventListener('change',  (e) => { state.showPreview = e.target.checked; saveAppSettings(); });
  $('#setting-filename').addEventListener('change', (e) => { state.filenameTemplate = e.target.value; saveAppSettings(); });
  bindSegmented('#theme-picker', (v) => { state.theme = v; applyTheme(v); saveAppSettings(); });

  // Search
  $('#search-input').addEventListener('input', onSearchInput);
  $('#search-clear').addEventListener('click', () => { $('#search-input').value = ''; onSearchInput(); $('#search-input').focus(); });
  $('#btn-enable-ai').addEventListener('click', downloadModel);

  // AI settings
  $('#btn-ai-model').addEventListener('click', onModelButton);
  $('#btn-reindex').addEventListener('click', reindexAll);
  $('#setting-indexing').addEventListener('change', async (e) => {
    await sendBg({ action: 'AI_SET_STATE', patch: { indexingEnabled: e.target.checked } });
    aiState.indexingEnabled = e.target.checked;
  });

  // First-run modal
  $('#firstrun-download').addEventListener('click', () => downloadModel(true));
  $('#firstrun-later').addEventListener('click', dismissFirstRun);
  $('#firstrun-skip').addEventListener('click', dismissFirstRun);

  // Progress broadcasts from the indexer
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'AI_PROGRESS') onAiProgress(msg);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// AI SEMANTIC SEARCH
// ════════════════════════════════════════════════════════════════════════════

let aiState = { modelState: 'absent', indexingEnabled: true, promptedFirstRun: false };
let searchDebounce = null;
let searchSeq = 0;

async function initAiSearch() {
  try {
    const res = await sendBg({ action: 'AI_STATE' });
    if (res.success) aiState = res.data;
  } catch (_) {}
  applyAiStateToUI();
  if (!aiState.promptedFirstRun) $('#firstrun-modal').classList.remove('hidden');
}

function applyAiStateToUI() {
  const ready = aiState.modelState === 'ready';
  const downloading = aiState.modelState === 'downloading';

  $('#search-enable').classList.toggle('hidden', ready);
  $('#setting-indexing').checked = aiState.indexingEnabled;

  const statusEl = $('#ai-model-status');
  const btn = $('#btn-ai-model');
  if (ready)            { statusEl.textContent = 'Downloaded · ready'; btn.textContent = 'Delete'; btn.classList.add('danger'); }
  else if (downloading) { statusEl.textContent = 'Downloading…';       btn.textContent = 'Download'; btn.classList.remove('danger'); }
  else                  { statusEl.textContent = 'Not downloaded (~40MB)'; btn.textContent = 'Download'; btn.classList.remove('danger'); }

  $('#btn-reindex').disabled = !ready;
  updateIndexStatus();
}

async function updateIndexStatus() {
  const el = $('#ai-index-status');
  if (aiState.modelState !== 'ready') { el.textContent = 'Enable the model first'; return; }
  try {
    const all = await PSDB.embAll();
    const { history = [] } = await chrome.storage.local.get('history');
    el.textContent = `${all.length} of ${history.length} captures indexed`;
  } catch (_) { el.textContent = '—'; }
}

async function downloadModel(fromFirstRun = false) {
  aiState.modelState = 'downloading';
  applyAiStateToUI();
  if (fromFirstRun) {
    $('#firstrun-download').disabled = true;
    $('#firstrun-later').classList.add('hidden');
    $('#firstrun-progress').classList.remove('hidden');
  } else {
    $('#ai-progress').classList.remove('hidden');
  }

  const res = await sendBg({ action: 'AI_MODEL_DOWNLOAD' });
  if (res.success) {
    aiState.modelState = 'ready';
    aiState.promptedFirstRun = true;
    await sendBg({ action: 'AI_SET_STATE', patch: { promptedFirstRun: true } });
    applyAiStateToUI();
    $('#ai-progress').classList.add('hidden');
    dismissFirstRun();
    showToast('✓ AI search ready — indexing your captures…');
    reindexAll(); // backfill existing history
  } else {
    aiState.modelState = 'absent';
    applyAiStateToUI();
    $('#ai-progress').classList.add('hidden');
    $('#firstrun-progress').classList.add('hidden');
    $('#firstrun-download').disabled = false;
    $('#firstrun-later').classList.remove('hidden');
    showToast('⚠ Download failed: ' + (res.error || 'unknown'));
  }
}

async function onModelButton() {
  if (aiState.modelState === 'ready') {
    if (!confirm('Delete the AI model and clear the search index? You can re-download it later.')) return;
    await sendBg({ action: 'AI_MODEL_DELETE' });
    aiState.modelState = 'absent';
    applyAiStateToUI();
    showToast('Model deleted');
  } else if (aiState.modelState !== 'downloading') {
    downloadModel(false);
  }
}

async function reindexAll() {
  if (aiState.modelState !== 'ready') return;
  $('#ai-progress').classList.remove('hidden');
  $('#ai-progress-label').textContent = 'Indexing…';
  const res = await sendBg({ action: 'AI_INDEX_ALL' });
  $('#ai-progress').classList.add('hidden');
  if (res?.success) showToast(`✓ Indexed ${res.indexed} capture${res.indexed === 1 ? '' : 's'}`);
  updateIndexStatus();
}

function onAiProgress(msg) {
  if (msg.phase === 'download') {
    const pct = msg.pct || 0;
    $('#ai-progress-fill').style.width = pct + '%';
    $('#ai-progress-label').textContent = `Downloading model… ${pct}%`;
    $('#firstrun-progress-fill').style.width = pct + '%';
    $('#firstrun-progress-label').textContent = `Downloading model… ${pct}%`;
  } else if (msg.phase === 'index') {
    const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 100;
    $('#ai-progress-fill').style.width = pct + '%';
    $('#ai-progress-label').textContent = `Indexing ${msg.done}/${msg.total}…`;
  }
}

async function dismissFirstRun() {
  $('#firstrun-modal').classList.add('hidden');
  if (!aiState.promptedFirstRun) {
    aiState.promptedFirstRun = true;
    await sendBg({ action: 'AI_SET_STATE', patch: { promptedFirstRun: true } });
  }
}

function onSearchInput() {
  const q = $('#search-input').value.trim();
  $('#search-clear').classList.toggle('hidden', !q);
  clearTimeout(searchDebounce);
  if (!q) { $('#search-results').innerHTML = ''; $('#search-status').textContent = ''; return; }
  searchDebounce = setTimeout(() => runSearch(q), 250);
}

async function runSearch(query) {
  const seq = ++searchSeq;
  const { history = [] } = await chrome.storage.local.get('history');

  // Keyword matches on title/URL always work, model or not
  const ql = query.toLowerCase();
  const keyword = new Map();
  history.forEach(h => {
    if ((h.title || '').toLowerCase().includes(ql) || (h.url || '').toLowerCase().includes(ql)) {
      keyword.set(h.id, 0.5); // fixed boost, ranked below strong semantic hits
    }
  });

  let semantic = new Map();
  if (aiState.modelState === 'ready') {
    $('#search-status').textContent = 'Searching…';
    try {
      const res = await sendBg({ action: 'AI_SEARCH', query });
      if (seq !== searchSeq) return; // superseded by a newer query
      if (res.success) res.results.forEach(r => semantic.set(r.id, r));
    } catch (_) {}
  }

  // Merge: score = max(semantic, keyword-boost). Keep the semantic frame time.
  const merged = [];
  const ids = new Set([...semantic.keys(), ...keyword.keys()]);
  for (const id of ids) {
    const entry = history.find(h => h.id === id);
    if (!entry) continue;
    const sem = semantic.get(id);
    const score = Math.max(sem?.score ?? -1, keyword.get(id) ?? -1);
    merged.push({ entry, score, t: sem?.t ?? null, semantic: !!sem });
  }
  merged.sort((a, b) => b.score - a.score);

  // Show semantic hits above a relevance floor, plus all keyword hits
  const shown = merged.filter(m => m.semantic ? m.score >= 0.18 : true).slice(0, 30);

  if (seq !== searchSeq) return;
  renderSearchResults(shown, query);
}

function renderSearchResults(results, query) {
  const status = $('#search-status');
  const list = $('#search-results');

  if (!results.length) {
    status.textContent = aiState.modelState === 'ready'
      ? 'No matches.'
      : 'No title matches. Enable AI search to search inside captures.';
    list.innerHTML = '';
    return;
  }

  status.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
  list.innerHTML = results.map(r => {
    const e = r.entry;
    const isVideo = e.type === 'video';
    const chip = e.type === 'fullpage' ? 'Full Page' : isVideo ? '▶ Video' : 'Snap';
    const pct = r.semantic ? `<span class="result-score mono">${Math.round(r.score * 100)}%</span>` : '';
    const tstamp = isVideo && r.t != null ? `<span class="mono">@ ${formatDuration(r.t * 1000)}</span>` : '';
    const thumb = isVideo
      ? `<div class="history-thumb-video"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 4l8 4-8 4V4z" fill="currentColor"/></svg></div>`
      : `<div class="history-thumb history-thumb-placeholder" data-entry-id="${e.id}"></div>`;
    return `
      <div class="history-item" data-id="${e.id}" data-t="${r.t ?? ''}" title="Open">
        ${thumb}
        <div class="history-info">
          <div class="title">${escapeHtml(e.title || 'Untitled')}</div>
          <div class="meta">
            <span class="history-chip ${e.type === 'fullpage' ? 'full' : isVideo ? 'video' : ''}">${chip}</span>
            ${tstamp} ${pct}
          </div>
        </div>
      </div>`;
  }).join('');

  // Lazy thumbnails from IndexedDB
  list.querySelectorAll('.history-thumb-placeholder').forEach(async ph => {
    const dataUrl = await PSDB.get(ph.dataset.entryId).catch(() => null);
    if (typeof dataUrl === 'string') {
      const img = document.createElement('img');
      img.className = 'history-thumb'; img.src = dataUrl; img.alt = '';
      ph.replaceWith(img);
    }
  });

  // Click → open
  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', async () => {
      const id = item.dataset.id;
      const entry = results.find(r => r.entry.id === id)?.entry;
      if (!entry) return;
      if (entry.type === 'video') {
        const t = item.dataset.t ? parseFloat(item.dataset.t) : undefined;
        openEditor(id, t);
        return;
      }
      const dataUrl = await PSDB.get(id).catch(() => null);
      if (typeof dataUrl !== 'string') { showToast('⚠ Image data missing'); return; }
      entry.dataUrl = dataUrl;
      switchTab('capture');
      state.currentCapture = entry;
      showPreview(entry);
    });
  });
}

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.tab-content').forEach(tc => tc.classList.remove('active'));
  $(`[data-tab="${name}"]`).classList.add('active');
  $(`#tab-${name}`).classList.add('active');
}

// ════════════════════════════════════════════════════════════════════════════
// CAPTURE FLOW
// ════════════════════════════════════════════════════════════════════════════

async function handleCapture() {
  const btn = $('#btn-capture');
  btn.disabled = true;
  $('#preview-wrap').classList.add('hidden');

  if (state.delay > 0) {
    showToast(`Capturing in ${state.delay}s…`);
    await sleep(state.delay * 1000);
  }

  showProgress(true, 'Capturing…');

  try {
    const action = state.captureMode === 'fullpage' ? 'CAPTURE_FULLPAGE' : 'CAPTURE_VISIBLE';
    let prog = 10;
    setProgress(prog);

    let progressInterval;
    if (state.captureMode === 'fullpage') {
      progressInterval = setInterval(() => {
        prog = Math.min(prog + 2, 80);
        setProgress(prog);
        const label = prog < 25 ? 'Scrolling page…'
                    : prog < 55 ? 'Capturing strips…'
                    : 'Stitching image…';
        $('#progress-label').textContent = label;
      }, 600); // matches CAPTURE_DELAY_MS in SW
    } else {
      setProgress(60);
    }

    const result = await sendBg({ action, opts: { format: state.format, scale: state.scale } });

    if (progressInterval) clearInterval(progressInterval);
    setProgress(100);
    $('#progress-label').textContent = 'Done!';
    await sleep(350);
    showProgress(false);

    if (result.success) {
      state.currentCapture = result.data;
      // Auto-download is handled by service worker (saveToHistory fires it)
      if (state.autoCopy) {
        await copyImageToClipboard(result.data.dataUrl);
        showToast('✓ Saved & copied!');
      } else {
        showToast('✓ Saved to downloads!');
      }
      if (state.showPreview) showPreview(result.data);
      await refreshHistory();
    } else {
      showToast('⚠ ' + (result.error || 'Capture failed'));
    }
  } catch (err) {
    showProgress(false);
    showToast('⚠ ' + err.message);
  }

  btn.disabled = false;
}

function showPreview(entry) {
  const img = new Image();
  img.onload = () => {
    $('#preview-meta').textContent =
      `${img.width}×${img.height} · ${entry.type === 'fullpage' ? 'Full Page' : 'Visible'}`;
  };
  img.src = entry.dataUrl;
  $('#preview-img').src = entry.dataUrl;
  $('#preview-wrap').classList.remove('hidden');
}

async function handleCopyCapture() {
  if (!state.currentCapture) return;
  await copyImageToClipboard(state.currentCapture.dataUrl);
  showToast('✓ Copied to clipboard');
}

async function handleAnnotate() {
  if (!state.currentCapture) return;
  // Store metadata only — the annotate page loads the image from IndexedDB
  const { id, type, title } = state.currentCapture;
  await chrome.storage.local.set({ annotateEntry: { id, type, title } });
  chrome.tabs.create({ url: chrome.runtime.getURL('annotate/annotate.html') });
}

function handleDiscardCapture() {
  state.currentCapture = null;
  $('#preview-wrap').classList.add('hidden');
  $('#preview-img').src = '';
}

async function copyImageToClipboard(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
  } catch (e) { console.warn('Clipboard write failed', e); }
}

// ════════════════════════════════════════════════════════════════════════════
// RECORDING — all heavy lifting in service worker / offscreen
// ════════════════════════════════════════════════════════════════════════════

async function syncRecordingState() {
  try {
    const res = await sendBg({ action: 'REC_STATUS' });
    if (!res.success) return;
    if (res.status === 'recording' || res.status === 'paused') {
      state.recStartTime     = Date.now() - (res.elapsed || 0);
      state.recTotalPausedMs = 0;
      state.recStatus        = res.status;

      switchTab('record');

      if (res.status === 'recording') {
        setRecState('recording');
        startPopupTimer();
      } else {
        const elapsed = res.elapsed || 0;
        $('#rec-timer-paused').textContent = formatDuration(elapsed);
        setRecState('paused');
      }
    }
  } catch (_) {}
}

async function beginRecording() {
  $('#btn-record-start').disabled = true;

  // Get tab info so SW knows which tab to record
  let tabId;
  try {
    const tabInfo = await sendBg({ action: 'GET_TAB_INFO' });
    if (!tabInfo.success) throw new Error(tabInfo.error || 'Could not get tab info');
    tabId = tabInfo.data.id;
  } catch (e) {
    $('#btn-record-start').disabled = false;
    showToast('⚠ ' + e.message);
    setRecState('idle');
    return;
  }

  const opts = {
    fps: state.recFps, resolution: state.recResolution,
    format: state.recFormat, audio: state.recAudio,
    countdown: state.recCountdown,
  };

  // Hand everything to the SW. The SW:
  //   1. injects overlay
  //   2. runs countdown (broadcasts ticks to overlay — survives popup close)
  //   3. calls getMediaStreamId right before recording (fresh token)
  //   4. starts the offscreen recorder
  // We fire this and don't await the full result — popup can close.
  sendBg({ action: 'REC_COUNTDOWN', tabId, opts }).then(result => {
    if (!result?.success) {
      showToast('⚠ ' + (result?.error || 'Recording failed'));
      setRecState('idle');
    }
  }).catch(e => {
    // Popup may have closed before result arrives — that's fine
    console.log('[PageSnap popup] REC_COUNTDOWN response lost (popup closed?):', e.message);
  });

  $('#btn-record-start').disabled = false;

  // Show recording state in popup immediately (timer syncs from SW on next open)
  state.recStatus        = 'recording';
  state.recStartTime     = Date.now() + (state.recCountdown * 1000);
  state.recTotalPausedMs = 0;
  setRecState('recording');
  startPopupTimer();
}

function startPopupTimer() {
  clearInterval(state.recTimerInterval);
  state.recTimerInterval = setInterval(async () => {
    if (state.recStatus !== 'recording') return;
    const elapsed = Date.now() - state.recStartTime - state.recTotalPausedMs;
    $('#rec-timer').textContent = formatDuration(elapsed);
    try {
      const r = await sendBg({ action: 'REC_STATUS' });
      if (r.success) $('#rec-size').textContent = formatBytes(r.size);
    } catch (_) {}
  }, 500);
}

async function handleRecPause() {
  await sendBg({ action: 'REC_PAUSE' });
  state.recStatus   = 'paused';
  state.recPausedAt = Date.now();
  clearInterval(state.recTimerInterval);
  const elapsed = Date.now() - state.recStartTime - state.recTotalPausedMs;
  const display = formatDuration(elapsed);
  $('#rec-timer').textContent        = display;
  $('#rec-timer-paused').textContent = display;
  setRecState('paused');
}

async function handleRecResume() {
  await sendBg({ action: 'REC_RESUME' });
  state.recTotalPausedMs += Date.now() - (state.recPausedAt || Date.now());
  state.recPausedAt  = 0;
  state.recStatus    = 'recording';
  setRecState('recording');
  startPopupTimer();
}

async function handleRecStop() {
  clearInterval(state.recTimerInterval);
  $('#rec-timer').textContent = 'Stopping…';

  const result = await sendBg({ action: 'REC_STOP' });

  if (!result.success) {
    showToast('⚠ Stop failed: ' + (result.error || ''));
    setRecState('idle');
    return;
  }

  state.recStatus   = 'done';
  state.recEntryId  = result.entryId;
  state.recDuration = result.duration || '—';
  state.recSize     = result.size     || 0;

  $('#rec-final-duration').textContent = state.recDuration;
  $('#rec-final-size').textContent     = formatBytes(state.recSize);

  await refreshHistory();
  setRecState('done');
}

function handleRecTrim() {
  if (!state.recEntryId) return;
  openEditor(state.recEntryId);
}

async function handleRecSave() {
  // Already auto-downloaded by SW. Just dismiss.
  showToast('✓ Saved to downloads!');
  handleRecDiscard();
}

async function handleRecDiscard() {
  await sendBg({ action: 'REC_DISCARD' });
  clearInterval(state.recTimerInterval);
  state.recStatus = 'idle';
  setRecState('idle');
}

function setRecState(status) {
  state.recStatus = status;
  const show = {
    idle: 'rec-idle', countdown: 'rec-countdown',
    recording: 'rec-active', paused: 'rec-paused', done: 'rec-done',
  }[status] || 'rec-idle';

  ['rec-idle','rec-countdown','rec-active','rec-paused','rec-done'].forEach(id =>
    document.getElementById(id)?.classList.toggle('hidden', id !== show)
  );
}

function openEditor(entryId, t) {
  let url = chrome.runtime.getURL('editor/editor.html') + '?id=' + encodeURIComponent(entryId);
  if (t != null && isFinite(t)) url += '&t=' + encodeURIComponent(t);
  chrome.tabs.create({ url });
}

// ════════════════════════════════════════════════════════════════════════════
// HISTORY
// ════════════════════════════════════════════════════════════════════════════

async function refreshHistory() {
  const full  = await getHistory();
  const badge = $('#history-badge');
  const list  = $('#history-list');
  const empty = $('#history-empty');
  const toolbar = $('#history-toolbar');

  // Badge reflects the true total, regardless of the active filter
  badge.textContent = full.length;
  badge.classList.toggle('hidden', full.length === 0);
  toolbar.classList.toggle('hidden', full.length === 0);

  if (!full.length) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');

  // Filter (screenshots = visible + fullpage) then sort by date
  const history = full
    .filter(h => state.historyFilter === 'all'
      || (state.historyFilter === 'video' ? h.type === 'video' : h.type !== 'video'))
    .sort((a, b) => state.historySort === 'newest'
      ? b.timestamp - a.timestamp
      : a.timestamp - b.timestamp);

  if (!history.length) {
    list.innerHTML = `<div class="history-none mono muted">No ${state.historyFilter === 'video' ? 'recordings' : 'screenshots'} yet</div>`;
    return;
  }

  list.innerHTML = history.map(buildHistoryItem).join('');

  list.querySelectorAll('.hist-download').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.closest('.history-item').dataset.id;
      const entry = history.find(h => h.id === id);
      if (entry) downloadEntry(entry);
    });
  });

  list.querySelectorAll('.hist-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = btn.closest('.history-item');
      item.style.transition = 'opacity 180ms, transform 180ms';
      item.style.opacity = '0'; item.style.transform = 'translateX(-8px)';
      await sleep(180);
      await sendBg({ action: 'DELETE_HISTORY_ITEM', id: item.dataset.id });
      await refreshHistory();
    });
  });

  // Lazy-load thumbnails straight from IndexedDB (survives SW restarts)
  list.querySelectorAll('.history-thumb-placeholder').forEach(async placeholder => {
    const id = placeholder.dataset.entryId;
    try {
      const dataUrl = await PSDB.get(id);
      if (typeof dataUrl === 'string') {
        const img = document.createElement('img');
        img.className = 'history-thumb';
        img.src = dataUrl;
        img.alt = '';
        placeholder.replaceWith(img);
      }
    } catch (_) {}
  });

  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', async () => {
      const id = item.dataset.id;
      const entry = history.find(h => h.id === id);
      if (!entry) return;

      if (entry.type === 'video') {
        openEditor(entry.id); // videos open in the trim editor
        return;
      }

      if (!entry.dataUrl) {
        const dataUrl = await PSDB.get(id).catch(() => null);
        if (typeof dataUrl !== 'string') { showToast('⚠ Image data missing — re-capture'); return; }
        entry.dataUrl = dataUrl;
      }

      switchTab('capture');
      state.currentCapture = entry;
      showPreview(entry);
    });
  });
}

function buildHistoryItem(entry) {
  const time    = formatRelativeTime(entry.timestamp);
  const isVideo = entry.type === 'video';
  const chipCls = entry.type === 'fullpage' ? 'full' : isVideo ? 'video' : '';
  const chipLbl = entry.type === 'fullpage' ? 'Full Page' : isVideo ? '▶ Video' : 'Snap';

  const thumb = isVideo
    ? `<div class="history-thumb-video"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 4l8 4-8 4V4z" fill="currentColor"/></svg></div>`
    : `<div class="history-thumb history-thumb-placeholder" data-entry-id="${entry.id}">
         <svg width="14" height="14" viewBox="0 0 14 14" fill="none" opacity=".3"><rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><circle cx="4.5" cy="4.5" r="1" fill="currentColor"/><path d="M1 9l3-3 3 3 2-2 4 4" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>
       </div>`;

  return `
    <div class="history-item" data-id="${entry.id}" title="${isVideo ? 'Open in trim editor' : 'Show preview'}">
      ${thumb}
      <div class="history-info">
        <div class="title">${escapeHtml(entry.title || 'Untitled')}</div>
        <div class="meta">
          <span class="history-chip ${chipCls}">${chipLbl}</span>
          <span>${time}</span>
          ${isVideo && entry.duration ? `<span>${entry.duration}</span>` : ''}
          ${isVideo && entry.size ? `<span>${formatBytes(entry.size)}</span>` : ''}
        </div>
      </div>
      <div class="history-item-actions">
        <button class="icon-btn hist-download" title="Download">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M5.5 1v6M3 5l2.5 2.5L8 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M1 9h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="icon-btn danger hist-delete" title="Delete">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>`;
}

async function clearHistory() {
  if (!confirm('Clear all capture history?')) return;
  await sendBg({ action: 'CLEAR_HISTORY' });
  await refreshHistory();
  showToast('History cleared');
}

async function exportAll() {
  const history = await getHistory();
  if (!history.length) { showToast('No captures to export'); return; }
  showToast(`Exporting ${history.length} files…`);
  for (const entry of history) {
    await downloadEntry(entry);
    await sleep(250); // stay clear of download throttling
  }
}

async function downloadEntry(entry) {
  const media = await PSDB.get(entry.id).catch(() => null);
  if (!media) {
    showToast(entry.type === 'video'
      ? '⚠ Video data missing — please re-record'
      : '⚠ Image data missing — re-capture to save again');
    return;
  }

  if (entry.type === 'video') {
    // Blob from IndexedDB → object URL (popup can create these; the SW cannot)
    const url = URL.createObjectURL(media);
    const ext = (entry.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    try {
      await chrome.downloads.download({ url, filename: `pagesnap_video_${entry.id}.${ext}` });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return;
  }

  const ext = entry.format || 'png';
  await sendBg({ action: 'DOWNLOAD', url: media, filename: `pagesnap_${entry.type}_${entry.id}.${ext}` });
}

async function getHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  return history;
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function showProgress(show, label = '') {
  $('#capture-progress').classList.toggle('hidden', !show);
  if (show) { $('#progress-label').textContent = label; setProgress(0); }
}

function setProgress(pct) { $('#progress-fill').style.width = pct + '%'; }

let _toastTimeout;
function showToast(msg, duration = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => t.classList.add('hidden'), duration);
}

function bindSegmented(sel, onChange) {
  $$(sel + ' .seg').forEach(seg => seg.addEventListener('click', () => {
    $$(sel + ' .seg').forEach(s => s.classList.remove('active'));
    seg.classList.add('active');
    onChange(seg.dataset.val);
  }));
}

function setSegmented(sel, value) {
  $$(sel + ' .seg').forEach(seg =>
    seg.classList.toggle('active', seg.dataset.val === String(value))
  );
}

function applyTheme(theme) { document.documentElement.setAttribute('data-theme', theme); }

function sendBg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res || {});
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDuration(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60).toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
