// SubstackFront - Background Service Worker
// Manages post storage and coordinates between content script and UI

console.log('[SubstackFront] Background service worker started');

// Storage limits
const MAX_POSTS = 300;
const STORAGE_WARNING_THRESHOLD = 4 * 1024 * 1024; // 4MB (80% of 5MB limit)
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

  // Check storage usage and auto-cleanup if needed
  await checkAndCleanupStorage();

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
}

/**
 * Clear all stored posts
 */
async function clearAllPosts() {
  await chrome.storage.local.set({ posts: [], lastUpdated: null });
  console.log('[SubstackFront] All posts cleared');
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
 * Get storage usage in bytes
 */
async function getStorageUsage() {
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
      resolve(bytesInUse);
    });
  });
}

/**
 * Get detailed storage stats including byte usage
 */
async function getStorageStats() {
  const bytesUsed = await getStorageUsage();
  const stats = await getStats();
  const maxBytes = 5 * 1024 * 1024; // 5MB chrome.storage.local limit

  return {
    ...stats,
    bytesUsed,
    bytesMax: maxBytes,
    percentUsed: Math.round((bytesUsed / maxBytes) * 100),
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
  const bytesUsed = await getStorageUsage();

  if (bytesUsed >= STORAGE_WARNING_THRESHOLD) {
    console.log(`[SubstackFront] Storage usage high (${Math.round(bytesUsed / 1024 / 1024 * 100) / 100}MB), running auto-cleanup...`);
    await cleanupOldPosts();
  }
}

// Track pending refresh state
let pendingRefreshTabId = null;
let pendingRefreshResolve = null;
let pendingRefreshReject = null;
let pendingTabUpdateListener = null;

/**
 * Refresh feed by opening Substack in a background tab
 */
async function refreshFeed() {
  console.log('[SubstackFront] Starting background refresh...');

  // Clear any previous pending refresh
  if (pendingRefreshTabId) {
    console.log('[SubstackFront] Cleaning up previous refresh attempt');
    chrome.tabs.remove(pendingRefreshTabId).catch(() => {});
    pendingRefreshTabId = null;
  }

  return new Promise((resolve, reject) => {
    pendingRefreshResolve = resolve;
    pendingRefreshReject = reject;

    // Clean up any previous listener
    if (pendingTabUpdateListener) {
      chrome.tabs.onUpdated.removeListener(pendingTabUpdateListener);
    }

    // Listen for tab updates to know when page is fully loaded
    pendingTabUpdateListener = (tabId, changeInfo) => {
      if (tabId === pendingRefreshTabId && changeInfo.status === 'complete') {
        console.log('[SubstackFront] Background tab finished loading, triggering extraction...');
        // Give extra time for Substack's JavaScript to render content
        setTimeout(() => {
          if (pendingRefreshTabId === tabId) {
            // Send message to content script to trigger extraction
            chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_EXTRACTION' }, (response) => {
              if (chrome.runtime.lastError) {
                console.log('[SubstackFront] Could not send extraction trigger:', chrome.runtime.lastError.message);
              } else {
                console.log('[SubstackFront] Extraction triggered, response:', response);
              }
            });
          }
        }, 2000);
      }
    };

    chrome.tabs.onUpdated.addListener(pendingTabUpdateListener);

    // Open Substack inbox in a new tab (not active)
    chrome.tabs.create({
      url: 'https://substack.com/inbox',
      active: false
    }, (tab) => {
      if (chrome.runtime.lastError) {
        console.error('[SubstackFront] Failed to create tab:', chrome.runtime.lastError);
        chrome.tabs.onUpdated.removeListener(pendingTabUpdateListener);
        pendingTabUpdateListener = null;
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      pendingRefreshTabId = tab.id;
      console.log('[SubstackFront] Created background tab:', tab.id);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingTabUpdateListener) {
          chrome.tabs.onUpdated.removeListener(pendingTabUpdateListener);
          pendingTabUpdateListener = null;
        }
        if (pendingRefreshTabId === tab.id) {
          console.log('[SubstackFront] Background refresh timed out');
          chrome.tabs.remove(tab.id).catch(() => {});
          pendingRefreshTabId = null;
          if (pendingRefreshReject) {
            pendingRefreshReject(new Error('Refresh timed out - try visiting substack.com/inbox manually'));
            pendingRefreshReject = null;
            pendingRefreshResolve = null;
          }
        }
      }, 30000);
    });
  });
}

/**
 * Clean up refresh state
 */
function cleanupRefreshState() {
  if (pendingTabUpdateListener) {
    chrome.tabs.onUpdated.removeListener(pendingTabUpdateListener);
    pendingTabUpdateListener = null;
  }
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
    chrome.tabs.remove(tabId).catch(() => {});
    pendingRefreshTabId = null;

    if (pendingRefreshResolve) {
      pendingRefreshResolve(result);
      pendingRefreshResolve = null;
      pendingRefreshReject = null;
    }
    return true;
  } catch (error) {
    chrome.tabs.remove(tabId).catch(() => {});
    pendingRefreshTabId = null;

    if (pendingRefreshReject) {
      pendingRefreshReject(error);
      pendingRefreshReject = null;
      pendingRefreshResolve = null;
    }
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
