// SubstackFront - Background Worker
// Manages post storage and coordinates between content script and UI
//
// Runs as an MV3 service worker in Chrome and as a non-persistent background
// page in Safari (see safari/README.md). Nothing here may depend on either
// environment's globals.

// Cross-browser API namespace. Safari and Firefox expose `browser` and alias
// `chrome`; this guard keeps us working if that alias ever goes away.
if (typeof globalThis.chrome === 'undefined' && typeof globalThis.browser !== 'undefined') {
  globalThis.chrome = globalThis.browser;
}

console.log('[SubstackFront] Background worker started');

// Storage limits
const MAX_POSTS = 300;
const STORAGE_QUOTA_BYTES = 5 * 1024 * 1024; // Chrome's storage.local limit; Safari's is not published
const STORAGE_WARNING_THRESHOLD = 4 * 1024 * 1024; // 4MB (80% of the assumed limit)
const MAX_POST_AGE_DAYS = 30;

/**
 * Check if URL is a valid article (not comments/discussion/other non-articles)
 */
function isValidPostUrl(url) {
  if (!url) return false;
  // Must contain /p/ for posts
  if (!url.includes('/p/')) return false;
  // Exclude comments
  if (url.includes('/comments')) return false;
  if (url.includes('/comment/')) return false;
  if (url.includes('/comment?')) return false;
  if (url.endsWith('/comment')) return false;
  // Exclude other non-article patterns
  if (url.includes('/subscribe') || url.includes('/about') || url.includes('/archive')) return false;
  if (url.includes('?action=') || url.includes('&action=')) return false;
  if (url.includes('/discussion')) return false;
  return true;
}

/**
 * Get all stored posts (filters out invalid URLs)
 */
async function getStoredPosts() {
  const result = await chrome.storage.local.get(['posts']);
  const posts = result.posts || [];
  // Filter out any cached posts with invalid URLs
  return posts.filter(post => isValidPostUrl(post.url));
}

/**
 * Save posts to storage, deduplicating by URL
 */
async function savePosts(newPosts) {
  const existingPosts = await getStoredPosts();

  // Create a map of existing posts by URL for quick lookup
  const postMap = new Map();
  existingPosts.forEach(post => {
    postMap.set(post.url, post);
  });

  // Filter new posts to only include valid URLs
  const validNewPosts = newPosts.filter(post => isValidPostUrl(post.url));

  // Add or update with new posts
  let addedCount = 0;
  let updatedCount = 0;

  validNewPosts.forEach(post => {
    if (postMap.has(post.url)) {
      // Update existing post, but preserve isRead status
      const existing = postMap.get(post.url);
      postMap.set(post.url, {
        ...post,
        isRead: existing.isRead
      });
      updatedCount++;
    } else {
      postMap.set(post.url, post);
      addedCount++;
    }
  });

  // Convert map back to array and sort by date (newest first)
  const getPostDate = (post) => {
    const dateStr = post.publishedAt || post.extractedAt;
    if (!dateStr) return 0; // Posts without dates go to end
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? 0 : date.getTime();
  };

  let allPosts = Array.from(postMap.values())
    .sort((a, b) => getPostDate(b) - getPostDate(a));

  // Limit to MAX_POSTS (oldest are removed)
  if (allPosts.length > MAX_POSTS) {
    console.log(`[SubstackFront] Trimming posts from ${allPosts.length} to ${MAX_POSTS}`);
    allPosts = allPosts.slice(0, MAX_POSTS);
  }

  // Store posts and update timestamp
  await chrome.storage.local.set({
    posts: allPosts,
    lastUpdated: new Date().toISOString()
  });

  // Check storage usage and auto-cleanup if needed. Housekeeping must never
  // fail the save - the posts are already persisted at this point.
  try {
    await checkAndCleanupStorage();
  } catch (error) {
    console.warn('[SubstackFront] Storage cleanup check failed:', error.message);
  }

  await updateBadge();

  console.log(`[SubstackFront] Saved posts - Added: ${addedCount}, Updated: ${updatedCount}, Total: ${allPosts.length}`);

  return { added: addedCount, updated: updatedCount, total: allPosts.length };
}

/**
 * Mark a post as read
 */
async function markPostAsRead(url) {
  const posts = await getStoredPosts();
  const updated = posts.map(post =>
    post.url === url ? { ...post, isRead: true } : post
  );
  await chrome.storage.local.set({ posts: updated });
  await updateBadge();
}

