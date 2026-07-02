// SubstackFront - Background Service Worker
// Manages post storage and coordinates between content script and UI

importScripts('/shared/utils.js');

const { isValidArticleUrl, normalizeArticleUrl } = globalThis.SubstackShared;

console.log('[SubstackFront] Background service worker started');

// Storage limits
const MAX_POSTS = 300;
const STORAGE_WARNING_THRESHOLD = 4 * 1024 * 1024; // 4MB (80% of 5MB limit)
const MAX_POST_AGE_DAYS = 30;

// Alarm that cleans up a refresh tab that never reported back
const REFRESH_TIMEOUT_ALARM = 'refresh-timeout';

// Storage writes are read-modify-write on the same key; serialize them so
// concurrent extractions (scroll + mutation observer) can't drop each other's
// posts. Internal *Unlocked functions must only run while holding the lock.
let writeLock = Promise.resolve();
function withWriteLock(task) {
  const run = writeLock.then(task, task);
  writeLock = run.then(() => {}, () => {});
  return run;
}

/**
 * Get all stored posts (filters out invalid URLs)
 */
async function getStoredPosts() {
  const result = await chrome.storage.local.get(['posts']);
  const posts = result.posts || [];
  // Filter out any cached posts with invalid URLs
  return posts.filter(post => isValidArticleUrl(post.url));
}

/**
 * Save posts to storage, deduplicating by normalized URL
 */
function savePosts(newPosts) {
  return withWriteLock(() => savePostsUnlocked(newPosts));
}

async function savePostsUnlocked(newPosts) {
  const existingPosts = await getStoredPosts();

  // Create a map of existing posts by normalized URL for quick lookup
  const postMap = new Map();
  existingPosts.forEach(post => {
    postMap.set(normalizeArticleUrl(post.url), post);
  });

  // Filter new posts to only include valid URLs
  const validNewPosts = newPosts.filter(post => isValidArticleUrl(post.url));

  // Add or update with new posts
  let addedCount = 0;
  let updatedCount = 0;

  validNewPosts.forEach(post => {
    const key = normalizeArticleUrl(post.url);
    const existing = postMap.get(key);
    if (existing) {
      // Update existing post. A post is read if either side says so:
      // marked read in the extension, or read on Substack itself.
      // Likes aren't always rendered, so keep the last known count.
      postMap.set(key, {
        ...post,
        isRead: existing.isRead || post.isRead,
        likes: post.likes ?? existing.likes ?? null
      });
      updatedCount++;
    } else {
      postMap.set(key, post);
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

  // Check storage usage and auto-cleanup if needed
  await checkAndCleanupStorage();

  console.log(`[SubstackFront] Saved posts - Added: ${addedCount}, Updated: ${updatedCount}, Total: ${allPosts.length}`);

  return { added: addedCount, updated: updatedCount, total: allPosts.length };
}

/**
 * Mark a post as read
 */
function markPostAsRead(url) {
  return withWriteLock(async () => {
    const key = normalizeArticleUrl(url);
    const posts = await getStoredPosts();
    const updated = posts.map(post =>
      normalizeArticleUrl(post.url) === key ? { ...post, isRead: true } : post
    );
    await chrome.storage.local.set({ posts: updated });
  });
}

/**
 * Clear all stored posts
 */
function clearAllPosts() {
  return withWriteLock(async () => {
    await chrome.storage.local.set({ posts: [], lastUpdated: null });
    console.log('[SubstackFront] All posts cleared');
  });
}

/**
 * Get storage usage in bytes
 */
function getStorageUsage() {
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
      resolve(bytesInUse);
    });
  });
}

/**
 * Remove posts older than maxAgeDays (caller must hold the write lock)
 */
