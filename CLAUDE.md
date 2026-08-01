# Substack Front

Browser extension that provides a magazine-style front page for Substack
subscriptions. Ships for Chrome and Safari from one shared source tree.

## Architecture

```
SubstackFront/
├── manifest.json          # Chrome extension config (Manifest V3)
├── content/content.js     # Runs on substack.com, extracts posts from DOM
├── background/background.js  # Background worker, manages chrome.storage
├── popup/                # Toolbar popup (compact grid)
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── newtab/               # Full-page magazine UI, opened from the popup
│   ├── newtab.html
│   ├── newtab.js
│   └── newtab.css
├── icons/                # Extension icons
└── safari/               # Safari port (see safari/README.md)
    ├── manifest.overrides.json  # Safari-only manifest keys
    └── build.sh                 # Payload assembly + Xcode conversion
```

## Key Concepts

- **Content Script**: Parses Substack feed pages to extract post data (title, image, URL, etc.)
- **Background Worker**: Receives posts from content script, deduplicates, stores in chrome.storage.local
- **Popup**: Compact grid of cached posts, plus Refresh and a link to the tab view
- **Tab View** (`newtab/`): Reads from storage, displays posts in a tiled grid with a publication filter

## Development

```bash
# Chrome:
# 1. Go to chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select this directory

# Safari (macOS + Xcode required):
./safari/build.sh --bundle-identifier com.yourcompany.substackfront
# then open safari/build/xcode/..., set a signing team, and run the app once.
# Full checklist in safari/README.md
```

## Testing

1. Load extension in Chrome
2. Visit https://substack.com/inbox (logged in)
3. Check DevTools console for extraction logs
4. Open the popup, then "Tab view", to see the magazine view
5. Check Application > Storage for cached posts

For Safari, the background page is inspected via
Develop > Web Extension Background Pages. Note that Safari installs extensions
disabled and without host access — grant "Always Allow" for substack.com or
nothing will be extracted.

## Tech Stack

- Vanilla JavaScript (no build step for the Chrome build)
- CSS Grid for layout
- Manifest V3 (Chrome service worker / Safari non-persistent background page)
- chrome.storage.local for persistence

## Cross-browser rules

The Chrome and Safari builds share every `.js`, `.html` and `.css` file. Never
fork a source file into `safari/` — put the difference in
`safari/manifest.overrides.json` or feature-detect at runtime.

- Entry scripts start with a guard aliasing `chrome` to `browser`; keep using
  `chrome.*` in application code.
- Feature-detect APIs Safari lacks (e.g. `storage.local.getBytesInUse`) rather
  than assuming Chrome's surface.
- Prefer promise-style API calls — Chrome MV3 and Safari both support them.
- Don't rely on `tabs.onUpdated` alone for sequencing; Safari delivers it
  inconsistently without the `tabs` permission.

## Data Model

Posts are stored with: `id`, `title`, `subtitle`, `publication`, `publicationLogo`,
`author`, `coverImage`, `url`, `publishedAt`, `isRead`, `extractedAt`
