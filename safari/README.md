# Substack Front for Safari

Safari supports the same WebExtensions APIs this extension already uses, so the
port shares 100% of the JavaScript, HTML and CSS with the Chrome build. The only
Safari-specific pieces live in this directory:

| File | Purpose |
| --- | --- |
| `manifest.overrides.json` | Safari-specific manifest keys, merged over the root `manifest.json` |
| `build.sh` | Assembles the Safari payload and runs Apple's Xcode converter |
| `appicon/` | Generated app icon set, copied into the Xcode project |

The extension files themselves come from `scripts/shipping-files.txt`, shared
with the Chrome packager, so both stores ship exactly the same code.

Safari cannot load a bare extension folder. Every Safari web extension ships
*inside* a native app wrapper, so the build produces an Xcode project containing
a small host app plus this extension.

## Requirements

- **macOS** with **Xcode 14+** installed (not just the Command Line Tools —
  `safari-web-extension-converter` ships with Xcode).
- **Safari 15.4+** for Manifest V3. Safari 16.4+ is a better target: it fixes
  several MV3 bugs, including background scripts failing to import other scripts.
- An **Apple Developer Program** membership ($99/year) to distribute. There is
  no side-loadable `.crx` equivalent — see *Ship it to other people* below.
  Local development works without one.

## Build

```bash
# Assemble the payload and generate the Xcode project
./safari/build.sh --bundle-identifier com.yourcompany.substackfront

# Payload only, no Xcode (works on any OS — useful for CI and inspection)
./safari/build.sh --no-convert

# macOS target only, and open the result in Xcode
./safari/build.sh --macos-only --open
```

Output lands in `safari/build/` (git-ignored):

```
safari/build/extension/   # Safari-ready copy of the extension
safari/build/xcode/       # Generated Xcode project (app wrapper + extension)
```

Run `./safari/build.sh --help` for all options.

## Run it locally

1. Open `safari/build/xcode/Substack Front/Substack Front.xcodeproj`.
2. Select your team under **Signing & Capabilities** for both the app target and
   the extension target. A free personal team is fine for local testing.

   The bundle identifiers are already correct — `build.sh` normalizes them after
   conversion so the extension is `<your id>.Extension` under an app of
   `<your id>`. Without that, Xcode 26 derives the app's identifier from a
   prefix plus the product name, the two stop nesting, and the build fails at
   `ValidateEmbeddedBinary`. If you change one identifier by hand, change both.
3. Build and run the app once — that is what registers the extension with Safari.
4. Safari → Settings → **Advanced** → enable *Show features for web developers*.
5. Safari → Develop → Developer Settings → enable **Allow unsigned extensions**
   (this resets every time Safari restarts).
6. Safari → Settings → **Extensions** → enable *Substack Front*.
7. Click the toolbar icon and grant access to `substack.com`. Choose
   **Always Allow on Every Website** or at least *Always Allow* for
   `substack.com`, otherwise the content script only runs for one day at a time.

Step 7 is the step people miss. Safari installs extensions **disabled** with no
host access, so until it is done the popup will just show the empty state.

## Ship it to other people

Unlike Chrome, there is no "upload a zip to a store" path. The extension ships
inside the wrapper app, so you are publishing a Mac app that happens to contain
a Safari extension. Two routes, both needing a paid Apple Developer membership:

**Mac App Store** — the equivalent of the Chrome Web Store. Users search for the
app, install it, and the extension appears in Safari's Extensions settings.
Goes through App Review. One submission can cover macOS and iPhone/iPad if you
keep the iOS target.

**Developer ID, outside the App Store** — sign and notarize the app and host the
download yourself. Since Safari 18.4 users no longer have to turn on *Allow
Unsigned Extensions* for these, which is what made this route impractical
before. No review queue, but no discoverability either, and it is macOS-only.

### Release checklist

1. **Register the bundle identifiers** in the developer portal: your app's
   (`com.yourcompany.substackfront`) and the extension's
   (`com.yourcompany.substackfront.Extension`).
2. **Bump the version** in the root `manifest.json`. That is the single source
   of truth — `build.sh` copies it into the Xcode project's `MARKETING_VERSION`,
   so the App Store listing and the extension can't disagree.
3. **Build**, giving App Store Connect a build number it has not seen before:
   ```bash
   ./safari/build.sh \
     --bundle-identifier com.yourcompany.substackfront \
     --build-number 1
   ```
4. In Xcode, set your team on **both** targets, then **Product → Archive** and
   **Distribute App**. The app icon is already in place — `build.sh` copies
   `safari/appicon/AppIcon.appiconset` over the converter's placeholder.
5. Fill in App Store Connect: description, category, screenshots, support URL,
   privacy policy URL, and the privacy questionnaire. `PRIVACY.md` in the repo
   root has the content; it needs to be hosted somewhere public.
6. Submit for review.

### App icons

`icons/appicon-source.png` (1024x1024) is the source artwork for **both** icon
sets. `scripts/make-icons.py` generates them and the output is committed, so no
build needs an image library:

- `safari/appicon/AppIcon.appiconset/` — ten macOS sizes from 16x16 up to
  512x512@2x plus the single 1024x1024 icon iOS uses, full-bleed and fully
  opaque. An alpha channel is an automatic App Store rejection.
- `icons/icon{16,48,128}.png` — the browser toolbar icons, rounded with
  transparent corners so they sit on browser chrome instead of reading as a
  coloured tile.

