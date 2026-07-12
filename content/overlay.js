// PageSnap - Recording Overlay (injected into tab being recorded)
(function () {
  'use strict';

  // Don't inject twice
  if (document.getElementById('pagesnap-overlay')) return;

  // ── Build overlay UI ────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'pagesnap-overlay';
  overlay.setAttribute('data-pagesnap', 'true');

  overlay.innerHTML = `
    <div id="pso-countdown" style="display:none">
      <span id="pso-countdown-num">3</span>
      <span id="pso-countdown-label">Recording starts…</span>
    </div>
    <div id="pso-inner" style="display:none">
      <span id="pso-dot"></span>
      <span id="pso-timer">00:00</span>
      <button id="pso-pause" title="Pause / Resume">
        <svg id="pso-pause-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="3" y="2" width="3" height="10" rx="1" fill="white"/>
          <rect x="8" y="2" width="3" height="10" rx="1" fill="white"/>
        </svg>
        <svg id="pso-resume-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" style="display:none">
          <path d="M3 2l9 5-9 5V2z" fill="white"/>
        </svg>
      </button>
      <button id="pso-stop" title="Stop Recording">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="2" y="2" width="10" height="10" rx="2" fill="white"/>
        </svg>
      </button>
    </div>
  `;

  // ── Styles ──────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.id = 'pagesnap-overlay-style';
  style.textContent = `
    #pagesnap-overlay {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      font-family: 'DM Mono', 'Courier New', monospace;
      pointer-events: auto;
      user-select: none;
    }

    #pso-inner {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(14, 15, 17, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 999px;
      padding: 8px 14px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.2);
      transition: opacity 200ms ease;
    }

    #pso-inner:hover { opacity: 1 !important; }

    #pso-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ff4466;
      flex-shrink: 0;
      transition: background 300ms;
    }

    #pso-dot.recording {
      animation: pso-pulse 1s ease infinite;
      box-shadow: 0 0 6px #ff4466;
    }

    #pso-dot.paused {
      background: #FFBE00;
      animation: none;
      box-shadow: 0 0 6px #FFBE00;
    }

    @keyframes pso-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    #pso-timer {
      color: #f0f0f2;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.05em;
      min-width: 38px;
    }

    #pso-pause, #pso-stop {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 50%;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 150ms ease, border-color 150ms ease;
      padding: 0;
      flex-shrink: 0;
    }

    #pso-pause:hover { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.3); }
    #pso-stop:hover  { background: rgba(255,68,102,0.3); border-color: #ff4466; }

    /* Countdown */
    #pso-countdown {
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      background: rgba(14,15,17,.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,68,102,.3);
      border-radius: 16px;
      padding: 16px 24px;
      box-shadow: 0 4px 24px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.2);
      text-align: center;
    }
    #pso-countdown-num {
      font-size: 48px; font-weight: 800; color: #ff4466;
      line-height: 1; font-family: 'Syne', system-ui, sans-serif;
      text-shadow: 0 0 20px rgba(255,68,102,.5);
    }
    #pso-countdown-label {
      font-size: 11px; color: rgba(240,240,242,.6);
      font-family: 'DM Mono', monospace; letter-spacing: .05em;
    }

    /* Drag handle cursor on inner */
    #pso-inner { cursor: grab; }
    #pso-inner:active { cursor: grabbing; }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);

  // ── State ────────────────────────────────────────────────────────────────────
  let timerInterval = null;
  let startTime = 0;
  let totalPausedMs = 0;
  let pausedAt = 0;
  let isPaused = false;

  const dot = document.getElementById('pso-dot');
  const timer = document.getElementById('pso-timer');
  const pauseBtn = document.getElementById('pso-pause');
  const stopBtn = document.getElementById('pso-stop');
  const pauseIcon = document.getElementById('pso-pause-icon');
  const resumeIcon = document.getElementById('pso-resume-icon');

  // ── Timer ─────────────────────────────────────────────────────────────────────
  function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (isPaused) return;
      const elapsed = Date.now() - startTime - totalPausedMs;
      timer.textContent = formatDuration(elapsed);
    }, 500);
  }

  function formatDuration(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
  }

  // ── Set visual state ──────────────────────────────────────────────────────────
  function setRecording() {
    isPaused = false;
    dot.className = 'recording';
    pauseIcon.style.display = '';
    resumeIcon.style.display = 'none';
    startTimer();
  }

  function setPaused(elapsed) {
    isPaused = true;
    clearInterval(timerInterval);
    dot.className = 'paused';
    pauseIcon.style.display = 'none';
    resumeIcon.style.display = '';
    if (elapsed !== undefined) timer.textContent = formatDuration(elapsed);
  }

  // ── Buttons ───────────────────────────────────────────────────────────────────
  pauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'OVERLAY_PAUSE_CLICKED' });
  });

  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'OVERLAY_STOP_CLICKED' });
  });

  // ── Draggable ─────────────────────────────────────────────────────────────────
  const inner = document.getElementById('pso-inner');
  let dragging = false;
  let dragOffX = 0, dragOffY = 0;

  inner.addEventListener('mousedown', (e) => {
    if (e.target === pauseBtn || e.target === stopBtn || pauseBtn.contains(e.target) || stopBtn.contains(e.target)) return;
    dragging = true;
    const rect = overlay.getBoundingClientRect();
    dragOffX = e.clientX - rect.left;
    dragOffY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = e.clientX - dragOffX;
    const y = e.clientY - dragOffY;
    overlay.style.left = x + 'px';
    overlay.style.right = 'auto';
    overlay.style.top = y + 'px';
    overlay.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => { dragging = false; });

  // ── Countdown ─────────────────────────────────────────────────────────────
  const countdownEl    = document.getElementById('pso-countdown');
  const countdownNum   = document.getElementById('pso-countdown-num');
  const innerEl        = document.getElementById('pso-inner');

  function showCountdown(n) {
    countdownEl.style.display = 'flex';
    innerEl.style.display     = 'none';
    countdownNum.textContent  = n;
  }

  function hideCountdown() {
    countdownEl.style.display = 'none';
    innerEl.style.display     = 'flex';
  }

  // ── Listen for state from service worker ────────────────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'OVERLAY_STATE') {
      if (message.status === 'countdown') {
        showCountdown(message.n ?? 3);
      } else if (message.status === 'recording') {
        hideCountdown();
        startTime = message.startTime || Date.now();
        totalPausedMs = message.totalPausedMs || 0;
        setRecording();
      } else if (message.status === 'paused') {
        hideCountdown();
        setPaused(message.elapsed);
      }
    } else if (message.action === 'OVERLAY_REMOVE') {
      clearInterval(timerInterval);
      overlay.remove();
      style.remove();
    }
  });

  // ── Request current state on inject ──────────────────────────────────────────
  chrome.runtime.sendMessage({ action: 'OVERLAY_GET_STATE' });

})();
