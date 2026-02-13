'use strict';

// ── State ────────────────────────────────────────────────────
let isActive = false;

// ── DOM references ───────────────────────────────────────────
const statusDot     = document.getElementById('statusDot');
const statusLabel   = document.getElementById('statusLabel');
const wpmValue      = document.getElementById('wpmValue');
const cpmValue      = document.getElementById('cpmValue');
const keystrokesVal = document.getElementById('keystrokesValue');
const backspacesVal = document.getElementById('backspacesValue');
const pastedVal     = document.getElementById('pastedValue');
const peakVal       = document.getElementById('peakValue');
const elapsedVal    = document.getElementById('elapsedValue');
const toggleBtn     = document.getElementById('toggleBtn');
const wpmCard       = document.querySelector('.wpm-card');
const cpmCard       = document.querySelector('.cpm-card');

// History panel
const tabLive       = document.getElementById('tabLive');
const tabHistory    = document.getElementById('tabHistory');
const panelLive     = document.getElementById('panelLive');
const panelHistory  = document.getElementById('panelHistory');
const sessionsList  = document.getElementById('sessionsList');
const sessionsEmpty = document.getElementById('sessionsEmpty');
const sessionsCount = document.getElementById('sessionsCount');
const clearBtn      = document.getElementById('clearSessions');

// ── Helpers ──────────────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(action) {
  const tab = await getActiveTab();
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { action });
  } catch {
    return null;
  }
}

function formatElapsed(secs) {
  if (!secs || secs < 1) return '0s';
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function relativeTime(isoString) {
  const diffMs   = Date.now() - new Date(isoString).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins <  1)    return 'Just now';
  if (diffMins <  60)   return `${diffMins}m ago`;
  if (diffMins < 1440)  return `${Math.floor(diffMins / 60)}h ago`;
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Live panel — UI updates ───────────────────────────────────
function setActiveState(active) {
  isActive = active;

  statusDot.classList.toggle('active', active);
  statusLabel.classList.toggle('active', active);
  statusLabel.textContent = active ? 'Measuring\u2026' : 'Not measuring';

  wpmCard.classList.toggle('active', active);
  cpmCard.classList.toggle('active', active);

  if (active) {
    toggleBtn.className = 'btn btn-stop';
    toggleBtn.innerHTML = `
      <svg class="btn-icon" viewBox="0 0 16 16" fill="currentColor">
        <rect x="3" y="3" width="10" height="10" rx="1.5"/>
      </svg>
      Stop Measuring`;
  } else {
    toggleBtn.className = 'btn btn-start';
    toggleBtn.innerHTML = `
      <svg class="btn-icon" viewBox="0 0 16 16" fill="currentColor">
        <path d="M4 2.5v11l9-5.5z"/>
      </svg>
      Start Measuring`;
  }
}

function updateStats(data) {
  if (!data) return;
  const hasTyped = data.hasData || data.totalChars > 0;

  wpmValue.textContent = hasTyped ? data.wpm   : '\u2014';
  cpmValue.textContent = hasTyped ? data.cpm   : '\u2014';

  keystrokesVal.textContent = data.totalChars  ?? 0;
  backspacesVal.textContent = data.backspaces  ?? 0;
  pastedVal.textContent     = data.pastedChars ?? 0;
  peakVal.textContent       = data.peakWpm > 0 ? data.peakWpm : '\u2014';
  elapsedVal.textContent    = formatElapsed(data.elapsedTime ?? 0);
}

// ── History panel ─────────────────────────────────────────────
function renderSessions(sessions) {
  const count = sessions ? sessions.length : 0;
  sessionsCount.textContent = count === 1 ? '1 session' : `${count} sessions`;

  if (count === 0) {
    sessionsEmpty.classList.remove('hidden');
    sessionsList.innerHTML = '';
    return;
  }

  sessionsEmpty.classList.add('hidden');
  sessionsList.innerHTML = sessions.map(s => `
    <div class="session-item">
      <div class="session-row session-top">
        <span class="session-domain">${escapeHtml(s.domain)}</span>
        <span class="session-chips">
          <span class="chip chip-wpm">${s.avgWPM} WPM</span>
          <span class="chip chip-cpm">${s.avgCPM} CPM</span>
        </span>
      </div>
      <div class="session-row">
        <span class="session-date">${relativeTime(s.timestamp)}</span>
        <span class="session-meta-right">${formatElapsed(s.duration)} &middot; ${s.backspaces}&#9003; &middot; ${s.pastedChars ?? 0}&#8629;</span>
      </div>
    </div>
  `).join('');
}

async function loadSessions() {
  try {
    const { sessions = [] } = await chrome.storage.local.get('sessions');
    renderSessions(sessions);
  } catch {
    renderSessions([]);
  }
}

// ── Tab switching ─────────────────────────────────────────────
function showTab(tab) {
  const live = tab === 'live';
  panelLive.classList.toggle('hidden', !live);
  panelHistory.classList.toggle('hidden', live);
  tabLive.classList.toggle('active', live);
  tabHistory.classList.toggle('active', !live);
  tabLive.setAttribute('aria-selected', live);
  tabHistory.setAttribute('aria-selected', !live);
  if (!live) loadSessions();
}

tabLive.addEventListener('click',    () => showTab('live'));
tabHistory.addEventListener('click', () => showTab('history'));

// ── Button handler ────────────────────────────────────────────
toggleBtn.addEventListener('click', async () => {
  if (!isActive) {
    const res = await sendToContent('start');
    if (res === null) {
      statusLabel.textContent = 'Not available on this page';
      return;
    }
    setActiveState(true);
    updateStats(res);
  } else {
    const res = await sendToContent('stop');
    setActiveState(false);
    updateStats(res);
    // Wait briefly for content.js to finish writing to storage, then refresh history
    setTimeout(loadSessions, 400);
  }
});

// ── Clear sessions ────────────────────────────────────────────
clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ sessions: [] });
  renderSessions([]);
});

// ── Receive live push updates from content.js ─────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'statsUpdate' && isActive) {
    updateStats(message);
  }
});

// ── Init: restore state when popup opens ─────────────────────
(async () => {
  const res = await sendToContent('getStats');
  if (res?.isActive) setActiveState(true);
  updateStats(res);
  // Pre-load sessions in background so History tab is fast to open
  loadSessions();
})();