Regenerate after changing the artwork. This is the only script here that needs a
third-party package:

```bash
pip install Pillow
python3 scripts/make-icons.py
```

The artwork is drawn to survive downscaling, so every size is a straight resize
of the same source.

`tests/icons.test.js` checks both sets: dimensions against `Contents.json`,
opacity for the app icons, transparent corners for the toolbar icons, and that
each still contains the brand colours. That last check exists because a
generator bug once repainted the orange background white, leaving a blank icon
with correct dimensions, alpha and file type.

### App Review needs to see it work

The extension shows nothing until it has
extracted posts from a logged-in Substack inbox, and reviewers will not have a
Substack account with subscriptions. Supply demo account credentials in the
review notes, or expect a rejection for "we could not evaluate the
functionality". Also be ready to justify the `substack.com` host permission —
say plainly that it reads the subscription feed locally and stores it in
`storage.local`, and that nothing leaves the device.

## Debug

- **Background page**: Safari → Develop → Web Extension Background Pages →
  *Substack Front*.
- **Popup / tab view**: right-click inside the popup → Inspect Element.
- **Content script**: inspect the `substack.com` tab; the content script logs
  appear in that page's console under the extension's isolated world.

## What differs from Chrome

These are the real behavioural differences, all of which the shared code already
accounts for:

**Background context.** Chrome runs `background/background.js` as an MV3 service
worker. Safari runs it as a non-persistent background page (`background.scripts`
+ `persistent: false`). That is why the manifest is overridden rather than
shared verbatim. An event page is the better Safari target: `host_permissions`
are not applied to background *service workers* in Safari, iOS requires a
non-persistent background page, and the refresh flow's `setTimeout` chain
survives better in an event page.

**`storage.local.getBytesInUse` does not exist in Safari.** Calling it threw and
broke the storage-cleanup path, which in turn made every save report failure.
`getStorageUsage()` now feature-detects it and falls back to measuring the
serialized size of everything in storage.

**`tabs.onUpdated` is less reliable without the `tabs` permission.** The
background refresh used to depend entirely on receiving
`changeInfo.status === 'complete'`. It now also pokes the content script on a
fixed schedule (`FALLBACK_TRIGGER_DELAYS_MS`). Those retries stay silent when
they find nothing, so a slow-rendering inbox is not mistaken for an empty one;
only the last attempt before the timeout (`FINAL_TRIGGER_DELAY_MS`) reports an
empty result, which lets a logged-out inbox settle as "No new posts" instead of
hanging until the 30s timeout.

**API namespace.** Safari exposes `browser` and aliases `chrome`, and supports
both promise and callback styles. Each entry script starts with a three-line
guard that points `chrome` at `browser` if the alias is ever absent, so the rest
of the code can keep using `chrome.*`.

**Message channels.** The content script's `onMessage` listener returned `true`
unconditionally, which leaves the channel open for a response that never comes.
It now returns `false` because it always answers synchronously.

## iOS / iPadOS caveats

`./safari/build.sh` generates an iOS target too, and the UI is responsive, but
background refresh cannot work there:

- iOS has no `windows` API, so the minimized-window refresh the other
  platforms use falls back to `tabs.create({ active: false })` there.
- `tabs.create({ active: false })` is itself broken on iOS 18.3+ — the new tab
  is foregrounded regardless, so a refresh visibly yanks the user to
  `substack.com/inbox`.
- Opening that tab dismisses the popup, so the popup never sees the result.

Both the popup and the tab view therefore **replace Refresh with a plain link to
the inbox** on iOS rather than offering a button that would misbehave. Tapping
it lands on Substack, the content script extracts as usual, and the posts are
there when the user comes back. Passive collection — browse your inbox, posts get
captured — is unaffected.

The switch is `isIOS()` in `popup/popup.js` and `newtab/newtab.js`. It matches
iPhone/iPad/iPod user agents, plus the desktop-Mac user agent iPadOS 13+ sends,
which is distinguished by `navigator.maxTouchPoints`. The two copies are pinned
together by `tests/platform.test.js`.

## What CI covers

Two workflows:

- **`.github/workflows/ci.yml`** (Linux, every push and PR) runs `node --test`
  and shellchecks this build script. Covers the payload assembly, the generated
  manifest, and the background worker against a Safari-shaped API stub
  (`tests/helpers/extension-stub.js`).
- **`.github/workflows/safari.yml`** (macOS) runs Apple's converter for real and
  compiles the generated Xcode project unsigned. This is the only check that
  exercises the packaging path. macOS runner minutes bill at 10x, so it is
  scoped by `paths` to files that can affect the Safari build.

Neither covers **Safari at runtime**. Nothing on a CI runner loads the extension
into a browser, so the DOM-dependent code (`content/content.js`, the popup, the
tab view) and everything in the checklists above are still verified by hand.
Extraction in particular depends on Substack's markup, which no test here pins.

## Keeping the two builds in sync

`build.sh` reads `name`, `version`, `description`, `permissions`,
`host_permissions`, `action`, `content_scripts` and `icons` straight from the
root `manifest.json`, so those can never drift. Only add a key to
`manifest.overrides.json` when Safari genuinely needs a different value; a `null`
value there deletes the key from the Safari manifest.

Application logic belongs in the shared `background/`, `content/`, `newtab/` and
`popup/` directories — never fork a file into this directory.
