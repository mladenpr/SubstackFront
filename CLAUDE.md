# SubstackFront

Chrome extension that provides a magazine-style front page for Substack subscriptions.

## Architecture

```
SubstackFront/
├── manifest.json          # Extension config (Manifest V3)
├── content/content.js     # Runs on substack.com, extracts posts from DOM
├── background/background.js  # Service worker, manages chrome.storage
├── newtab/               # Magazine UI (overrides new tab)
│   ├── newtab.html
│   ├── newtab.js
│   └── newtab.css
└── icons/                # Extension icons
```

## Key Concepts

- **Content Script**: Parses Substack feed pages to extract post data (title, image, URL, etc.)
- **Background Worker**: Receives posts from content script, deduplicates, stores in chrome.storage.local
- **New Tab Page**: Reads from storage, displays posts in tiled/masonry grid layout

## Development

```bash
# Load extension in Chrome:
# 1. Go to chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select this directory
```

## Testing

1. Load extension in Chrome
2. Visit https://substack.com/inbox (logged in)
3. Check DevTools console for extraction logs
4. Open new tab to see magazine view
5. Check Application > Storage for cached posts

## Tech Stack

- Vanilla JavaScript (no build step)
- CSS Grid for layout
- Chrome Extension Manifest V3
- chrome.storage.local for persistence

## Data Model

Posts are stored with: `id`, `title`, `subtitle`, `publication`, `coverImage`, `url`, `publishedAt`, `isRead`
