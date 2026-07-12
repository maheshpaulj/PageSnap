// PageSnap — Annotation Editor
// Three canvas layers:
//   base — the screenshot, never modified (except nothing modifies it)
//   anno — committed annotations; the eraser works here, so it can never
//          punch holes through the screenshot itself
//   draw — live in-progress stroke/shape preview

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  tool: 'pen',
  color: '#FF3B5C',
  size: 3,
  opacity: 1.0,
  drawing: false,
  startX: 0, startY: 0,
  lastX: 0,  lastY: 0,
  history: [],
  future:  [],
  textPos: null,
  imageEntry: null,
  zoom: 1.0,
  panning: false,
  panStartX: 0, panStartY: 0,
  panScrollX: 0, panScrollY: 0,
  spaceDown: false,
};

const ZOOM_STEPS = [0.05,0.08,0.1,0.125,0.15,0.2,0.25,0.33,0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2,2.5,3,4,5,6,8];

// ── DOM ────────────────────────────────────────────────────────────────────
const baseCanvas = document.getElementById('base-canvas');
const annoCanvas = document.getElementById('anno-canvas');
const drawCanvas = document.getElementById('draw-canvas');
const bCtx       = baseCanvas.getContext('2d');
const aCtx       = annoCanvas.getContext('2d');
const dCtx       = drawCanvas.getContext('2d');
const container  = document.getElementById('canvas-container');
const canvasWrap = document.getElementById('canvas-wrap');

// ── Load ───────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  try {
    const { annotateEntry } = await chrome.storage.local.get('annotateEntry');
    if (!annotateEntry?.id) {
      document.getElementById('loading').innerHTML =
        '<span style="color:var(--danger)">No image found — open from the PageSnap popup.</span>';
      return;
    }
    S.imageEntry = annotateEntry;

    const dataUrl = await PSDB.get(annotateEntry.id).catch(() => null);
    if (typeof dataUrl !== 'string') {
      document.getElementById('loading').innerHTML =
        '<span style="color:var(--danger)">Image data missing. Please re-capture and reopen the editor.</span>';
      return;
    }
    await loadImage(dataUrl);
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('sb-dims').textContent =
      `${baseCanvas.width} × ${baseCanvas.height}`;
    // Fit page after layout settles
    requestAnimationFrame(() => requestAnimationFrame(zoomFitPage));
  } catch (e) {
    document.getElementById('loading').innerHTML =
      `<span style="color:var(--danger)">Error: ${e.message}</span>`;
  }
  bindAll();
});

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      for (const c of [baseCanvas, annoCanvas, drawCanvas]) {
        c.width  = img.width;
        c.height = img.height;
      }
      bCtx.drawImage(img, 0, 0);
      pushHistory(); // initial (blank) annotation snapshot
      resolve();
    };
    img.onerror = reject;
    img.src = src;
  });
}

// ══════════════════════════════════════════════════════════════════════════
// ZOOM — uses CSS width/height on canvas elements (not transform scale)
// This way the browser's scroll/layout engine knows the real rendered size.
// ══════════════════════════════════════════════════════════════════════════

function applyZoom(z) {
  S.zoom = Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], z));

  const w = Math.round(baseCanvas.width  * S.zoom);
  const h = Math.round(baseCanvas.height * S.zoom);

  // Set CSS size on all canvases — pixel dimensions stay untouched
  for (const c of [baseCanvas, annoCanvas, drawCanvas]) {
    c.style.width  = w + 'px';
    c.style.height = h + 'px';
  }
  container.style.width  = w + 'px';
  container.style.height = h + 'px';

  updateZoomUI();
}

// Zoom keeping a viewport-relative pivot point stationary
function applyZoomAroundPivot(z, pivotViewX, pivotViewY) {
  const prevZoom = S.zoom;
  const prevScrollX = canvasWrap.scrollLeft;
  const prevScrollY = canvasWrap.scrollTop;

  // Canvas coords under cursor before zoom
  const canvasX = (prevScrollX + pivotViewX) / prevZoom;
  const canvasY = (prevScrollY + pivotViewY) / prevZoom;

  applyZoom(z);

  // Scroll so that same canvas coord is under cursor after zoom
  canvasWrap.scrollLeft = canvasX * S.zoom - pivotViewX;
  canvasWrap.scrollTop  = canvasY * S.zoom - pivotViewY;
}

