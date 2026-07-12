// PageSnap - Offscreen Document
// Handles getUserMedia + MediaRecorder.
// IMPORTANT: getUserMedia with chromeMediaSource:'tab' must be called HERE
// using a streamId obtained by the SW (which has tabCapture permission).

let mediaRecorder = null;
let chunks        = [];
let captureStream = null;  // raw tab stream
let recordStream  = null;  // stream fed to MediaRecorder
let audioCtx      = null;
let sizeReporter  = null;

function startSizeReporter() {
  clearInterval(sizeReporter);
  sizeReporter = setInterval(() => {
    const size = chunks.reduce((a, c) => a + c.size, 0);
    chrome.runtime.sendMessage({ action: 'OFFSCREEN_SIZE_UPDATE', size }).catch(() => {});
  }, 800);
}
function stopSizeReporter() { clearInterval(sizeReporter); sizeReporter = null; }

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;
  (async () => {
    try {
      switch (message.action) {
        case 'OFFSCREEN_START':  sendResponse(await startCapture(message.streamId, message.opts)); break;
        case 'OFFSCREEN_PAUSE':  if (mediaRecorder?.state === 'recording') mediaRecorder.pause(); sendResponse({ success: true }); break;
        case 'OFFSCREEN_RESUME': if (mediaRecorder?.state === 'paused') mediaRecorder.resume(); sendResponse({ success: true }); break;
        case 'OFFSCREEN_STOP':   sendResponse(await stopCapture(message.entryId)); break;
        case 'OFFSCREEN_DISCARD': discardCapture(); sendResponse({ success: true }); break;
        case 'OFFSCREEN_REVOKE':
          setTimeout(() => { try { URL.revokeObjectURL(message.url); } catch (_) {} }, message.delayMs || 0);
          sendResponse({ success: true });
          break;
        case 'OFFSCREEN_PING':   sendResponse({ ok: true }); break;
        default: sendResponse({ success: false, error: 'Unknown: ' + message.action });
      }
    } catch (e) {
      console.error('[PageSnap offscreen]', e);
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
});

async function startCapture(streamId, opts = {}) {
  if (!streamId) return { success: false, error: 'No streamId provided' };
  if (mediaRecorder) discardCapture();

  try {
    // ── Acquire raw tab stream ─────────────────────────────────────────────
    // Must use 'mandatory' legacy constraints — modern constraints are ignored
    // for chromeMediaSource:'tab' streams.
    const wantAudio = opts.audio !== 'off';
    captureStream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxFrameRate: opts.fps || 30,
          ...(opts.resolution ? (() => {
            const [w, h] = opts.resolution.split('x').map(Number);
            return { maxWidth: w, maxHeight: h };
          })() : {}),
        }
      },
      audio: wantAudio ? {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        }
      } : false,
    });

    // ── Audio routing ──────────────────────────────────────────────────────
    // tabCapture mutes the tab from the speaker. We fix that by routing
    // through an AudioContext that feeds BOTH the speaker AND the recorder.
    const videoTracks = captureStream.getVideoTracks();
    const audioTracks = captureStream.getAudioTracks();
    const recordTracks = [...videoTracks];

    if (wantAudio && audioTracks.length > 0) {
      // Create AudioContext — output goes to default speaker
      audioCtx = new AudioContext({ sampleRate: 48000 });

      const tabSrc = audioCtx.createMediaStreamSource(
        new MediaStream(audioTracks)
      );

      if (opts.audio === 'mic') {
        // Mix tab + mic → recorder; tab only → speaker
        try {
          const micRaw = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
          });
          const micSrc  = audioCtx.createMediaStreamSource(micRaw);
          const mixDest = audioCtx.createMediaStreamDestination();
          tabSrc.connect(audioCtx.destination);   // tab to speaker
          tabSrc.connect(mixDest);                // tab to recorder
          micSrc.connect(mixDest);                // mic to recorder
          recordTracks.push(...mixDest.stream.getAudioTracks());
        } catch (e) {
          console.warn('[offscreen] mic failed, tab audio only:', e.message);
          const recDest = audioCtx.createMediaStreamDestination();
          tabSrc.connect(audioCtx.destination);
          tabSrc.connect(recDest);
          recordTracks.push(...recDest.stream.getAudioTracks());
        }
      } else {
        // Tab audio → speaker AND separate branch → recorder
        const recDest = audioCtx.createMediaStreamDestination();
        tabSrc.connect(audioCtx.destination);  // ← restores audibility
        tabSrc.connect(recDest);               // ← feeds recording
        recordTracks.push(...recDest.stream.getAudioTracks());
      }
    }

    recordStream = new MediaStream(recordTracks);

    // ── MediaRecorder ──────────────────────────────────────────────────────
    chunks = [];
    const mimeType = pickMimeType(opts.format);
    console.log('[offscreen] mimeType:', mimeType,
      'tracks:', recordStream.getTracks().map(t => t.kind + ':' + t.readyState));

    mediaRecorder = new MediaRecorder(recordStream, {
      mimeType,
      videoBitsPerSecond: calcBitrate(opts),
      audioBitsPerSecond: 128_000,
    });

    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
    mediaRecorder.onerror = e => console.error('[offscreen] recorder error:', e);

    mediaRecorder.start(500);
    startSizeReporter();

    return { success: true };
  } catch (e) {
    console.error('[offscreen] startCapture failed:', e);
    cleanUp();
    return { success: false, error: e.message };
  }
}

