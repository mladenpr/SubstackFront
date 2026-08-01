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
├── icons/                # Toolbar icons + appicon-source.png (App Store artwork)
├── scripts/              # Packaging
│   ├── shipping-files.txt      # Single source of truth for what ships
│   ├── list-shipping-files.sh  # Resolves it; both packagers call this
│   └── build-chrome.sh         # Chrome Web Store zip -> dist/
└── safari/               # Safari port (see safari/README.md)
    ├── manifest.overrides.json  # Safari-only manifest keys
    ├── appicon/                 # Generated app icon set (committed)
    ├── make-appicon.py          # Regenerates it; needs Pillow
    └── build.sh                 # Payload assembly + Xcode conversion
```

## Key Concepts

- **Content Script**: Parses Substack feed pages to extract post data (title, image, URL, etc.)
- **Background Worker**: Receives posts from content script, deduplicates, stores in chrome.storage.local
- **Popup**: Compact grid of cached posts, plus Refresh and a link to the tab view
- **Tab View** (`newtab/`): Reads from storage, displays posts in a tiled grid with a publication filter

## Development

```bash
# Chrome (development):
# 1. Go to chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select this directory

# Chrome (Web Store package):
./scripts/build-chrome.sh          # -> dist/substack-front-<version>.zip

# Safari (macOS + Xcode required):
./safari/build.sh --bundle-identifier com.yourcompany.substackfront
# then open safari/build/xcode/..., set a signing team, and run the app once.
# Local install and App Store release checklists are in safari/README.md
```

## Testing

### Automated

```bash
node --test                       # whole suite, no dependencies
node --test tests/background.test.js
SUBSTACK_TEST_VERBOSE=1 node --test   # show the extension's console output
```

Requires Node 20+ and nothing else — the suite uses `node:test`/`node:assert`
only. CI runs it on every push and pull request (`.github/workflows/ci.yml`);
a separate macOS workflow (`.github/workflows/safari.yml`) runs Apple's
converter and compiles the generated Xcode project.

```
tests/
├── helpers/extension-stub.js  # loads background.js into a VM with a stub API
├── background.test.js         # message handling, storage, refresh flow
├── manifest.test.js           # Chrome + generated Safari manifests, build.sh
├── packaging.test.js          # shipping-file list, Chrome zip layout
├── platform.test.js           # isIOS() behaviour and the popup/newtab copies
├── appicon.test.js            # icon sizes match Contents.json, none have alpha
└── syntax.test.js             # every shipped script parses and keeps its guards
```

The stub defaults to the **Safari** API shape — promise-returning, no
`storage.local.getBytesInUse` — because that is what regresses silently when
developing against Chrome. `loadBackground({ getBytesInUse: true })` gives the
Chrome shape, and `{ namespace: 'browser' }` exercises the alias guard.
`{ timings: {...} }` shrinks the refresh delays so timeout behaviour is testable
in milliseconds; it throws if a timing constant is renamed rather than silently
not applying.

The content script and UI scripts are only syntax-checked — they need a DOM, so
their behaviour is still verified by hand.

### By hand

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
- Add a case to `tests/background.test.js` for anything that behaves
  differently between the two browsers. No CI runner loads Safari, so the stub
  is the only thing standing between a Safari-only regression and the App Store.
- iOS cannot do background refresh at all (Safari ignores `active: false` in
  `tabs.create`), so the popup and tab view swap Refresh for a link to the
  inbox there. `isIOS()` is duplicated in both files — matching how
  `escapeHtml`/`formatRelativeDate` already are — and pinned together by
  `tests/platform.test.js`.

## Packaging

The two stores want different things — Chrome takes a zip whose top level is
`manifest.json`, Safari takes an Xcode project — but both package the same
files. `scripts/shipping-files.txt` is the only place that list exists;
`scripts/build-chrome.sh` and `safari/build.sh` both resolve it through
`scripts/list-shipping-files.sh`, so the two builds cannot drift. A pattern that
matches nothing fails the build rather than silently shipping less.

Neither artifact is committed. `dist/` and `safari/build/` are git-ignored, and
CI attaches the Chrome zip to every green run as an artifact.

Note `icons/` is listed file by file rather than with a glob: it also holds
`appicon-source.png`, which is App Store artwork for the Mac wrapper app and
must not end up inside the shipped extension.

## Releasing

`manifest.json`'s `version` is the single source of truth. `safari/build.sh`
copies it into the Xcode project's `MARKETING_VERSION`, so bumping it there is
enough for both builds; pass `--build-number` for App Store uploads, which need
a fresh one each time. Safari ships through the App Store inside the wrapper
app — see the release checklist in `safari/README.md`. Chrome takes
`dist/substack-front-<version>.zip` from `./scripts/build-chrome.sh`, uploaded
at the Web Store developer dashboard.

## Data Model

Posts are stored with: `id`, `title`, `subtitle`, `publication`, `publicationLogo`,
`author`, `coverImage`, `url`, `publishedAt`, `isRead`, `extractedAt`
