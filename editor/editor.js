// PageSnap — Video Trim Editor
// Loads the recording blob from IndexedDB and trims by re-encoding:
// the selected range is played through a hidden <video> whose captureStream()
// feeds a MediaRecorder. Runs in real time (a 30s trim takes ~30s) but needs
// no external libraries and preserves audio.

const S = {
  entry: null,       // history metadata
  blob: null,        // original video Blob
  url: null,         // object URL for the blob
  duration: 0,       // seconds (recovered — MediaRecorder webm reports Infinity)
  start: 0,
  end: 0,
  playingSelection: false,
  exporting: false,
  exportCancel: null,
  dragging: null,    // 'start' | 'end' | 'seek'
};

const video      = document.getElementById('video');
const timeline   = document.getElementById('timeline');
const selection  = document.getElementById('tl-selection');
const handleS    = document.getElementById('handle-start');
const handleE    = document.getElementById('handle-end');
const playhead   = document.getElementById('tl-playhead');

const MIN_TRIM_GAP = 0.1; // seconds

// ── Load ───────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return fail('No video specified — open from the PageSnap popup or history.');

  const { history = [] } = await chrome.storage.local.get('history');
  S.entry = history.find(h => h.id === id) || { id, title: 'Screen Recording' };

  const blob = await PSDB.get(id).catch(() => null);
  if (!(blob instanceof Blob)) {
    return fail('Video data missing — it may have been deleted. Please re-record.');
  }
  S.blob = blob;
  S.url = URL.createObjectURL(blob);
  video.src = S.url;

  try {
    S.duration = await resolveDuration(video, S.entry.durationMs);
  } catch (e) {
    return fail('Could not read video: ' + e.message);
  }

  S.start = 0;
  S.end = S.duration;

  // Deep-link: ?t=<seconds> (from a video search hit) seeks to that moment
  const tParam = parseFloat(new URLSearchParams(location.search).get('t'));
  if (isFinite(tParam) && tParam > 0 && tParam < S.duration) {
    try { await seekTo(video, tParam); } catch (_) {}
  }

  document.getElementById('video-title').textContent =
    `${S.entry.title || 'Screen Recording'} · ${fmt(S.duration)} · ${fmtBytes(blob.size)}`;

  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  bindAll();
  render();
});

// MediaRecorder-produced webm has no duration header — video.duration is
// Infinity. Seeking far past the end forces Chrome to compute the real one.
function resolveDuration(v, fallbackMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (fallbackMs > 0) resolve(fallbackMs / 1000);
      else reject(new Error('timed out reading duration'));
    }, 8000);

    const settle = () => {
      if (isFinite(v.duration) && v.duration > 0) {
        clearTimeout(timeout);
        v.currentTime = 0;
        resolve(v.duration);
        return true;
      }
      return false;
    };

    const onMeta = () => {
      if (settle()) return;
      // Infinity — trigger the seek hack
      v.currentTime = 1e9;
      v.addEventListener('durationchange', function onDur() {
        if (settle()) v.removeEventListener('durationchange', onDur);
      });
    };
    if (v.readyState >= 1) onMeta(); // metadata already available
    else v.addEventListener('loadedmetadata', onMeta, { once: true });
    v.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error(v.error?.message || 'decode error'));
    }, { once: true });
  });
}

function fail(msg) {
  document.getElementById('loading').innerHTML =
    `<span style="color:var(--danger);max-width:420px;text-align:center">${msg}</span>`;
}

// ── Bind ───────────────────────────────────────────────────────────────────
function bindAll() {
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-set-start').addEventListener('click', () => setStart(video.currentTime));
  document.getElementById('btn-set-end').addEventListener('click', () => setEnd(video.currentTime));
  document.getElementById('btn-reset').addEventListener('click', () => { setStart(0); setEnd(S.duration); });
  document.getElementById('btn-export').addEventListener('click', exportTrimmed);
  document.getElementById('btn-download-original').addEventListener('click', downloadOriginal);
  document.getElementById('btn-cancel-export').addEventListener('click', () => S.exportCancel?.());

  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('play',  updatePlayButton);
  video.addEventListener('pause', updatePlayButton);
  video.addEventListener('click', togglePlay);

  // Timeline dragging (pointer events cover mouse + touch)
  handleS.addEventListener('pointerdown', e => startDrag(e, 'start'));
  handleE.addEventListener('pointerdown', e => startDrag(e, 'end'));
  timeline.addEventListener('pointerdown', e => {
    if (e.target === handleS || e.target === handleE) return;
    startDrag(e, 'seek');
    dragMove(e); // seek immediately on click
  });
  document.addEventListener('pointermove', dragMove);
  document.addEventListener('pointerup',   () => { S.dragging = null; });

  document.addEventListener('keydown', e => {
    if (S.exporting) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'i' || e.key === 'I') setStart(video.currentTime);
    else if (e.key === 'o' || e.key === 'O') setEnd(video.currentTime);
    else if (e.key === 'ArrowLeft')  video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 1 : 1/15));
    else if (e.key === 'ArrowRight') video.currentTime = Math.min(S.duration, video.currentTime + (e.shiftKey ? 1 : 1/15));
  });
}

function startDrag(e, kind) {
  S.dragging = kind;
  e.preventDefault();
}

function dragMove(e) {
  if (!S.dragging) return;
  const rect = timeline.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const t = frac * S.duration;
  if (S.dragging === 'start')      setStart(t);
  else if (S.dragging === 'end')   setEnd(t);
  else /* seek */                  { video.currentTime = t; render(); }
}

// ── Trim points ────────────────────────────────────────────────────────────
function setStart(t) {
  S.start = Math.min(Math.max(0, t), S.end - MIN_TRIM_GAP);
  if (video.currentTime < S.start) video.currentTime = S.start;
  render();
}

