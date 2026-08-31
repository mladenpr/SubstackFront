'use strict';

// Exercises background/background.js against a stubbed WebExtensions API.
// The default stub is Safari-shaped (no storage.local.getBytesInUse), which is
// the surface these tests exist to protect.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBackground, makePost, tick, plain } = require('./helpers/extension-stub.js');

test('initializes storage on install', async () => {
  const ext = loadBackground();
  await ext.fireInstalled();
  assert.deepEqual(plain(ext.store.posts), []);
  assert.equal(ext.store.lastUpdated, null);
});

test('saves posts when storage.local.getBytesInUse is unavailable', async () => {
  // Safari has no getBytesInUse. It used to throw during the post-save storage
  // check, which propagated out and made every successful save report failure.
  const ext = loadBackground();

  const response = await ext.sendMessage({
    type: 'POSTS_EXTRACTED',
    posts: [makePost(1), makePost(2), makePost(3)]
  });

  assert.equal(response.success, true);
  assert.equal(response.added, 3);
  assert.equal(ext.store.posts.length, 3);
});

test('works when the browser exposes only `browser`', async () => {
  // Safari and Firefox alias `chrome`, but the entry-script guard must cope if
  // that alias is ever absent.
  const ext = loadBackground({ namespace: 'browser' });

  const response = await ext.sendMessage({
    type: 'POSTS_EXTRACTED',
    posts: [makePost(1)]
  });

  assert.equal(response.success, true);
  assert.equal(ext.store.posts.length, 1);
});

test('estimates storage usage when getBytesInUse is missing', async () => {
  const ext = loadBackground();
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1)] });

  const stats = await ext.sendMessage({ type: 'GET_STORAGE_STATS' });

  assert.equal(stats.success, true);
  assert.equal(stats.bytesUsedIsEstimate, true);
  assert.ok(stats.bytesUsed > 0, `expected a positive estimate, got ${stats.bytesUsed}`);
  assert.equal(typeof stats.percentUsed, 'number');
});

test('uses getBytesInUse when the browser provides it', async () => {
  const ext = loadBackground({ getBytesInUse: true });
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1)] });

  const stats = await ext.sendMessage({ type: 'GET_STORAGE_STATS' });

  assert.equal(stats.success, true);
  assert.equal(stats.bytesUsedIsEstimate, false);
  assert.ok(stats.bytesUsed > 0);
});

test('a failing storage check does not fail the save', async () => {
  // Housekeeping runs after the posts are already written, so it must never
  // turn a successful save into a reported failure.
  const ext = loadBackground({ failGetAll: true });

  const response = await ext.sendMessage({
    type: 'POSTS_EXTRACTED',
    posts: [makePost(1)]
  });

  assert.equal(response.success, true);
  assert.equal(ext.store.posts.length, 1);
});

test('deduplicates by URL and preserves isRead', async () => {
  const ext = loadBackground();
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1), makePost(2)] });
  await ext.sendMessage({ type: 'MARK_READ', url: makePost(1).url });

  const response = await ext.sendMessage({
    type: 'POSTS_EXTRACTED',
    posts: [makePost(1), makePost(3)]
  });

  assert.equal(response.added, 1);
  assert.equal(response.updated, 1);
  assert.equal(response.total, 3);

  const { posts } = await ext.sendMessage({ type: 'GET_POSTS' });
  assert.equal(posts.find(p => p.url === makePost(1).url).isRead, true);
  assert.equal(posts.find(p => p.url === makePost(2).url).isRead, false);
});

test('rejects comment, discussion and non-article URLs', async () => {
  const ext = loadBackground();
  const rejected = [
    'https://example.substack.com/p/post-1/comments',
    'https://example.substack.com/p/post-1/comment/12345',
    'https://example.substack.com/p/post-1?action=share',
    'https://example.substack.com/p/post-1/discussion',
    'https://example.substack.com/archive',
    'https://example.substack.com/subscribe',
    'https://example.substack.com/about'
  ];

  await ext.sendMessage({
    type: 'POSTS_EXTRACTED',
    posts: [makePost(1), ...rejected.map((url, i) => makePost(100 + i, { url }))]
  });

  const { posts } = await ext.sendMessage({ type: 'GET_POSTS' });
  assert.deepEqual(plain(posts).map(p => p.url), [makePost(1).url]);
});

