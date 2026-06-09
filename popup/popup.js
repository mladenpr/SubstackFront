// SubstackFront - Popup Script (Simplified version)

(function() {
  'use strict';

  const { buildPostCard } = globalThis.SubstackShared;

  // DOM Elements
  const loadingEl = document.getElementById('loading');
  const emptyStateEl = document.getElementById('empty-state');
  const postGridEl = document.getElementById('post-grid');
  const refreshBtnEl = document.getElementById('refresh-btn');
  const expandBtnEl = document.getElementById('expand-btn');
  const statsEl = document.getElementById('stats');
  const toastEl = document.getElementById('toast');
  const toastMessageEl = toastEl.querySelector('.toast-message');

  // State
  let allPosts = [];
  let toastTimeout = null;

  /**
   * Show toast notification
   * @param {string} message - Message to display
   * @param {string} type - 'error', 'success', or 'info'
   */
  function showToast(message, type = 'info') {
    if (toastTimeout) {
      clearTimeout(toastTimeout);
    }

    toastEl.classList.remove('toast-error', 'toast-success', 'hidden');

    if (type === 'error') {
      toastEl.classList.add('toast-error');
    } else if (type === 'success') {
      toastEl.classList.add('toast-success');
    }

    toastMessageEl.textContent = message;
    toastEl.classList.add('show');

    toastTimeout = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 3000);
  }

  /**
   * Render posts to grid (all posts, scrollable)
   */
  function renderPosts(posts) {
    postGridEl.innerHTML = '';

    if (posts.length === 0) {
      postGridEl.classList.add('hidden');
      emptyStateEl.classList.remove('hidden');
      return;
    }

    emptyStateEl.classList.add('hidden');
    postGridEl.classList.remove('hidden');

    posts.forEach((post) => {
      const card = buildPostCard(post, {
        compact: true,
        onOpen: (p) => markAsRead(p.url)
      });
      postGridEl.appendChild(card);
    });
  }

  /**
   * Update stats display (compact format)
   */
  function updateStats(posts) {
    const total = posts.length;
    const unread = posts.filter(p => !p.isRead).length;
    statsEl.textContent = `${unread}/${total} unread`;
  }

  /**
   * Load posts from storage
   */
  async function loadPosts() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_POSTS' });

      if (response.success) {
        allPosts = response.posts || [];
        loadingEl.classList.add('hidden');
        updateStats(allPosts);
        renderPosts(allPosts);
      } else {
        throw new Error(response.error || 'Failed to load posts');
      }
    } catch (error) {
      console.error('[SubstackFront Popup] Error loading posts:', error);
      loadingEl.classList.add('hidden');
      emptyStateEl.classList.remove('hidden');
      showToast('Could not load posts: ' + error.message, 'error');
    }
  }

  /**
   * Mark post as read
   */
  async function markAsRead(url) {
    try {
      await chrome.runtime.sendMessage({ type: 'MARK_READ', url });

      const post = allPosts.find(p => p.url === url);
      if (post) {
        post.isRead = true;
        const card = document.querySelector(`[data-url="${CSS.escape(url)}"]`);
        if (card) {
          card.classList.add('read');
          const unreadDot = card.querySelector('.unread-dot');
          if (unreadDot) unreadDot.remove();
        }
        updateStats(allPosts);
      }
    } catch (error) {
      console.error('[SubstackFront Popup] Error marking as read:', error);
    }
  }

  /**
   * Handle refresh button click
   */
  async function handleRefresh() {
    refreshBtnEl.disabled = true;
    refreshBtnEl.classList.add('loading');

    try {
      const response = await chrome.runtime.sendMessage({ type: 'REFRESH_FEED' });
      if (response.success) {
        await loadPosts();
        showToast('Feed refreshed', 'success');
      } else {
        console.error('[SubstackFront Popup] Refresh failed:', response.error);
        showToast('Refresh failed: ' + response.error, 'error');
      }
    } catch (error) {
      console.error('[SubstackFront Popup] Refresh error:', error);
      showToast('Refresh failed: ' + error.message, 'error');
    } finally {
      refreshBtnEl.disabled = false;
      refreshBtnEl.classList.remove('loading');
    }
  }

  /**
   * Open full new tab page
   */
  function handleExpand() {
    chrome.tabs.create({ url: chrome.runtime.getURL('newtab/newtab.html') });
    window.close();
  }

  // Event Listeners
  refreshBtnEl.addEventListener('click', handleRefresh);
  expandBtnEl.addEventListener('click', handleExpand);

  // Listen for storage changes (real-time updates)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.posts) {
      allPosts = changes.posts.newValue || [];
      updateStats(allPosts);
      renderPosts(allPosts);
    }
  });

  // Initialize posts
  loadPosts();

})();