/**
 * Mark every stored post as read
 */
async function markAllPostsAsRead() {
  const posts = await getStoredPosts();
  const marked = posts.filter(post => !post.isRead).length;
  if (marked > 0) {
    const updated = posts.map(post =>
      post.isRead ? post : { ...post, isRead: true }
    );
    await chrome.storage.local.set({ posts: updated });
  }
  await updateBadge();
  return { marked };
}

/**
 * Clear all stored posts
 */
async function clearAllPosts() {
  await chrome.storage.local.set({ posts: [], lastUpdated: null });
  await updateBadge();
  console.log('[SubstackFront] All posts cleared');
}

/**
 * Show the unread count on the toolbar icon. `action` exists in Chrome MV3 and
 * Safari 15.4+, but feature-detect anyway, and never let a badge failure break
 * the storage write that triggered the update.
 */
async function updateBadge() {
  const action = chrome.action;
  if (!action || typeof action.setBadgeText !== 'function') return;

  try {
    const posts = await getStoredPosts();
    const unread = posts.filter(post => !post.isRead).length;

    if (typeof action.setBadgeBackgroundColor === 'function') {
      await action.setBadgeBackgroundColor({ color: '#ff6719' }); // Substack orange
    }
    if (typeof action.setBadgeTextColor === 'function') {
      await action.setBadgeTextColor({ color: '#ffffff' });
    }
    await action.setBadgeText({ text: unread > 0 ? String(unread) : '' });
  } catch (error) {
    console.warn('[SubstackFront] Could not update badge:', error.message);
  }
}

/**
 * Get storage statistics
 */
async function getStats() {
  const result = await chrome.storage.local.get(['posts', 'lastUpdated']);
  const posts = result.posts || [];
  return {
    totalPosts: posts.length,
    unreadPosts: posts.filter(p => !p.isRead).length,
    lastUpdated: result.lastUpdated,
    publications: [...new Set(posts.map(p => p.publication))]
  };
}

/**
 * Estimate storage usage by measuring the serialized size of everything stored.
 * Used where storage.local.getBytesInUse is unavailable (Safari).
 */
async function estimateStorageUsage() {
  const everything = await chrome.storage.local.get(null);
  let bytes = 0;
  const encoder = new TextEncoder();

  for (const [key, value] of Object.entries(everything)) {
    bytes += encoder.encode(key).length;
    bytes += encoder.encode(JSON.stringify(value ?? null)).length;
  }

  return bytes;
}

/**
 * Get storage usage in bytes.
 * Returns { bytes, estimated } - Safari has no getBytesInUse, so we measure instead.
 */
async function getStorageUsage() {
  if (typeof chrome.storage.local.getBytesInUse === 'function') {
    try {
      const bytes = await chrome.storage.local.getBytesInUse(null);
      if (typeof bytes === 'number') {
        return { bytes, estimated: false };
      }
    } catch (error) {
      console.log('[SubstackFront] getBytesInUse unavailable, estimating instead:', error.message);
    }
  }

  return { bytes: await estimateStorageUsage(), estimated: true };
}

/**
 * Get detailed storage stats including byte usage
 */
async function getStorageStats() {
  const { bytes: bytesUsed, estimated } = await getStorageUsage();
  const stats = await getStats();

  return {
    ...stats,
    bytesUsed,
    bytesUsedIsEstimate: estimated,
    bytesMax: STORAGE_QUOTA_BYTES,
    percentUsed: Math.round((bytesUsed / STORAGE_QUOTA_BYTES) * 100),
    isNearLimit: bytesUsed >= STORAGE_WARNING_THRESHOLD
  };
}

/**
 * Remove posts older than maxAgeDays
 */
async function cleanupOldPosts(maxAgeDays = MAX_POST_AGE_DAYS) {
  const posts = await getStoredPosts();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

  const filteredPosts = posts.filter(post => {
    const postDate = new Date(post.publishedAt || post.extractedAt);
    return !isNaN(postDate.getTime()) && postDate >= cutoffDate;
  });

  const removedCount = posts.length - filteredPosts.length;

  if (removedCount > 0) {
    await chrome.storage.local.set({ posts: filteredPosts });
    console.log(`[SubstackFront] Auto-cleanup: removed ${removedCount} posts older than ${maxAgeDays} days`);
  }

  return removedCount;
}

