// SubstackFront - New Tab Page Script

(function() {
  'use strict';

  // Cross-browser API namespace. Safari and Firefox expose `browser` and alias
  // `chrome`; this guard keeps us working if that alias ever goes away.
  if (typeof globalThis.chrome === 'undefined' && typeof globalThis.browser !== 'undefined') {
    globalThis.chrome = globalThis.browser;
  }

  // DOM Elements
  const loadingEl = document.getElementById('loading');
  const emptyStateEl = document.getElementById('empty-state');
  const noResultsEl = document.getElementById('no-results');
  const postGridEl = document.getElementById('post-grid');
  const publicationFilterEl = document.getElementById('publication-filter');
  const searchInputEl = document.getElementById('search-input');
  const unreadOnlyEl = document.getElementById('unread-only');
  const markAllReadBtnEl = document.getElementById('mark-all-read-btn');
  const refreshBtnEl = document.getElementById('refresh-btn');
  const statsEl = document.getElementById('stats');
  const toastEl = document.getElementById('toast');
  const toastMessageEl = toastEl.querySelector('.toast-message');

  // Auto-refresh when the cache is older than this. Kept in sync with the copy
  // in popup/popup.js - tests/platform.test.js fails if the two drift apart.
  const STALE_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

  // State
  let allPosts = [];
  let currentFilter = '';
  let searchQuery = '';
  let unreadOnly = false;
  let toastTimeout = null;

  /**
   * Show toast notification
   * @param {string} message - Message to display
   * @param {string} type - 'error', 'success', or 'info'
   */
  function showToast(message, type = 'info') {
    // Clear any existing timeout
    if (toastTimeout) {
      clearTimeout(toastTimeout);
    }

    // Remove existing type classes
    toastEl.classList.remove('toast-error', 'toast-success', 'hidden');

    // Add type class
    if (type === 'error') {
      toastEl.classList.add('toast-error');
    } else if (type === 'success') {
      toastEl.classList.add('toast-success');
    }

    // Set message and show
    toastMessageEl.textContent = message;
    toastEl.classList.add('show');

    // Auto-hide after 3 seconds
    toastTimeout = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 3000);
  }

  /**
   * Format relative date
   */
  function formatRelativeDate(dateString) {
    if (!dateString) return '';

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
  }

  /**
   * Get first letter for placeholder
   */
  function getInitial(text) {
    return (text || 'S').charAt(0).toUpperCase();
  }

  /**
   * Create post card HTML
   * @param {object} post
   * @param {boolean} isHero - Render as the full-width lead story
   */
  function createPostCard(post, isHero = false) {
    const card = document.createElement('article');
    card.className = `post-card${post.isRead ? ' read' : ''}${isHero ? ' hero' : ''}`;
    card.dataset.url = post.url;

    const imageHtml = post.coverImage
      ? `<img class="post-image" src="${post.coverImage}" alt="" loading="lazy">`
      : `<div class="post-image-placeholder">${getInitial(post.publication)}</div>`;

    const logoHtml = post.publicationLogo
      ? `<img class="publication-logo" src="${post.publicationLogo}" alt="">`
      : '';

    card.innerHTML = `
      ${imageHtml}
      <div class="post-content">
        <div class="post-publication">
          ${logoHtml}
          <span class="publication-name">${escapeHtml(post.publication)}</span>
        </div>
        <h2 class="post-title">${escapeHtml(post.title)}</h2>
        ${post.subtitle ? `<p class="post-subtitle">${escapeHtml(post.subtitle)}</p>` : ''}
        <div class="post-meta">
          <span class="post-date">${formatRelativeDate(post.publishedAt)}${post.readTime ? ` &middot; ${escapeHtml(post.readTime)}` : ''}</span>
          ${!post.isRead ? '<span class="unread-dot" title="Unread"></span>' : ''}
        </div>
      </div>
    `;

    // Click handler
    card.addEventListener('click', () => {
      markAsRead(post.url);
      window.open(post.url, '_blank');
    });

    return card;
  }

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Render posts to grid, leading with a full-width hero card
   */
  function renderPosts(posts) {
    postGridEl.innerHTML = '';

    if (posts.length === 0) {
      postGridEl.classList.add('hidden');
      // Distinguish an empty cache from filters that exclude everything.
      if (allPosts.length > 0) {
        emptyStateEl.classList.add('hidden');
        noResultsEl.classList.remove('hidden');
      } else {
        noResultsEl.classList.add('hidden');
        emptyStateEl.classList.remove('hidden');
      }
      return;
    }

    emptyStateEl.classList.add('hidden');
    noResultsEl.classList.add('hidden');
    postGridEl.classList.remove('hidden');

    // Lead story: the newest unread post, or the newest post when all are read.
    const heroPost = posts.find(post => !post.isRead) || posts[0];

    [heroPost, ...posts.filter(post => post !== heroPost)].forEach((post) => {
      const card = createPostCard(post, post === heroPost);
      postGridEl.appendChild(card);
    });
  }

  /**
   * Update publication filter dropdown
   */
  function updatePublicationFilter(posts) {
    const publications = [...new Set(posts.map(p => p.publication))].sort();

    // Clear existing options except first
    while (publicationFilterEl.options.length > 1) {
      publicationFilterEl.remove(1);
    }

    publications.forEach(pub => {
      const option = document.createElement('option');
      option.value = pub;
      option.textContent = pub;
      publicationFilterEl.appendChild(option);
    });
  }

  /**
   * Update stats footer
   */
  function updateStats(posts) {
    const total = posts.length;
    const unread = posts.filter(p => !p.isRead).length;
    const publications = new Set(posts.map(p => p.publication)).size;

    statsEl.textContent = `${total} posts from ${publications} publications • ${unread} unread`;
  }

  /**
   * Filter posts by publication, read state and search query
   */
  function filterPosts() {
    let filtered = allPosts;

    if (currentFilter) {
      filtered = filtered.filter(p => p.publication === currentFilter);
    }

    if (unreadOnly) {
      filtered = filtered.filter(p => !p.isRead);
    }

    const query = searchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter(p =>
        [p.title, p.subtitle, p.author, p.publication]
          .some(field => (field || '').toLowerCase().includes(query))
      );
    }

    renderPosts(filtered);
  }

  /**
   * Load posts from storage
   * @param {boolean} autoRefreshIfStale - Kick off a refresh when the cache is
   *   old. Only the initial load passes true; a refresh reloads through here
   *   and must not trigger itself again.
   */
  async function loadPosts(autoRefreshIfStale = false) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_POSTS' });

      if (response.success) {
        allPosts = response.posts || [];

        loadingEl.classList.add('hidden');
        updatePublicationFilter(allPosts);
        updateStats(allPosts);
        filterPosts();

        if (autoRefreshIfStale) {
          maybeAutoRefresh(response.lastUpdated);
        }
      } else {
        throw new Error(response.error || 'Failed to load posts');
      }
    } catch (error) {
      console.error('[SubstackFront] Error loading posts:', error);
      loadingEl.classList.add('hidden');
      emptyStateEl.classList.remove('hidden');
    }
  }

  /**
   * Refresh automatically when the cache has gone stale. Kept in sync with the
   * copy in popup/popup.js - tests/platform.test.js fails if the two drift
   * apart.
   */
  function maybeAutoRefresh(lastUpdated) {
    // iOS swaps the Refresh button for an inbox link - no background refresh.
    if (isIOS()) return;
    // Never refreshed at all: the empty state already points at the inbox, and
    // opening a Substack tab before first use would be a surprise.
    if (!lastUpdated) return;
    const age = Date.now() - new Date(lastUpdated).getTime();
    if (Number.isNaN(age) || age < STALE_REFRESH_THRESHOLD_MS) return;
    console.log('[SubstackFront] Cached posts are stale, refreshing...');
    handleRefresh();
  }

  /**
   * Mark every post as read
   */
  async function handleMarkAllRead() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'MARK_ALL_READ' });
      if (!response.success) {
        throw new Error(response.error || 'Failed to mark all as read');
      }

      allPosts.forEach(post => { post.isRead = true; });
      updateStats(allPosts);
      filterPosts();

      const marked = response.marked || 0;
      showToast(
        marked > 0 ? `Marked ${marked} post${marked === 1 ? '' : 's'} as read` : 'Everything is already read',
        marked > 0 ? 'success' : 'info'
      );
    } catch (error) {
      console.error('[SubstackFront] Error marking all as read:', error);
      showToast('Mark all read failed: ' + error.message, 'error');
    }
  }

  /**
   * Mark post as read
   */
  async function markAsRead(url) {
    try {
      await chrome.runtime.sendMessage({ type: 'MARK_READ', url });

      // Update local state
      const post = allPosts.find(p => p.url === url);
      if (post) {
        post.isRead = true;

        // Update the card visually
        const card = document.querySelector(`[data-url="${CSS.escape(url)}"]`);
        if (card) {
          card.classList.add('read');
          const unreadDot = card.querySelector('.unread-dot');
          if (unreadDot) unreadDot.remove();
        }

        updateStats(allPosts);
      }
    } catch (error) {
      console.error('[SubstackFront] Error marking as read:', error);
    }
  }

  /**
   * Refresh feed in background
   */
  async function handleRefresh() {
    // Spin the icon in place - swapping in a longer "Refreshing..." label used
    // to resize the button and jolt the whole header bar.
    refreshBtnEl.disabled = true;
    refreshBtnEl.classList.add('loading');

    try {
      const response = await chrome.runtime.sendMessage({ type: 'REFRESH_FEED' });

      if (response.success) {
        console.log('[SubstackFront] Refresh complete:', response);
        // Force reload posts instead of relying on storage listener
        await loadPosts();
        const added = response.added || 0;
        showToast(
          added > 0 ? `${added} new post${added === 1 ? '' : 's'} added` : 'No new posts found',
          added > 0 ? 'success' : 'info'
        );
      } else {
        console.error('[SubstackFront] Refresh failed:', response.error);
        showToast('Refresh failed: ' + response.error, 'error');
      }
    } catch (error) {
      console.error('[SubstackFront] Refresh error:', error);
      showToast('Refresh failed: ' + error.message, 'error');
    } finally {
      refreshBtnEl.disabled = false;
      refreshBtnEl.classList.remove('loading');
    }
  }

  /**
   * Safari on iOS/iPadOS. Kept in sync with the copy in popup/popup.js -
   * tests/platform.test.js fails if the two drift apart.
   */
  function isIOS() {
    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ reports a desktop Mac user agent; touch points give it away.
    return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  }

  /**
   * Background refresh cannot work on iOS: Safari ignores `active: false` in
   * tabs.create (18.3+), so the refresh tab is foregrounded instead of loading
   * quietly. Offer a plain link instead of a button that would misbehave.
   */
  function replaceRefreshWithInboxLink() {
    const link = document.createElement('a');
    link.className = 'btn btn-secondary';
    link.href = 'https://substack.com/inbox';
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = 'Open your Substack inbox to collect posts';
    link.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      Open Substack
    `;
    refreshBtnEl.replaceWith(link);
  }

  // Event Listeners
  publicationFilterEl.addEventListener('change', (e) => {
    currentFilter = e.target.value;
    filterPosts();
  });

  searchInputEl.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    filterPosts();
  });

  unreadOnlyEl.addEventListener('change', (e) => {
    unreadOnly = e.target.checked;
    filterPosts();
  });

  markAllReadBtnEl.addEventListener('click', handleMarkAllRead);

  if (isIOS()) {
    replaceRefreshWithInboxLink();
  } else {
    refreshBtnEl.addEventListener('click', handleRefresh);
  }

  // Listen for storage changes (real-time updates)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.posts) {
      allPosts = changes.posts.newValue || [];
      updatePublicationFilter(allPosts);
      updateStats(allPosts);
      filterPosts();
    }
  });

  // Initialize
  loadPosts(true);

})();
