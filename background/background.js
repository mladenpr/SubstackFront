// SubstackFront - Background Service Worker
// Manages post storage and coordinates between content script and UI

console.log('[SubstackFront] Background service worker started');

/**
 * Get all stored posts
 */
async function getStoredPosts() {
  const result = await chrome.storage.local.get(['posts']);
  return result.posts || [];
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

  // Add or update with new posts
  let addedCount = 0;
  let updatedCount = 0;

  newPosts.forEach(post => {
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
  const allPosts = Array.from(postMap.values())
    .sort((a, b) => {
      const dateA = new Date(a.publishedAt || a.extractedAt);
      const dateB = new Date(b.publishedAt || b.extractedAt);
      return dateB - dateA;
    });

  // Store posts and update timestamp
  await chrome.storage.local.set({
    posts: allPosts,
    lastUpdated: new Date().toISOString()
  });

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
 * Refresh feed by opening Substack in a background tab
 */
async function refreshFeed() {
  console.log('[SubstackFront] Starting background refresh...');

  return new Promise((resolve, reject) => {
    // Open Substack inbox in a new tab (not active)
    chrome.tabs.create({
      url: 'https://substack.com/inbox',
      active: false
    }, (tab) => {
      const tabId = tab.id;
      let resolved = false;

      // Listen for messages from the content script in that tab
      const messageListener = (message, sender) => {
        if (sender.tab?.id === tabId && message.type === 'POSTS_EXTRACTED') {
          console.log('[SubstackFront] Received posts from background tab');
          resolved = true;

          // Save the posts
          savePosts(message.posts)
            .then(result => {
              // Close the tab
              chrome.tabs.remove(tabId);
              chrome.runtime.onMessage.removeListener(messageListener);
              resolve(result);
            })
            .catch(error => {
              chrome.tabs.remove(tabId);
              chrome.runtime.onMessage.removeListener(messageListener);
              reject(error);
            });
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);

      // Timeout after 15 seconds
      setTimeout(() => {
        if (!resolved) {
          console.log('[SubstackFront] Background refresh timed out');
          chrome.runtime.onMessage.removeListener(messageListener);
          chrome.tabs.remove(tabId).catch(() => {});
          reject(new Error('Refresh timed out'));
        }
      }, 15000);
    });
  });
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[SubstackFront] Received message:', message.type);

  switch (message.type) {
    case 'POSTS_EXTRACTED':
      savePosts(message.posts)
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

    case 'GET_STATS':
      getStats()
        .then(stats => sendResponse({ success: true, ...stats }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'REFRESH_FEED':
      refreshFeed()
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
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
