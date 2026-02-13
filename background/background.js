'use strict';

// Minimal service worker required by Manifest V3.
// All measurement logic lives in content.js (persistent per page).

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Typing Speed Meter] Extension installed.');
});
