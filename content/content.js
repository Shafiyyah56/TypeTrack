'use strict';

// ── State ────────────────────────────────────────────────────
let isActive            = false;
let startTime           = null;   // wall-clock time of the first keystroke
let stopTime            = null;   // wall-clock time measurement was stopped
let totalChars          = 0;      // printable characters typed (no backspaces)
let backspaces          = 0;      // Backspace / Delete presses
let pastedChars         = 0;      // Characters pasted — tracked separately, NOT counted toward WPM
let peakWpm             = 0;

// Active-time tracking — clock pauses after IDLE_THRESHOLD_MS of no input
let accumulatedActiveMs = 0;   // ms from fully completed active bursts
let burstStart          = null; // start of the current burst; null when idle
let idleTimer           = null;

const IDLE_THRESHOLD_MS = 2000;
let broadcastTimer      = null;
let overlay             = null;   // floating on-page stats widget
let iframeObserver      = null;   // MutationObserver watching for newly-added iframes

// ── Context detection ────────────────────────────────────────
function isTypingContext(target) {
  if (!target || !(target instanceof Element)) return false;

  // Standard textarea (also catches Google Docs' hidden capture textarea)
  if (target.tagName === 'TEXTAREA') return true;

  if (target.tagName === 'INPUT') {
    const type = (target.type || 'text').toLowerCase();
    return ['text', 'password', 'email', 'search', 'url', 'tel', 'number'].includes(type);
  }

  // Native contenteditable (Quill, ProseMirror, Trix, etc.)
  if (target.isContentEditable) return true;

  // Explicit ARIA textbox / combobox roles used by Notion, Confluence, Slack, etc.
  const role = target.getAttribute('role');
  if (role === 'textbox' || role === 'combobox') return true;

  // Catch child nodes inside a contenteditable container
  if (target.closest?.('[contenteditable="true"]')) return true;

  return false;
}

// Google Docs uses a canvas-rendered editor whose internal class names
// change with product updates.  Rather than chasing class names, we key
// off the hostname: if we're on docs.google.com (or slides / sheets) and
// the user has focused anything other than the bare document body, they
// are editing and we should count their keystrokes.
function isGoogleDocsActive() {
  const host = window.location.hostname;
  if (!host.endsWith('google.com')) return false;
  // Cover Docs, Sheets, Slides, and Drive-embedded editors
  if (!/\/(document|spreadsheets|presentation|forms)\//.test(window.location.pathname)) return false;
  const active = document.activeElement;
  // body / documentElement means nothing specific is focused — skip.
  // An <iframe> element being active means the user is working inside that
  // iframe, which is exactly the case for the Google Docs tab-based editor.
  return !!(active && active !== document.body && active !== document.documentElement);
}

// Ignore any Ctrl+key or Cmd+key shortcut
function isShortcut(e) {
  return e.ctrlKey || e.metaKey;
}

const IGNORED_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'PrintScreen',
  'ScrollLock', 'Pause', 'ContextMenu', 'Dead', 'Unidentified',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
]);

// ── Active-time helpers ──────────────────────────────────────

// Called when the 2s idle timer fires
function onIdle() {
  if (burstStart !== null) {
    accumulatedActiveMs += Date.now() - burstStart;
    burstStart = null;
  }
  idleTimer = null;
}

function getActiveTimeMs() {
  return burstStart !== null
    ? accumulatedActiveMs + (Date.now() - burstStart)
    : accumulatedActiveMs;
}

// Reset the 2s idle countdown on every relevant key event
function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(onIdle, IDLE_THRESHOLD_MS);
}

