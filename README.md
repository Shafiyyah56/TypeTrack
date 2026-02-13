# Typing Speed Meter — Chrome Extension

A real-time typing speed monitoring Chrome extension that measures Words Per Minute (WPM) and Characters Per Minute (CPM) across any webpage. Built with vanilla JavaScript and Chrome Extension Manifest V3.

## Features

- **Real-Time Speed Tracking** — Live WPM and CPM calculations updated as you type, with peak speed recording
- **Active-Time Measurement** — Intelligently pauses the timer after 2 seconds of inactivity, ensuring only genuine typing time is measured
- **On-Page Widget** — Draggable floating overlay displays live stats directly on the webpage using Shadow DOM for style isolation
- **Session History** — Stores up to 10 recent sessions with per-domain statistics, accessible from the popup
- **Universal Editor Support** — Works with standard inputs, contenteditable elements, ARIA textboxes, Google Docs, Notion, Confluence, and more
- **Detailed Keystroke Metrics** — Tracks total keystrokes, backspaces, and pasted characters separately, filtering out shortcuts and modifier keys
- **Privacy-First** — Only statistical counts are stored locally. No keystrokes, content, or data ever leave the browser

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Platform | Chrome Extension (Manifest V3) |
| Language | Vanilla JavaScript (ES6+) |
| UI | HTML5, CSS3 (dark theme with glassmorphism) |
| Storage | Chrome Storage API (local) |
| Architecture | Service Worker + Content Scripts |
| Style Isolation | Shadow DOM |
| Dependencies | None |

## Project Structure

```
typing_speed_exten/
├── manifest.json              # Extension configuration (Manifest V3)
├── popup/
│   ├── popup.html             # Popup UI with Live and History tabs
│   ├── popup.css              # Dark theme styling
│   └── popup.js               # Popup logic and tab communication
├── content/
│   ├── content.js             # Core typing measurement engine
│   └── content.css            # Content script styles
├── background/
│   └── background.js          # Service worker
└── icon/                      # Extension icons
```

## How It Works

**Speed Calculation** — WPM is calculated using the standard formula `(characters / 5) / active minutes`, where active time excludes idle periods longer than 2 seconds. This provides an accurate representation of actual typing speed rather than inflated numbers from pauses.

**Input Detection** — The content script attaches capture-phase event listeners to detect typing across a wide range of input contexts, including dynamically inserted iframes. A `MutationObserver` watches for new iframes and attaches listeners to same-origin frames automatically.

**Input Filtering** — Modifier keys, navigation keys, keyboard shortcuts (Ctrl/Cmd combinations), and auto-repeated held keys are excluded from the character count. Backspaces and pasted text are tracked separately.

**Message Passing** — The popup communicates with content scripts via `chrome.tabs.sendMessage()`, while live stats are pushed from content scripts at 250ms intervals for smooth UI updates.

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/typing-speed-meter.git
   ```
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project directory
5. Pin the extension from the toolbar for quick access

## Permissions

| Permission | Purpose |
|-----------|---------|
| `activeTab` | Access the current tab to inject the typing measurement script |
| `storage` | Persist session history locally |

No remote servers. No data collection. All processing happens client-side.

## License

This project is open source and available under the MIT License