test('sorts newest first and trims to the post cap', async () => {
  const ext = loadBackground();
  const many = Array.from({ length: 320 }, (_, i) => makePost(i, {
    url: `https://example.substack.com/p/post-${i}`,
    publishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
  }));

  const response = await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: many });

  assert.equal(response.total, 300);
  const { posts } = await ext.sendMessage({ type: 'GET_POSTS' });
  assert.ok(new Date(posts[0].publishedAt) > new Date(posts[1].publishedAt));
  // The 20 oldest are dropped.
  assert.equal(posts.at(-1).url, 'https://example.substack.com/p/post-20');
});

test('reports stats for the popup and tab view', async () => {
  const ext = loadBackground();
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1), makePost(2), makePost(3)] });
  await ext.sendMessage({ type: 'MARK_READ', url: makePost(1).url });

  const stats = await ext.sendMessage({ type: 'GET_STATS' });

  assert.equal(stats.totalPosts, 3);
  assert.equal(stats.unreadPosts, 2);
  assert.equal(stats.publications.length, 3);
});

test('clears all posts', async () => {
  const ext = loadBackground();
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1)] });

  await ext.sendMessage({ type: 'CLEAR_POSTS' });

  const { posts } = await ext.sendMessage({ type: 'GET_POSTS' });
  assert.deepEqual(plain(posts), []);
});

test('marks all posts as read and reports how many changed', async () => {
  const ext = loadBackground();
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1), makePost(2), makePost(3)] });
  await ext.sendMessage({ type: 'MARK_READ', url: makePost(1).url });

  const response = await ext.sendMessage({ type: 'MARK_ALL_READ' });

  assert.equal(response.success, true);
  assert.equal(response.marked, 2, 'only the posts that were unread count');
  const { posts } = await ext.sendMessage({ type: 'GET_POSTS' });
  assert.ok(plain(posts).every(p => p.isRead));

  // Idempotent: a second pass changes nothing.
  const again = await ext.sendMessage({ type: 'MARK_ALL_READ' });
  assert.equal(again.marked, 0);
});

test('GET_POSTS carries lastUpdated so the UIs can spot stale data', async () => {
  const ext = loadBackground();

  const before = await ext.sendMessage({ type: 'GET_POSTS' });
  assert.equal(before.lastUpdated, null, 'no refresh yet means null, not undefined');

  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1)] });

  const after = await ext.sendMessage({ type: 'GET_POSTS' });
  assert.ok(!Number.isNaN(new Date(after.lastUpdated).getTime()),
    `expected a parseable timestamp, got ${after.lastUpdated}`);
});

test('keeps the toolbar badge on the unread count when chrome.action exists', async () => {
  const ext = loadBackground({ action: true });

  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1), makePost(2)] });
  assert.equal(ext.calls.badgeTexts.at(-1), '2');

  await ext.sendMessage({ type: 'MARK_READ', url: makePost(1).url });
  assert.equal(ext.calls.badgeTexts.at(-1), '1');

  await ext.sendMessage({ type: 'MARK_ALL_READ' });
  assert.equal(ext.calls.badgeTexts.at(-1), '', 'zero unread must clear the badge, not show "0"');

  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(3)] });
  assert.equal(ext.calls.badgeTexts.at(-1), '1');

  await ext.sendMessage({ type: 'CLEAR_POSTS' });
  assert.equal(ext.calls.badgeTexts.at(-1), '');
});

test('a missing chrome.action does not break saves or reads', async () => {
  // The default stub has no chrome.action, so the badge update must
  // feature-detect and stay out of the way.
  const ext = loadBackground();

  const saved = await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1)] });
  assert.equal(saved.success, true);

  const marked = await ext.sendMessage({ type: 'MARK_ALL_READ' });
  assert.equal(marked.success, true);
});

test('answers unknown message types instead of hanging', async () => {
  const ext = loadBackground();
  const response = await ext.sendMessage({ type: 'NOT_A_REAL_MESSAGE' });
  assert.deepEqual(plain(response), { success: false, error: 'Unknown message type' });
});