function setEnd(t) {
  S.end = Math.max(Math.min(S.duration, t), S.start + MIN_TRIM_GAP);
  if (video.currentTime > S.end) video.currentTime = S.end;
  render();
}

// ── Playback ───────────────────────────────────────────────────────────────
function togglePlay() {
  if (S.exporting) return;
  if (!video.paused) { video.pause(); S.playingSelection = false; return; }
  // Play the selection: jump to start if outside it
  if (video.currentTime < S.start - 0.05 || video.currentTime >= S.end - 0.05) {
    video.currentTime = S.start;
  }
  S.playingSelection = true;
  video.play();
}

function onTimeUpdate() {
  if (S.playingSelection && video.currentTime >= S.end) {
    video.pause();
    video.currentTime = S.end;
    S.playingSelection = false;
  }
  render();
}

function updatePlayButton() {
  const playing = !video.paused;
  document.getElementById('ic-play').style.display  = playing ? 'none' : '';
  document.getElementById('ic-pause').style.display = playing ? '' : 'none';
  document.getElementById('btn-play-label').textContent = playing ? 'Pause' : 'Play selection';
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  const d = S.duration || 1;
  const sPct = (S.start / d) * 100;
  const ePct = (S.end   / d) * 100;
  selection.style.left  = sPct + '%';
  selection.style.width = (ePct - sPct) + '%';
  handleS.style.left = sPct + '%';
  handleE.style.left = ePct + '%';
  playhead.style.left = ((video.currentTime / d) * 100) + '%';

  document.getElementById('lbl-start').textContent  = fmt(S.start);
  document.getElementById('lbl-end').textContent    = fmt(S.end);
  document.getElementById('lbl-length').textContent = fmt(S.end - S.start);
  document.getElementById('current-time').textContent = fmt(video.currentTime);
}

// ── Export (trim by re-encoding) ───────────────────────────────────────────
async function exportTrimmed() {
  if (S.exporting) return;
  if (S.end - S.start < MIN_TRIM_GAP) { toast('⚠ Selection too short'); return; }
  S.exporting = true;
  video.pause();

  const overlay = document.getElementById('export-overlay');
  const fill = document.getElementById('export-fill');
  overlay.classList.add('show');
  fill.style.width = '0%';

  // Hidden playback element. Muted only silences the speaker — per spec,
  // captureStream() audio is unaffected by volume/muted.
  const src = document.createElement('video');
  src.src = S.url;
  src.muted = true;

  let cancelled = false;
  const progressTimer = setInterval(() => {
    const pct = Math.min(100, Math.max(0, ((src.currentTime - S.start) / (S.end - S.start)) * 100));
    fill.style.width = pct.toFixed(1) + '%';
  }, 200);
  const cleanup = () => {
    clearInterval(progressTimer);
    try { src.pause(); } catch (_) {}
    src.removeAttribute('src');
    overlay.classList.remove('show');
    S.exporting = false;
    S.exportCancel = null;
  };

  try {
    await new Promise((res, rej) => {
      src.addEventListener('loadedmetadata', res, { once: true });
      src.addEventListener('error', () => rej(new Error('decode error')), { once: true });
    });
    await seekTo(src, S.start);

    const stream = src.captureStream();
    const mimeType = pickMimeType(S.blob.type);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 128_000,
    });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };

    const done = new Promise(resolve => { recorder.onstop = resolve; });

    S.exportCancel = () => {
      cancelled = true;
      try { recorder.stop(); } catch (_) {}
    };

    recorder.start(250);
    await src.play();

    // Stop exactly at the end mark (checked every frame when supported)
    await new Promise(resolve => {
      const check = () => {
        if (cancelled || src.currentTime >= S.end || src.ended) { resolve(); return; }
        if (src.requestVideoFrameCallback) src.requestVideoFrameCallback(check);
        else setTimeout(check, 40);
      };
      check();
    });

    src.pause();
    if (recorder.state !== 'inactive') recorder.stop();
    await done;

    if (cancelled) { toast('Export cancelled'); cleanup(); return; }

    const outBlob = new Blob(chunks, { type: recorder.mimeType || mimeType });
    if (!outBlob.size) throw new Error('No data produced');

    const ext = (recorder.mimeType || mimeType).includes('mp4') ? 'mp4' : 'webm';
    const now = new Date();
    const filename = `pagesnap_trimmed_${now.toISOString().slice(0,10)}_${now.toTimeString().slice(0,8).replace(/:/g,'-')}.${ext}`;
    const outUrl = URL.createObjectURL(outBlob);
    await chrome.downloads.download({ url: outUrl, filename, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(outUrl), 60_000);

    toast(`✓ Saved ${filename} (${fmtBytes(outBlob.size)})`);
    cleanup();
  } catch (e) {
    cleanup();
    toast('⚠ Export failed: ' + e.message);
  }
}

function seekTo(v, t) {
  return new Promise(resolve => {
    if (Math.abs(v.currentTime - t) < 0.01) { resolve(); return; }
    v.addEventListener('seeked', resolve, { once: true });
    v.currentTime = t;
  });
}

function pickMimeType(sourceType = '') {
  const list = sourceType.includes('mp4')
    ? ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || 'video/webm';
}

// ── Download original ──────────────────────────────────────────────────────
async function downloadOriginal() {
  const ext = (S.blob.type || '').includes('mp4') ? 'mp4' : 'webm';
  await chrome.downloads.download({
    url: S.url,
    filename: `pagesnap_video_${S.entry.id}.${ext}`,
    saveAs: false,
  });
  toast('✓ Downloading original');
}

// ── Utils ──────────────────────────────────────────────────────────────────
function fmt(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

let _tt;
function toast(msg, dur = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove('show'), dur);
}