function updateZoomUI() {
  const pct = Math.round(S.zoom * 100) + '%';
  document.getElementById('zoom-display').textContent = pct;
  document.getElementById('sb-zoom').textContent = 'Zoom: ' + pct;
}

function zoomIn(pivotViewX, pivotViewY) {
  const next = ZOOM_STEPS.find(s => s > S.zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  if (pivotViewX !== undefined) applyZoomAroundPivot(next, pivotViewX, pivotViewY);
  else applyZoom(next);
}

function zoomOut(pivotViewX, pivotViewY) {
  const prev = [...ZOOM_STEPS].reverse().find(s => s < S.zoom - 0.001) ?? ZOOM_STEPS[0];
  if (pivotViewX !== undefined) applyZoomAroundPivot(prev, pivotViewX, pivotViewY);
  else applyZoom(prev);
}

function zoomFitWidth() {
  const pad = 48;
  const available = canvasWrap.clientWidth - pad * 2;
  applyZoom(available / baseCanvas.width);
  canvasWrap.scrollLeft = 0;
  canvasWrap.scrollTop  = 0;
}

function zoomFitPage() {
  const pad = 48;
  const availW = canvasWrap.clientWidth  - pad * 2;
  const availH = canvasWrap.clientHeight - pad * 2;
  applyZoom(Math.min(availW / baseCanvas.width, availH / baseCanvas.height));
  canvasWrap.scrollLeft = 0;
  canvasWrap.scrollTop  = 0;
}

function zoomActual() {
  // Zoom to 100% and centre
  applyZoom(1.0);
  const cx = Math.max(0, (baseCanvas.width  - canvasWrap.clientWidth)  / 2);
  const cy = Math.max(0, (baseCanvas.height - canvasWrap.clientHeight) / 2);
  canvasWrap.scrollLeft = cx;
  canvasWrap.scrollTop  = cy;
}

// ── History (annotation layer snapshots only — small) ─────────────────────
function pushHistory() {
  S.history.push(annoCanvas.toDataURL('image/png'));
  S.future = [];
  if (S.history.length > 50) S.history.shift();
}

function undo() {
  if (S.history.length <= 1) return;
  S.future.push(S.history.pop());
  restoreSnapshot(S.history[S.history.length - 1]);
}

function redo() {
  if (!S.future.length) return;
  const snap = S.future.pop();
  S.history.push(snap);
  restoreSnapshot(snap);
}

function restoreSnapshot(src) {
  const img = new Image();
  img.onload = () => {
    aCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
    aCtx.drawImage(img, 0, 0);
    dCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  };
  img.src = src;
}

function mergedCanvas() {
  const c = document.createElement('canvas');
  c.width = baseCanvas.width; c.height = baseCanvas.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(baseCanvas, 0, 0);
  ctx.drawImage(annoCanvas, 0, 0);
  return c;
}

// ── Bind ───────────────────────────────────────────────────────────────────
function bindAll() {
  // Tools
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn =>
    btn.addEventListener('click', () => selectTool(btn.dataset.tool))
  );

  // Colors
  document.querySelectorAll('.color-swatch').forEach(sw =>
    sw.addEventListener('click', () => selectColor(sw.dataset.color, sw))
  );
  document.getElementById('color-picker-input').addEventListener('input', e =>
    selectColor(e.target.value, null)
  );

  // Size
  const sizeSlider = document.getElementById('size-slider');
  sizeSlider.addEventListener('input', () => {
    S.size = parseInt(sizeSlider.value);
    document.getElementById('size-val').textContent = S.size;
    document.getElementById('sb-size').textContent = `Size: ${S.size}px`;
  });

  // Opacity
  const opacitySlider = document.getElementById('opacity-slider');
  opacitySlider.addEventListener('input', () => {
    S.opacity = parseInt(opacitySlider.value) / 100;
    document.getElementById('opacity-val').textContent = opacitySlider.value + '%';
  });

  // Undo/Redo
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);

  // Actions
  document.getElementById('btn-clear').addEventListener('click', clearAnnotations);
  document.getElementById('btn-copy-anno').addEventListener('click', copyAnnotated);
  document.getElementById('btn-save-anno').addEventListener('click', saveAnnotated);

  // Canvas drawing
  drawCanvas.addEventListener('mousedown',  onMouseDown);
  drawCanvas.addEventListener('mousemove',  onMouseMove);
  drawCanvas.addEventListener('mouseup',    onMouseUp);
  drawCanvas.addEventListener('mouseleave', onMouseLeave);
  drawCanvas.addEventListener('mousedown',  e => { if (e.button === 1) e.preventDefault(); });

  // Text overlay
  const ti = document.getElementById('text-input');
  ti.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
    if (e.key === 'Escape') cancelText();
  });
  ti.addEventListener('blur', commitText);

  // Zoom controls
  document.getElementById('btn-zoom-in').addEventListener('click', () => zoomIn());
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoomOut());
  document.getElementById('btn-zoom-fit-width').addEventListener('click', zoomFitWidth);
  document.getElementById('btn-zoom-fit-page').addEventListener('click', zoomFitPage);
  document.getElementById('btn-zoom-100').addEventListener('click', zoomActual);
  document.getElementById('zoom-display').addEventListener('click', zoomActual);

  // Wheel: Ctrl = zoom, plain = scroll (default), Shift = hscroll
  canvasWrap.addEventListener('wheel', onWheel, { passive: false });

  // Pan: MMB or Space+LMB on the wrap (not just the canvas)
  canvasWrap.addEventListener('mousedown', onWrapMouseDown);
  document.addEventListener('mousemove',   onWrapMouseMove);
  document.addEventListener('mouseup',     onWrapMouseUp);
  // Stop browser MMB scroll-cursor
  canvasWrap.addEventListener('mousedown', e => {
    if (e.button === 1) e.preventDefault();
  }, { capture: true });

  // Keyboard
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup',   onKeyUp);

  // Resize: clamp zoom to avoid overflow
  window.addEventListener('resize', () => applyZoom(S.zoom));
}