test('refresh opens a background tab where windows.create is unavailable (iOS)', async () => {
  const ext = loadBackground();
  const pending = ext.sendMessage({ type: 'REFRESH_FEED' });
  await tick();

  assert.equal(ext.calls.tabsCreated.length, 1);
  assert.equal(ext.calls.tabsCreated[0].url, 'https://substack.com/inbox');
  assert.equal(ext.calls.tabsCreated[0].active, false);

  const tabId = ext.calls.tabsCreated[0].id;
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1)] }, { tab: { id: tabId } });

  const response = await pending;
  assert.equal(response.success, true);
  assert.equal(response.added, 1);
  assert.ok(ext.calls.tabsRemoved.includes(tabId), 'refresh tab should be closed');
});

test('refresh opens the inbox in a minimized window when the browser supports it', async () => {
  const ext = loadBackground({ windows: true });
  const pending = ext.sendMessage({ type: 'REFRESH_FEED' });
  await tick();

  assert.equal(ext.calls.windowsCreated.length, 1);
  assert.equal(ext.calls.windowsCreated[0].url, 'https://substack.com/inbox');
  assert.equal(ext.calls.windowsCreated[0].state, 'minimized');
  assert.equal(ext.calls.windowsCreated[0].focused, undefined,
    'Chrome rejects focused combined with a minimized state');
  assert.equal(ext.calls.tabsCreated.length, 0,
    'nothing may appear in the user\'s tab strip');

  const tabId = ext.calls.windowsCreated[0].tabs[0].id;
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1)] }, { tab: { id: tabId } });

  const response = await pending;
  assert.equal(response.success, true);
  assert.equal(response.added, 1);
  assert.ok(ext.calls.tabsRemoved.includes(tabId),
    'closing the window\'s sole tab closes the minimized window with it');
});

test('refresh falls back to a background tab when windows.create fails', async () => {
  // Safari rejects createData it does not support rather than ignoring it.
  const ext = loadBackground({ windows: true, windowsCreateFails: true });
  const pending = ext.sendMessage({ type: 'REFRESH_FEED' });
  await tick();

  assert.equal(ext.calls.tabsCreated.length, 1);
  assert.equal(ext.calls.tabsCreated[0].active, false);

  const tabId = ext.calls.tabsCreated[0].id;
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1)] }, { tab: { id: tabId } });
  assert.equal((await pending).success, true);
});

test('refresh closes the orphan window and falls back when windows.create returns no tab', async () => {
  const ext = loadBackground({ windows: true, windowsCreateOmitsTabs: true });
  const pending = ext.sendMessage({ type: 'REFRESH_FEED' });
  await tick();

  assert.equal(ext.calls.windowsCreated.length, 1);
  assert.ok(ext.calls.windowsRemoved.includes(ext.calls.windowsCreated[0].id),
    'a window whose tab cannot be addressed must not be left open');
  assert.equal(ext.calls.tabsCreated.length, 1);
  assert.equal(ext.calls.tabsCreated[0].active, false);

  const tabId = ext.calls.tabsCreated[0].id;
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [] }, { tab: { id: tabId } });
  assert.equal((await pending).success, true);
});

test('refresh triggers extraction when tabs.onUpdated reports complete', async () => {
  const ext = loadBackground({
    timings: { LOAD_COMPLETE_TRIGGER_DELAY_MS: 20, FALLBACK_TRIGGER_DELAYS_MS: [10000], FINAL_TRIGGER_DELAY_MS: 20000, REFRESH_TIMEOUT_MS: 30000 },
    onTabMessage: () => ({ success: true })
  });

  const pending = ext.sendMessage({ type: 'REFRESH_FEED' });
  await tick();

  const tabId = ext.calls.tabsCreated[0].id;
  ext.fireTabUpdated(tabId, { status: 'complete' });
  await tick(60);

  assert.equal(ext.calls.tabMessages.length, 1);
  assert.equal(ext.calls.tabMessages[0].message.type, 'TRIGGER_EXTRACTION');
  assert.equal(ext.calls.tabMessages[0].message.force, false,
    'the load-complete trigger must not force an empty report');

  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [makePost(1)] }, { tab: { id: tabId } });
  assert.equal((await pending).success, true);
});

