# Substack Front

Chrome extension that provides a magazine-style front page for Substack subscriptions.

## Architecture

```
SubstackFront/
├── manifest.json          # Extension config (Manifest V3)
├── shared/utils.js        # Shared helpers: URL/date utils + post card builder
├── content/content.js     # Runs on substack.com, extracts posts from DOM
├── background/background.js  # Service worker, manages chrome.storage
├── popup/                # Compact grid shown from the toolbar icon
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── newtab/               # Full magazine UI (opened via popup "Tab view";
│   ├── newtab.html       #   deliberately NOT a chrome_url_overrides new tab)
│   ├── newtab.js
│   └── newtab.css
└── icons/                # Extension icons
```

## Key Concepts

- **Shared utils**: `shared/utils.js` is loaded by every context (content script via manifest, service worker via `importScripts`, UI pages via `<script>` tag) and exposes `globalThis.SubstackShared`. Pure functions there are unit-tested.
- **Content Script**: Parses Substack inbox pages (apex `substack.com` only) to extract post data
- **Background Worker**: Receives posts from content script, dedupes by normalized URL (tracking params stripped), serializes storage writes, stores in chrome.storage.local. The hidden-tab refresh flow keeps its state in `chrome.storage.session` + `chrome.alarms` so it survives service worker restarts.
- **Popup**: Compact grid; "Tab view" button opens the full magazine page
- **New Tab Page**: Full magazine grid (uniform tiles) with search, unread-only toggle, publication filter, and sorting (newest/oldest/most liked/publication)

## Development

```bash
# Load extension in Chrome:
# 1. Go to chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select this directory
```

## Testing

```bash
node --test   # unit tests for shared/utils.js (in tests/)
```

Manual testing:
1. Load extension in Chrome
2. Visit https://substack.com/inbox (logged in)
3. Check DevTools console for extraction logs
4. Open the popup / "Tab view" to see the magazine view
5. Check Application > Storage for cached posts

## Tech Stack

- Vanilla JavaScript (no build step)
- CSS Grid for layout
- Chrome Extension Manifest V3
- chrome.storage.local for persistence

## Data Model

Posts are stored with: `id`, `title`, `subtitle`, `publication`, `publicationLogo`, `author`, `coverImage`, `url` (normalized, no query/hash), `publishedAt`, `isRead`, `likes` (nullable - only when the inbox renders a count), `extractedAt`