// ── Tool / Color ───────────────────────────────────────────────────────────
function selectTool(tool) {
  S.tool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool)
  );
  document.getElementById('sb-tool').textContent =
    'Tool: ' + tool.charAt(0).toUpperCase() + tool.slice(1);
  drawCanvas.style.cursor = tool === 'eraser' ? 'cell' : tool === 'text' ? 'text' : 'crosshair';
}

function selectColor(hex, swatchEl) {
  S.color = hex;
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
  if (swatchEl) swatchEl.classList.add('active');
  document.getElementById('sb-color-dot').style.background = hex;
  document.getElementById('sb-color').lastChild.textContent = ' ' + hex;
  document.getElementById('color-picker-input').value = hex;
}

// ── Canvas coords (accounts for CSS zoom) ─────────────────────────────────
function getPos(e) {
  const r = drawCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / S.zoom,
    y: (e.clientY - r.top)  / S.zoom,
  };
}

// ── Draw events ────────────────────────────────────────────────────────────
function onMouseDown(e) {
  if (e.button !== 0) return;
  if (S.spaceDown) return;
  const { x, y } = getPos(e);
  S.drawing = true;
  S.startX = x; S.startY = y; S.lastX = x; S.lastY = y;

  if (S.tool === 'text') {
    S.drawing = false;
    showTextOverlay(e.clientX, e.clientY, x, y);
    return;
  }
  if (S.tool === 'pen') {
    dCtx.beginPath();
    dCtx.moveTo(x, y);
  } else if (S.tool === 'eraser') {
    eraseStroke(x, y);
  }
}

function onMouseMove(e) {
  const { x, y } = getPos(e);
  document.getElementById('sb-pos').textContent = `${Math.round(x)}, ${Math.round(y)}`;
  if (!S.drawing) return;

  if (S.tool === 'pen') {
    drawPenStroke(x, y);
  } else if (S.tool === 'eraser') {
    eraseStroke(x, y);
  } else {
    dCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    drawShape(dCtx, S.startX, S.startY, x, y, false);
  }
  S.lastX = x; S.lastY = y;
}

function onMouseUp(e) {
  if (!S.drawing) return;
  S.drawing = false;
  const { x, y } = getPos(e);
  commitStroke(x, y);
}

function onMouseLeave() {
  if (!S.drawing) return;
  S.drawing = false;
  commitStroke(S.lastX, S.lastY);
}

// Commit the in-progress action to the annotation layer + push undo state
function commitStroke(x, y) {
  if (S.tool === 'pen') {
    aCtx.drawImage(drawCanvas, 0, 0);
    dCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  } else if (S.tool === 'eraser') {
    // strokes were applied to the anno layer live — nothing to merge
  } else {
    dCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    drawShape(aCtx, S.startX, S.startY, x, y, true);
  }
  pushHistory();
}