/**
 * Check storage usage and cleanup if exceeding threshold
 */
async function checkAndCleanupStorage() {
  const { bytes: bytesUsed } = await getStorageUsage();

  if (bytesUsed >= STORAGE_WARNING_THRESHOLD) {
    console.log(`[SubstackFront] Storage usage high (${Math.round(bytesUsed / 1024 / 1024 * 100) / 100}MB), running auto-cleanup...`);
    await cleanupOldPosts();
  }
}

// Refresh tuning
const REFRESH_URL = 'https://substack.com/inbox';
const REFRESH_TIMEOUT_MS = 30000;
const LOAD_COMPLETE_TRIGGER_DELAY_MS = 2000;
// Safari does not reliably deliver tabs.onUpdated status changes without the
// "tabs" permission, so poke the content script on a fixed schedule too. Each
// trigger is a no-op once the refresh has resolved.
const FALLBACK_TRIGGER_DELAYS_MS = [4000, 9000, 16000];
// Last attempt before the timeout. Only this one asks the content script to
// report an empty result, so a logged-out or slow-rendering inbox fails fast
// instead of hanging - earlier attempts stay silent and let the retries run.
const FINAL_TRIGGER_DELAY_MS = 24000;

// Track pending refresh state
let pendingRefreshTabId = null;
let pendingRefreshResolve = null;
let pendingRefreshReject = null;
let pendingTabUpdateListener = null;
let pendingRefreshTimers = [];

/**
 * Close a tab, tolerating both promise- and callback-style tabs.remove
 */
function closeTab(tabId) {
  try {
    const result = chrome.tabs.remove(tabId);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch (error) {
    // Tab already gone
  }
}

/**
 * Clean up refresh listeners and timers
 */
function cleanupRefreshState() {
  if (pendingTabUpdateListener) {
    chrome.tabs.onUpdated.removeListener(pendingTabUpdateListener);
    pendingTabUpdateListener = null;
  }
  pendingRefreshTimers.forEach(clearTimeout);
  pendingRefreshTimers = [];
}

/**
 * Settle the in-flight refresh promise, if any
 */
function settleRefresh(error, result) {
  const resolve = pendingRefreshResolve;
  const reject = pendingRefreshReject;
  pendingRefreshResolve = null;
  pendingRefreshReject = null;

  if (error) {
    if (reject) reject(error);
  } else if (resolve) {
    resolve(result);
  }
}

/**
 * Ask the content script in a refresh tab to extract now
 * @param {number} tabId - Tab hosting the content script
 * @param {boolean} force - Have it report back even if it found nothing
 */
async function triggerExtraction(tabId, force) {
  if (pendingRefreshTabId !== tabId) return;

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'TRIGGER_EXTRACTION',
      force
    });
    console.log('[SubstackFront] Extraction triggered, response:', response);
  } catch (error) {
    // Content script may not have loaded yet - a later trigger will retry
    console.log('[SubstackFront] Could not send extraction trigger:', error.message);
  }
}

/**
 * Schedule an extraction trigger and remember the timer so it can be cancelled
 */
function scheduleExtractionTrigger(tabId, delayMs, force = false) {
  pendingRefreshTimers.push(setTimeout(() => triggerExtraction(tabId, force), delayMs));
}

/**
 * Refresh feed by opening Substack in a background tab
 */