async function cleanupOldPostsUnlocked(maxAgeDays = MAX_POST_AGE_DAYS) {
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
 * (called from savePostsUnlocked, so already holds the write lock)
 */
async function checkAndCleanupStorage() {
  const bytesUsed = await getStorageUsage();

  if (bytesUsed >= STORAGE_WARNING_THRESHOLD) {
    console.log(`[SubstackFront] Storage usage high (${Math.round(bytesUsed / 1024 / 1024 * 100) / 100}MB), running auto-cleanup...`);
    await cleanupOldPostsUnlocked();
  }
}

// --- Background refresh ---
//
// Opens substack.com/inbox in a hidden tab and waits for its content script
// to send POSTS_EXTRACTED. The pending tab id lives in chrome.storage.session
// and the timeout uses chrome.alarms, so the flow survives the service worker
// being killed mid-refresh: a restarted worker still completes the save and
// closes the tab, and the alarm cleans up a tab that never reports back.
// Only the in-flight promise (used to answer the UI's message) is in-memory;
// if the worker restarts, the UIs catch the closed message port and recover
// via their storage.onChanged listeners.

let refreshResolve = null;
let refreshReject = null;

async function getRefreshTabId() {
  const { refreshTabId } = await chrome.storage.session.get('refreshTabId');
  return refreshTabId ?? null;
}

async function cancelPendingRefresh(reason) {
  const tabId = await getRefreshTabId();
  if (tabId !== null) {
    console.log('[SubstackFront] Cancelling pending refresh:', reason);
    chrome.tabs.remove(tabId).catch(() => {});
  }
  await chrome.storage.session.remove('refreshTabId');
  chrome.alarms.clear(REFRESH_TIMEOUT_ALARM);
  if (refreshReject) {
    refreshReject(new Error(reason));
  }
  refreshResolve = null;
  refreshReject = null;
}

/**
 * Refresh feed by opening Substack in a background tab
 */
async function refreshFeed() {
  console.log('[SubstackFront] Starting background refresh...');

  await cancelPendingRefresh('Superseded by a new refresh');

  const tab = await chrome.tabs.create({
    url: 'https://substack.com/inbox',
    active: false
  });
  console.log('[SubstackFront] Created background tab:', tab.id);

  await chrome.storage.session.set({ refreshTabId: tab.id });
  chrome.alarms.create(REFRESH_TIMEOUT_ALARM, { delayInMinutes: 1 });

  return new Promise((resolve, reject) => {
    refreshResolve = resolve;
    refreshReject = reject;
  });
}

// When the refresh tab finishes loading, give Substack's client-side
// rendering a moment, then ask the content script to extract
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const refreshTabId = await getRefreshTabId();
  if (tabId !== refreshTabId) return;

  console.log('[SubstackFront] Background tab finished loading, triggering extraction...');
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_EXTRACTION' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('[SubstackFront] Could not send extraction trigger:', chrome.runtime.lastError.message);
      } else {
        console.log('[SubstackFront] Extraction triggered, response:', response);
      }
    });
  }, 2000);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== REFRESH_TIMEOUT_ALARM) return;
  const refreshTabId = await getRefreshTabId();
  if (refreshTabId === null) return;
  console.log('[SubstackFront] Background refresh timed out');
  await cancelPendingRefresh('Refresh timed out - try visiting substack.com/inbox manually');
});

/**
 * Save extracted posts; if they came from the refresh tab, finish the refresh
 */
async function handlePostsExtracted(posts, sender) {
  const result = await savePosts(posts);

  const refreshTabId = await getRefreshTabId();
  if (sender.tab?.id !== undefined && sender.tab.id === refreshTabId) {
    console.log('[SubstackFront] Posts received from refresh tab, finishing refresh');
    await chrome.storage.session.remove('refreshTabId');
    chrome.alarms.clear(REFRESH_TIMEOUT_ALARM);
    chrome.tabs.remove(sender.tab.id).catch(() => {});
    if (refreshResolve) {
      refreshResolve(result);
      refreshResolve = null;
      refreshReject = null;
    }
  }

  return result;
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[SubstackFront] Received message:', message.type, 'from tab:', sender.tab?.id);

  switch (message.type) {
    case 'POSTS_EXTRACTED':
      handlePostsExtracted(message.posts, sender)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep channel open for async response

    case 'GET_POSTS':
      getStoredPosts()
        .then(posts => sendResponse({ success: true, posts }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'MARK_READ':
      markPostAsRead(message.url)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'CLEAR_POSTS':
      clearAllPosts()
        .then(() => sendResponse({ success: true }))
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
  }
});

// Log when extension is installed or updated
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[SubstackFront] Extension installed/updated:', details.reason);

  // Initialize storage if needed
  chrome.storage.local.get(['posts'], (result) => {
    if (!result.posts) {
      chrome.storage.local.set({ posts: [], lastUpdated: null });
    }
  });
});