// ── Draw primitives ────────────────────────────────────────────────────────
function drawPenStroke(x, y) {
  dCtx.save();
  dCtx.globalAlpha = S.opacity;
  dCtx.globalCompositeOperation = 'source-over';
  dCtx.strokeStyle = S.color;
  dCtx.lineWidth   = S.size;
  dCtx.lineCap     = 'round';
  dCtx.lineJoin    = 'round';
  dCtx.lineTo(x, y);
  dCtx.stroke();
  dCtx.restore();
}

function eraseStroke(x, y) {
  aCtx.save();
  aCtx.globalCompositeOperation = 'destination-out';
  aCtx.globalAlpha = 1;
  aCtx.lineCap = 'round';
  aCtx.lineWidth = S.size * 4;
  aCtx.beginPath();
  aCtx.moveTo(S.lastX, S.lastY);
  aCtx.lineTo(x, y);
  aCtx.stroke();
  aCtx.beginPath();
  aCtx.arc(x, y, S.size * 2, 0, Math.PI * 2);
  aCtx.fill();
  aCtx.restore();
}

function drawShape(ctx, x1, y1, x2, y2, final) {
  ctx.save();
  ctx.globalAlpha = S.opacity;
  ctx.strokeStyle = S.color;
  ctx.fillStyle   = S.color;
  ctx.lineWidth   = S.size;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  switch (S.tool) {
    case 'line':
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); break;
    case 'arrow':
      drawArrow(ctx, x1, y1, x2, y2); break;
    case 'rect':
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1); break;
    case 'ellipse': {
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      ctx.beginPath();
      ctx.ellipse(x1 + (x2-x1)/2, y1 + (y2-y1)/2, rx, ry, 0, 0, Math.PI*2);
      ctx.stroke(); break;
    }
    case 'highlight':
      ctx.globalAlpha = Math.min(S.opacity, 0.35);
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1); break;
    case 'blur':
      if (final) blurRegion(x1, y1, x2, y2);
      else {
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x1, y1, x2-x1, y2-y1);
        ctx.setLineDash([]);
      }
      break;
  }
  ctx.restore();
}

function drawArrow(ctx, x1, y1, x2, y2) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head  = Math.max(12, S.size * 4);
  const ang   = Math.PI / 6;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - ang), y2 - head * Math.sin(angle - ang));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle + ang), y2 - head * Math.sin(angle + ang));
  ctx.stroke();
}

// Pixelates a region of the merged image (base + annotations) onto the
// annotation layer, so it undoes like any other annotation.
function blurRegion(x1, y1, x2, y2) {
  const rx = Math.round(Math.min(x1,x2)), ry = Math.round(Math.min(y1,y2));
  const rw = Math.round(Math.abs(x2-x1)), rh = Math.round(Math.abs(y2-y1));
  if (rw < 4 || rh < 4) return;
  const merged = mergedCanvas();
  const offW = Math.max(1, Math.round(rw / 14));
  const offH = Math.max(1, Math.round(rh / 14));
  const off  = document.createElement('canvas');
  off.width = offW; off.height = offH;
  const offCtx = off.getContext('2d');
  offCtx.drawImage(merged, rx, ry, rw, rh, 0, 0, offW, offH);
  aCtx.save();
  aCtx.globalAlpha = 1;
  aCtx.imageSmoothingEnabled = false;
  aCtx.drawImage(off, 0, 0, offW, offH, rx, ry, rw, rh);
  aCtx.restore();
}

// ── Text ───────────────────────────────────────────────────────────────────
function showTextOverlay(clientX, clientY, canvasX, canvasY) {
  S.textPos = { canvasX, canvasY };
  const wrap  = document.getElementById('text-overlay');
  const input = document.getElementById('text-input');
  wrap.style.display = 'block';
  wrap.style.left = clientX + 'px';
  wrap.style.top  = clientY + 'px';
  input.style.color    = S.color;
  input.style.fontSize = Math.max(14, S.size * 4) + 'px';
  input.value = '';
  input.focus();
}

function commitText() {
  const input = document.getElementById('text-input');
  const text  = input.value.trim();
  if (text && S.textPos) {
    const fs = Math.max(14, S.size * 4);
    aCtx.save();
    aCtx.globalAlpha  = S.opacity;
    aCtx.fillStyle    = S.color;
    aCtx.font         = `bold ${fs}px 'Syne', sans-serif`;
    aCtx.textBaseline = 'top';
    text.split('\n').forEach((line, i) =>
      aCtx.fillText(line, S.textPos.canvasX, S.textPos.canvasY + i * (fs + 4))
    );
    aCtx.restore();
    pushHistory();
  }
  cancelText();
}