test('refresh retries silently, forces the last attempt, then times out', async () => {
  // Safari does not reliably deliver tabs.onUpdated without the "tabs"
  // permission, so the retries are the real path there. They must stay silent
  // so a slow-rendering inbox is not mistaken for an empty one.
  const ext = loadBackground({
    timings: {
      FALLBACK_TRIGGER_DELAYS_MS: [20, 50, 90],
      FINAL_TRIGGER_DELAY_MS: 130,
      REFRESH_TIMEOUT_MS: 180,
      LOAD_COMPLETE_TRIGGER_DELAY_MS: 10000
    }
  });

  const response = await ext.sendMessage({ type: 'REFRESH_FEED' });

  assert.equal(response.success, false);
  assert.match(response.error, /timed out/);

  const forced = plain(ext.calls.tabMessages).map(m => m.message.force);
  assert.deepEqual(forced, [false, false, false, true],
    'expected three silent retries then one forced final attempt');
  assert.ok(ext.calls.tabsRemoved.includes(ext.calls.tabsCreated[0].id),
    'timed-out refresh tab should be closed');
});

test('a forced empty report settles the refresh rather than hanging', async () => {
  const ext = loadBackground({
    timings: {
      FALLBACK_TRIGGER_DELAYS_MS: [20],
      FINAL_TRIGGER_DELAY_MS: 40,
      REFRESH_TIMEOUT_MS: 5000,
      LOAD_COMPLETE_TRIGGER_DELAY_MS: 10000
    },
    onTabMessage(message, tabId) {
      // Stand in for a content script on a logged-out inbox: it finds nothing
      // and only reports back when the trigger is forced.
      if (message.force) {
        ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [] }, { tab: { id: tabId } });
      }
      return { success: true };
    }
  });

  const response = await ext.sendMessage({ type: 'REFRESH_FEED' });

  assert.equal(response.success, true);
  assert.equal(response.added, 0);
  assert.equal(response.total, 0);
});

test('ignores posts from tabs that are not the refresh tab', async () => {
  const ext = loadBackground({
    timings: {
      FALLBACK_TRIGGER_DELAYS_MS: [10000],
      FINAL_TRIGGER_DELAY_MS: 20000,
      REFRESH_TIMEOUT_MS: 30000,
      LOAD_COMPLETE_TRIGGER_DELAY_MS: 10000
    }
  });

  const pending = ext.sendMessage({ type: 'REFRESH_FEED' });
  await tick();
  const refreshTabId = ext.calls.tabsCreated[0].id;

  // A post arriving from the user's own browsing must be saved normally and
  // must not close the refresh tab.
  const response = await ext.sendMessage(
    { type: 'POSTS_EXTRACTED', posts: [makePost(7)] },
    { tab: { id: refreshTabId + 999 } }
  );
  assert.equal(response.success, true);
  assert.equal(ext.calls.tabsRemoved.length, 0);

  // Settle the refresh so the test does not leave a timer running.
  await ext.sendMessage({ type: 'POSTS_EXTRACTED', posts: [] }, { tab: { id: refreshTabId } });
  await pending;
});

test('a second refresh supersedes the first', async () => {
  const ext = loadBackground({
    timings: {
      FALLBACK_TRIGGER_DELAYS_MS: [10000],
      FINAL_TRIGGER_DELAY_MS: 20000,
      REFRESH_TIMEOUT_MS: 30000,
      LOAD_COMPLETE_TRIGGER_DELAY_MS: 10000
    }
  });

  const first = ext.sendMessage({ type: 'REFRESH_FEED' });
  await tick();
  const second = ext.sendMessage({ type: 'REFRESH_FEED' });
  await tick();

  const firstResult = await first;
  assert.equal(firstResult.success, false);
  assert.match(firstResult.error, /Superseded/);
  assert.equal(ext.calls.tabsCreated.length, 2);
  assert.ok(ext.calls.tabsRemoved.includes(ext.calls.tabsCreated[0].id),
    'the superseded refresh tab should be closed');

  await ext.sendMessage(
    { type: 'POSTS_EXTRACTED', posts: [] },
    { tab: { id: ext.calls.tabsCreated[1].id } }
  );
  assert.equal((await second).success, true);
});