async function refreshFeed() {
  console.log('[SubstackFront] Starting background refresh...');

  // Abandon any previous pending refresh
  cleanupRefreshState();
  if (pendingRefreshTabId !== null) {
    console.log('[SubstackFront] Cleaning up previous refresh attempt');
    closeTab(pendingRefreshTabId);
    pendingRefreshTabId = null;
  }
  settleRefresh(new Error('Superseded by a newer refresh'));

  let tab;
  try {
    // On iOS 18.3+ Safari ignores `active: false` and foregrounds the tab anyway.
    tab = await chrome.tabs.create({ url: REFRESH_URL, active: false });
  } catch (error) {
    console.error('[SubstackFront] Failed to create tab:', error);
    throw new Error(`Could not open ${REFRESH_URL}: ${error.message}`);
  }

  pendingRefreshTabId = tab.id;
  console.log('[SubstackFront] Created background tab:', tab.id);

  return new Promise((resolve, reject) => {
    pendingRefreshResolve = resolve;
    pendingRefreshReject = reject;

    // Trigger extraction once the page reports it has finished loading
    pendingTabUpdateListener = (tabId, changeInfo) => {
      if (tabId === pendingRefreshTabId && changeInfo.status === 'complete') {
        console.log('[SubstackFront] Background tab finished loading, triggering extraction...');
        // Give extra time for Substack's JavaScript to render content
        scheduleExtractionTrigger(tabId, LOAD_COMPLETE_TRIGGER_DELAY_MS);
      }
    };
    chrome.tabs.onUpdated.addListener(pendingTabUpdateListener);

    FALLBACK_TRIGGER_DELAYS_MS.forEach(delay => scheduleExtractionTrigger(tab.id, delay));
    scheduleExtractionTrigger(tab.id, FINAL_TRIGGER_DELAY_MS, true);

    pendingRefreshTimers.push(setTimeout(() => {
      if (pendingRefreshTabId !== tab.id) return;

      console.log('[SubstackFront] Background refresh timed out');
      cleanupRefreshState();
      closeTab(tab.id);
      pendingRefreshTabId = null;
      settleRefresh(new Error('Refresh timed out - try visiting substack.com/inbox manually'));
    }, REFRESH_TIMEOUT_MS));
  });
}

/**
 * Handle posts received from a refresh tab
 */
async function handleRefreshPosts(tabId, posts) {
  console.log('[SubstackFront] Handling refresh posts from tab:', tabId, 'count:', posts.length);

  if (tabId !== pendingRefreshTabId) {
    console.log('[SubstackFront] Ignoring posts from non-refresh tab');
    return false;
  }

  cleanupRefreshState();

  try {
    const result = await savePosts(posts);
    closeTab(tabId);
    pendingRefreshTabId = null;
    settleRefresh(null, result);
    return true;
  } catch (error) {
    closeTab(tabId);
    pendingRefreshTabId = null;
    settleRefresh(error);
    return false;
  }
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[SubstackFront] Received message:', message.type, 'from tab:', sender.tab?.id);

  switch (message.type) {
    case 'POSTS_EXTRACTED':
      // Check if this is from a refresh tab
      if (sender.tab?.id && sender.tab.id === pendingRefreshTabId) {
        console.log('[SubstackFront] Posts from refresh tab');
        handleRefreshPosts(sender.tab.id, message.posts)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
      } else {
        // Regular extraction from user browsing
        savePosts(message.posts)
          .then(result => sendResponse({ success: true, ...result }))
          .catch(error => sendResponse({ success: false, error: error.message }));
      }
      return true; // Keep channel open for async response

    case 'GET_POSTS':
      // lastUpdated rides along so the UIs can auto-refresh stale data.
      Promise.all([getStoredPosts(), chrome.storage.local.get(['lastUpdated'])])
        .then(([posts, meta]) => sendResponse({ success: true, posts, lastUpdated: meta.lastUpdated || null }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'MARK_READ':
      markPostAsRead(message.url)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'MARK_ALL_READ':
      markAllPostsAsRead()
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'CLEAR_POSTS':
      clearAllPosts()
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'GET_STATS':
      getStats()
        .then(stats => sendResponse({ success: true, ...stats }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'GET_STORAGE_STATS':
      getStorageStats()
        .then(stats => sendResponse({ success: true, ...stats }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'REFRESH_FEED':
      console.log('[SubstackFront] REFRESH_FEED received, starting refresh...');
      refreshFeed()
        .then(result => {
          console.log('[SubstackFront] Refresh completed:', result);
          sendResponse({ success: true, ...result });
        })
        .catch(error => {
          console.error('[SubstackFront] Refresh failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
      return false;
  }
});

// Log when extension is installed or updated
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[SubstackFront] Extension installed/updated:', details.reason);

  // Initialize storage if needed
  try {
    const result = await chrome.storage.local.get(['posts']);
    if (!result.posts) {
      await chrome.storage.local.set({ posts: [], lastUpdated: null });
    }
  } catch (error) {
    console.error('[SubstackFront] Could not initialize storage:', error);
  }

  await updateBadge();
});

// The worker restarts whenever an event wakes it, so recompute the badge on
// every start rather than trusting whatever text the browser kept around.
updateBadge().catch(error => {
  console.warn('[SubstackFront] Badge init failed:', error.message);
});
