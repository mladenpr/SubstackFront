# Substack Front

A Chrome extension that gives your Substack subscriptions a magazine-style front page.

Posts are collected from your [Substack inbox](https://substack.com/inbox) as you browse (or via the Refresh button, which loads the inbox in a hidden background tab), cached locally, and displayed as a uniform grid of cards with search, an unread-only toggle, a per-publication filter, and sorting by date, publication, or like count (when Substack's inbox shows one).

## Install (developer mode)

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this directory

## Usage

- Visit https://substack.com/inbox while logged in — posts are extracted automatically
- Click the toolbar icon for the compact popup view
- Click **Tab view** in the popup for the full magazine page
- Click **Refresh** to fetch new posts without leaving the page

All data stays in `chrome.storage.local` on your machine; nothing is sent anywhere. See [PRIVACY.md](PRIVACY.md).

## Architecture

```
manifest.json             Extension config (Manifest V3)
shared/utils.js           URL/date helpers + post card builder (shared by all contexts)
content/content.js        Runs on substack.com, extracts posts from the inbox DOM
background/background.js  Service worker: stores, dedupes, and prunes posts
popup/                    Compact grid in the toolbar popup
newtab/                   Full magazine page (opened via the popup's "Tab view")
```

## Development

Vanilla JavaScript, no build step. Tests cover the pure helper functions:

```bash
node --test
```