// ── Keydown handler ──────────────────────────────────────────
function handleKeyDown(event) {
  if (!isActive) return;
  // Ignore auto-repeated events fired while a key is held down
  if (event.repeat) return;
  // event.target is the element the browser dispatched to.
  // In Google Docs (and similar canvas-rendered editors) that is a div or
  // canvas tile, NOT a standard input.  Fall back to document.activeElement,
  // which in the main frame will be the <iframe> element when the editor
  // iframe is focused — that still satisfies isGoogleDocsActive().
  const typingTarget = isTypingContext(event.target)
    ? event.target
    : document.activeElement;
  if (!isTypingContext(typingTarget) && !isGoogleDocsActive()) return;
  if (IGNORED_KEYS.has(event.key)) return;

  // Block all Ctrl/Cmd shortcuts (Ctrl+C, Ctrl+V, Cmd+Z, etc.)
  if (isShortcut(event)) return;

  // Backspace / Delete: track separately, still reset the idle clock
  if (event.key === 'Backspace' || event.key === 'Delete') {
    backspaces++;
    resetIdleTimer();
    return;
  }

  // Printable character (single char) or Enter
  if (event.key.length === 1 || event.key === 'Enter') {
    if (!startTime) {
      // First keystroke ever: start both the wall clock and the first burst
      startTime  = Date.now();
      burstStart = startTime;
    } else if (burstStart === null) {
      // Typing resumes after an idle gap
      burstStart = Date.now();
    }
    totalChars++;
    resetIdleTimer();
  }
}

// ── Paste handler ────────────────────────────────────────────
// Paste is tracked separately and is intentionally excluded from WPM/CPM.
// We listen in capture phase so we see it before the page processes it.
function handlePaste(event) {
  if (!isActive) return;
  // Use same target-resolution pattern as handleKeyDown so paste works
  // in iframes (e.g. Google Docs editor iframe) as well as the main frame.
  const target = isTypingContext(event.target) ? event.target : document.activeElement;
  if (!isTypingContext(target) && !isGoogleDocsActive()) return;

  const text = event.clipboardData?.getData('text') ?? '';
  if (text.length > 0) {
    pastedChars += text.length;
    // A paste counts as activity — keep the idle clock alive
    resetIdleTimer();
  }
}

// ── Iframe coverage ───────────────────────────────────────────
// Google Docs (and some other editors) render their editing surface inside a
// same-origin sandboxed iframe.  Chrome does NOT inject content scripts into
// sandboxed iframes, so we bridge the gap by attaching our capture-phase
// listeners directly to each iframe's contentDocument from the main frame.
// This works because the sandbox includes allow-same-origin.

function attachToIframe(iframeEl) {
  try {
    const doc = iframeEl.contentDocument;
    if (!doc) return;
    // addEventListener is idempotent for identical listener+options pairs,
    // so calling this more than once on the same iframe is safe.
    doc.addEventListener('keydown', handleKeyDown, true);
    doc.addEventListener('paste',   handlePaste,   true);
  } catch (_) {
    // Cross-origin iframes will throw — silently skip them.
  }
}

function detachFromIframe(iframeEl) {
  try {
    const doc = iframeEl.contentDocument;
    if (!doc) return;
    doc.removeEventListener('keydown', handleKeyDown, true);
    doc.removeEventListener('paste',   handlePaste,   true);
  } catch (_) {}
}

function startIframeWatcher() {
  // Attach to every iframe that is already in the DOM.
  document.querySelectorAll('iframe').forEach(f => {
    attachToIframe(f);
    // Re-attach if the iframe navigates (its contentDocument is replaced).
    f.addEventListener('load', () => attachToIframe(f));
  });

  // Watch for iframes inserted after page load (Google Docs creates its editor
  // iframe dynamically, so this observer fires before the user starts typing).
  iframeObserver = new MutationObserver(mutations => {
    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (node.nodeName === 'IFRAME') {
          attachToIframe(node);
          node.addEventListener('load', () => attachToIframe(node));
        }
        // Subtrees added in bulk (e.g. innerHTML swap) may contain iframes.
        if (node.querySelectorAll) {
          node.querySelectorAll('iframe').forEach(f => {
            attachToIframe(f);
            f.addEventListener('load', () => attachToIframe(f));
          });
        }
      }
    }
  });
  iframeObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function stopIframeWatcher() {
  if (iframeObserver) {
    iframeObserver.disconnect();
    iframeObserver = null;
  }
  document.querySelectorAll('iframe').forEach(detachFromIframe);
}

