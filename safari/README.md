# Substack Front for Safari

Safari supports the same WebExtensions APIs this extension already uses, so the
port shares 100% of the JavaScript, HTML and CSS with the Chrome build. The only
Safari-specific pieces live in this directory:

| File | Purpose |
| --- | --- |
| `manifest.overrides.json` | Safari-specific manifest keys, merged over the root `manifest.json` |
| `build.sh` | Assembles the Safari payload and runs Apple's Xcode converter |

Safari cannot load a bare extension folder. Every Safari web extension ships
*inside* a native app wrapper, so the build produces an Xcode project containing
a small host app plus this extension.

## Requirements

- **macOS** with **Xcode 14+** installed (not just the Command Line Tools —
  `safari-web-extension-converter` ships with Xcode).
- **Safari 15.4+** for Manifest V3. Safari 16.4+ is a better target: it fixes
  several MV3 bugs, including background scripts failing to import other scripts.
- An **Apple Developer Program** membership ($99/year) to distribute. Safari
  extensions are distributed through the App Store only — there is no
  side-loadable `.crx` equivalent. Local development works without one.

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
two things make the **Refresh** button unreliable on iOS:

- `tabs.create({ active: false })` is broken on iOS 18.3+ — the new tab is
  foregrounded regardless, so a refresh visibly yanks the user to
  `substack.com/inbox`.
- Opening that tab dismisses the popup, so the popup never sees the result. The
  posts are still saved; reopening the popup shows them.

Passive collection (browse your Substack inbox, posts get captured) works fine
on iOS. If you ship an iOS build, consider hiding the Refresh button there.

## Keeping the two builds in sync

`build.sh` reads `name`, `version`, `description`, `permissions`,
`host_permissions`, `action`, `content_scripts` and `icons` straight from the
root `manifest.json`, so those can never drift. Only add a key to
`manifest.overrides.json` when Safari genuinely needs a different value; a `null`
value there deletes the key from the Safari manifest.

Application logic belongs in the shared `background/`, `content/`, `newtab/` and
`popup/` directories — never fork a file into this directory.