function stopCapture(entryId) {
  return new Promise(resolve => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      cleanUp();
      resolve({ success: false, error: 'MediaRecorder not active' });
      return;
    }

    stopSizeReporter();
    try { mediaRecorder.requestData(); } catch (_) {}

    const rec = mediaRecorder;
    mediaRecorder = null; // prevent reuse

    rec.onstop = async () => {
      // ── Stop tracks FIRST so tab recording indicator disappears ──────────
      // Do this before the potentially slow blob work.
      cleanUp();

      try {
        if (chunks.length === 0) {
          resolve({ success: false, error: 'No data recorded — stream may have been empty.' });
          return;
        }
        const mimeType = rec.mimeType || 'video/webm';
        const blob = new Blob(chunks, { type: mimeType });
        chunks = [];
        console.log('[offscreen] stop: blob', blob.size, 'bytes, type:', blob.type);

        // Persist to IndexedDB here (this context owns the Blob) so the
        // recording survives service-worker restarts.
        if (entryId) {
          try { await PSDB.put(entryId, blob); }
          catch (e) { console.warn('[offscreen] IndexedDB persist failed:', e.message); }
        }

        // Create a blob: URL — chrome.downloads can download these directly.
        // data: URIs are NOT downloadable via chrome.downloads in MV3.
        const blobUrl = URL.createObjectURL(blob);
        resolve({ success: true, blobUrl, size: blob.size, mimeType: blob.type });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    };

    rec.stop();
  });
}

function discardCapture() {
  stopSizeReporter();
  try { if (mediaRecorder?.state !== 'inactive') mediaRecorder?.stop(); } catch (_) {}
  mediaRecorder = null;
  chunks = [];
  cleanUp();
}

function cleanUp() {
  // Stop all tracks immediately — this removes the recording indicator
  try { captureStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { recordStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { audioCtx?.close(); } catch (_) {}
  captureStream = null;
  recordStream  = null;
  audioCtx      = null;
}

function pickMimeType(format) {
  const list = format === 'mp4'
    ? ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm'];
  return list.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || 'video/webm';
}

function calcBitrate(opts) {
  const [w, h] = (opts.resolution || '1280x720').split('x').map(Number);
  return Math.min(Math.round(w * h * (opts.fps || 30) * 0.05), 8_000_000);
}