// ── Stats snapshot ───────────────────────────────────────────
function getStats() {
  const activeMs   = getActiveTimeMs();
  const activeMins = activeMs / 60_000;

  // WPM  = (chars / 5) / active-minutes  (standard gross WPM)
  // CPM  = chars / active-minutes
  const wpm = activeMins > 0 ? Math.round((totalChars / 5) / activeMins) : 0;
  const cpm = activeMins > 0 ? Math.round(totalChars / activeMins)       : 0;

  if (wpm > peakWpm) peakWpm = wpm;

  // Wall-clock elapsed (for the footer "Elapsed" display)
  let wallElapsed = 0;
  if (startTime) {
    const end = isActive ? Date.now() : (stopTime ?? Date.now());
    wallElapsed = Math.floor((end - startTime) / 1000);
  }

  return {
    isActive,
    wpm,
    cpm,
    totalChars,
    backspaces,
    pastedChars,
    elapsedTime: wallElapsed,               // wall clock seconds (for "Elapsed" chip)
    activeTime:  Math.floor(activeMs / 1000), // net active seconds (for session storage)
    peakWpm,
    hasData: startTime !== null,
  };
}

// ── Session persistence ───────────────────────────────────────
async function saveSession(stats) {
  if (stats.totalChars === 0) return; // nothing typed — skip

  const session = {
    id:         Date.now(),
    timestamp:  new Date().toISOString(),
    domain:     window.location.hostname || 'unknown',
    duration:   stats.activeTime,   // active typing seconds
    avgWPM:     stats.wpm,
    avgCPM:     stats.cpm,
    totalChars:  stats.totalChars,
    backspaces:  stats.backspaces,
    pastedChars: stats.pastedChars,
  };

  try {
    const { sessions = [] } = await chrome.storage.local.get('sessions');
    sessions.unshift(session);
    if (sessions.length > 10) sessions.length = 10;
    await chrome.storage.local.set({ sessions });
  } catch (err) {
    console.error('[Typing Speed Meter] Failed to save session:', err);
  }
}

// ── Floating on-page overlay ──────────────────────────────────
// The Chrome popup closes the instant you click on the page, so we inject a
// small draggable widget directly into the page so the user can see live
// WPM / CPM while they type without needing the popup open.