function cancelText() {
  document.getElementById('text-overlay').style.display = 'none';
  S.textPos = null;
}

// ── Actions ────────────────────────────────────────────────────────────────
function clearAnnotations() {
  if (!confirm('Clear all annotations?')) return;
  aCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
  dCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  pushHistory();
}

async function copyAnnotated() {
  mergedCanvas().toBlob(async blob => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('✓ Copied to clipboard');
    } catch { showToast('⚠ Clipboard write failed'); }
  });
}

function saveAnnotated() {
  const dataUrl  = mergedCanvas().toDataURL('image/png');
  const now      = new Date();
  const filename = `pagesnap_annotated_${now.toISOString().slice(0,10)}_${now.toTimeString().slice(0,8).replace(/:/g,'-')}.png`;
  // chrome.downloads requires a blob: URL, not a data: URI
  fetch(dataUrl).then(r => r.blob()).then(blob => {
    const blobUrl = URL.createObjectURL(blob);
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, () => {
      showToast('✓ Saved: ' + filename);
      // Revoke after a short delay to let the download start
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    });
  });
  // Persist the annotated image back to IndexedDB (metadata flag in storage)
  if (S.imageEntry?.id) {
    PSDB.put(S.imageEntry.id, dataUrl).catch(() => {});
    chrome.storage.local.get('history', ({ history = [] }) => {
      const idx = history.findIndex(h => h.id === S.imageEntry.id);
      if (idx >= 0) {
        history[idx].annotated = true;
        history[idx].format = 'png';
        chrome.storage.local.set({ history });
      }
    });
  }
}

// ── Wheel zoom ─────────────────────────────────────────────────────────────
function onWheel(e) {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const rect = canvasWrap.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  if (e.deltaY < 0) zoomIn(px, py);
  else              zoomOut(px, py);
}

// ── Pan (MMB or Space+LMB) ─────────────────────────────────────────────────
function startPan(e) {
  S.panning    = true;
  S.panStartX  = e.clientX;
  S.panStartY  = e.clientY;
  S.panScrollX = canvasWrap.scrollLeft;
  S.panScrollY = canvasWrap.scrollTop;
  canvasWrap.style.cursor = 'grabbing';
  e.preventDefault();
}

function onWrapMouseDown(e) {
  if (e.button === 1) { startPan(e); return; }
  if (e.button === 0 && S.spaceDown) { startPan(e); return; }
}

function onWrapMouseMove(e) {
  if (!S.panning) return;
  canvasWrap.scrollLeft = S.panScrollX - (e.clientX - S.panStartX);
  canvasWrap.scrollTop  = S.panScrollY - (e.clientY - S.panStartY);
}

function onWrapMouseUp() {
  if (!S.panning) return;
  S.panning = false;
  canvasWrap.style.cursor = S.spaceDown ? 'grab' : '';
}

// ── Keyboard ───────────────────────────────────────────────────────────────
function onKeyDown(e) {
  if (e.target === document.getElementById('text-input')) return;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (mod && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); return; }
  if (mod && e.key === 's') { e.preventDefault(); saveAnnotated(); return; }
  if (mod && e.key === 'c' && !e.shiftKey) { copyAnnotated(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn(); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoomOut(); return; }
  if (mod && e.key === '0') { e.preventDefault(); zoomActual(); return; }
  if (!mod && (e.key === 'w' || e.key === 'W')) { zoomFitWidth(); return; }
  if (!mod && (e.key === 'f' || e.key === 'F')) { zoomFitPage(); return; }
  if (!mod && e.key === '1') { zoomActual(); return; }

  if (e.code === 'Space' && !S.spaceDown) {
    S.spaceDown = true;
    canvasWrap.style.cursor = 'grab';
    e.preventDefault(); return;
  }

  if (!mod) {
    const map = { p:'pen', l:'line', a:'arrow', r:'rect', e:'ellipse', t:'text', b:'blur', h:'highlight', x:'eraser' };
    if (map[e.key.toLowerCase()]) selectTool(map[e.key.toLowerCase()]);
  }
}

function onKeyUp(e) {
  if (e.code === 'Space') {
    S.spaceDown = false; S.panning = false;
    canvasWrap.style.cursor = '';
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────
let _tt;
function showToast(msg, dur = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove('show'), dur);
}