function createOverlay() {
  if (overlay || document.getElementById('__tsm__')) return;

  overlay = document.createElement('div');
  overlay.id = '__tsm__';
  // Inline host styles so the page cannot override them
  overlay.setAttribute('style',
    'all:initial;position:fixed;bottom:24px;right:24px;z-index:2147483647;'
  );

  // Shadow DOM isolates our styles from the host page completely
  const shadow = overlay.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .box {
        background: rgba(15,14,23,0.93);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(124,58,237,0.4);
        border-radius: 14px;
        padding: 12px 16px 10px;
        color: #fffffe;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        cursor: move;
        min-width: 130px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      }
      .head {
        display: flex; align-items: center;
        justify-content: space-between; margin-bottom: 9px;
      }
      .title {
        font-size: 9px; font-weight: 700; letter-spacing: 1px;
        text-transform: uppercase; color: #5c5b72;
        display: flex; align-items: center; gap: 5px;
      }
      .dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #10b981; flex-shrink: 0;
        animation: p 1.6s ease-in-out infinite;
      }
      @keyframes p {
        0%,100% { box-shadow: 0 0 0 0   rgba(16,185,129,.6); }
        50%      { box-shadow: 0 0 0 4px rgba(16,185,129,0);  }
      }
      button {
        all: unset; color: #3d3c52; cursor: pointer;
        font-size: 18px; line-height: 1; padding: 0 0 0 8px;
      }
      button:hover { color: #f87171; }
      .metrics { display: flex; align-items: center; gap: 12px; }
      .metric  { text-align: center; flex: 1; }
      .val {
        font-size: 28px; font-weight: 800; line-height: 1;
        font-variant-numeric: tabular-nums;
      }
      .val.w { color: #a78bfa; }
      .val.c { color: #60a5fa; }
      .lbl {
        font-size: 8px; font-weight: 700; letter-spacing: 1.2px;
        text-transform: uppercase; color: #3d3c52; margin-top: 3px;
      }
      .sep { width: 1px; height: 30px; background: rgba(255,255,255,.07); flex-shrink: 0; }
    </style>
    <div class="box">
      <div class="head">
        <span class="title"><span class="dot"></span>Typing Speed</span>
        <button id="cls">&#215;</button>
      </div>
      <div class="metrics">
        <div class="metric"><div class="val w" id="ov-w">0</div><div class="lbl">WPM</div></div>
        <div class="sep"></div>
        <div class="metric"><div class="val c" id="ov-c">0</div><div class="lbl">CPM</div></div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // Close button
  shadow.getElementById('cls').addEventListener('click', removeOverlay);

  // Drag to reposition
  let drag = false, ox = 0, oy = 0;
  shadow.querySelector('.box').addEventListener('mousedown', e => {
    if (e.target.id === 'cls') return;
    drag = true;
    const r = overlay.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    overlay.style.bottom = 'auto';
    overlay.style.right  = 'auto';
    overlay.style.left   = r.left + 'px';
    overlay.style.top    = r.top  + 'px';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    overlay.style.left = (e.clientX - ox) + 'px';
    overlay.style.top  = (e.clientY - oy) + 'px';
  });
  document.addEventListener('mouseup', () => { drag = false; });
}

function updateOverlay(stats) {
  if (!overlay) return;
  const s = overlay.shadowRoot;
  if (!s) return;
  s.getElementById('ov-w').textContent = stats.hasData ? stats.wpm : '0';
  s.getElementById('ov-c').textContent = stats.hasData ? stats.cpm : '0';
}

function removeOverlay() {
  if (overlay) { overlay.remove(); overlay = null; }
}

// ── Push live stats to popup ─────────────────────────────────
function broadcastStats() {
  const stats = getStats();
  updateOverlay(stats);   // keep the on-page widget in sync
  // sendMessage rejects silently when the popup is closed
  chrome.runtime.sendMessage({ type: 'statsUpdate', ...stats }).catch(() => {});
}

// ── Message listener (commands from popup) ───────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {

    case 'start':
      isActive            = true;
      startTime           = null;
      stopTime            = null;
      totalChars          = 0;
      backspaces          = 0;
      pastedChars         = 0;
      peakWpm             = 0;
      accumulatedActiveMs = 0;
      burstStart          = null;
      clearTimeout(idleTimer);
      idleTimer           = null;

      document.addEventListener('keydown', handleKeyDown, true);
      document.addEventListener('paste',   handlePaste,   true);
      startIframeWatcher();

      createOverlay();

      clearInterval(broadcastTimer);
      broadcastTimer = setInterval(broadcastStats, 250);

      sendResponse({ success: true, ...getStats() });
      break;

    case 'stop': {
      isActive = false;
      stopTime = startTime ? Date.now() : null;

      // Finalize the active-time accumulator
      clearTimeout(idleTimer);
      idleTimer = null;
      if (burstStart !== null) {
        accumulatedActiveMs += Date.now() - burstStart;
        burstStart = null;
      }

      clearInterval(broadcastTimer);
      broadcastTimer = null;
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('paste',   handlePaste,   true);
      stopIframeWatcher();
      removeOverlay();

      const finalStats = getStats();
      saveSession(finalStats); // async fire-and-forget
      sendResponse(finalStats);
      break;
    }

    case 'getStats':
      sendResponse(getStats());
      break;
  }

  return true; // keep message channel open for async sendResponse
});
