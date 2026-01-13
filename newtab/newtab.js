// SubstackFront - New Tab Page Script

(function() {
  'use strict';

  // DOM Elements
  const loadingEl = document.getElementById('loading');
  const emptyStateEl = document.getElementById('empty-state');
  const postGridEl = document.getElementById('post-grid');
  const publicationFilterEl = document.getElementById('publication-filter');
  const refreshBtnEl = document.getElementById('refresh-btn');
  const scrollToggleEl = document.getElementById('scroll-toggle');
  const modeToggleEl = document.getElementById('mode-toggle');
  const statsEl = document.getElementById('stats');
  const toastEl = document.getElementById('toast');
  const toastMessageEl = toastEl.querySelector('.toast-message');

  // State
  let allPosts = [];
  let currentFilter = '';
  let scrollMode = localStorage.getItem('scrollMode') === 'true';
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
   * Calculate max posts that fit the viewport grid dynamically
   */
  function getMaxVisiblePosts() {
    const main = document.querySelector('.main');
    if (!main) {
      // Fallback if main element not found
      return 18;
    }

    // Get computed styles for accurate measurements
    const mainStyle = getComputedStyle(main);
    const paddingX = parseFloat(mainStyle.paddingLeft) + parseFloat(mainStyle.paddingRight);
    const paddingY = parseFloat(mainStyle.paddingTop) + parseFloat(mainStyle.paddingBottom);

    // Available space inside main (excluding padding)
    const availableWidth = main.clientWidth - paddingX;
    const availableHeight = main.clientHeight - paddingY;

    // Get CSS variable values from root
    const rootStyle = getComputedStyle(document.documentElement);
    const cardWidth = parseFloat(rootStyle.getPropertyValue('--card-width')) || 200;
    const cardHeight = parseFloat(rootStyle.getPropertyValue('--card-height')) || 240;
    const gap = parseFloat(rootStyle.getPropertyValue('--gap')) || 10;

    // Calculate how many columns fit
    // Formula for auto-fill with minmax: floor((availableWidth + gap) / (cardWidth + gap))
    const cols = Math.floor((availableWidth + gap) / (cardWidth + gap));

    // Calculate how many rows fit
    const rows = Math.floor((availableHeight + gap) / (cardHeight + gap));

    // Ensure at least 1 column and 1 row
    const effectiveCols = Math.max(1, cols);
    const effectiveRows = Math.max(1, rows);

    const maxPosts = effectiveCols * effectiveRows;

    console.log(`[SubstackFront] getMaxVisiblePosts: ${Math.round(availableWidth)}x${Math.round(availableHeight)}px -> ${effectiveCols}cols x ${effectiveRows}rows = ${maxPosts} posts`);

    return maxPosts;
  }

  /**
   * Create post card HTML
   */
  function createPostCard(post) {
    const card = document.createElement('article');
    card.className = `post-card${post.isRead ? ' read' : ''}`;
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
          <span class="post-date">${formatRelativeDate(post.publishedAt)}</span>
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
   * Render posts to grid (limited to viewport capacity in fit mode)
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

    // In scroll mode, show all posts. In fit mode, limit to viewport.
    const maxVisible = getMaxVisiblePosts();
    const visiblePosts = scrollMode ? posts : posts.slice(0, maxVisible);

    console.log(`[SubstackFront] Rendering: scrollMode=${scrollMode}, total=${posts.length}, maxVisible=${maxVisible}, showing=${visiblePosts.length}`);

    visiblePosts.forEach((post) => {
      const card = createPostCard(post);
      postGridEl.appendChild(card);
    });
  }

  /**
   * Apply scroll mode to html and body
   */
  function applyScrollMode() {
    if (scrollMode) {
      document.documentElement.classList.add('scroll-mode');
      document.body.classList.add('scroll-mode');
    } else {
      document.documentElement.classList.remove('scroll-mode');
      document.body.classList.remove('scroll-mode');
    }
    scrollToggleEl.checked = scrollMode;
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
   * Filter posts
   */
  function filterPosts() {
    let filtered = allPosts;

    if (currentFilter) {
      filtered = allPosts.filter(p => p.publication === currentFilter);
    }

    renderPosts(filtered);
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
        updatePublicationFilter(allPosts);
        updateStats(allPosts);
        filterPosts();
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
    // Disable button and show loading state
    refreshBtnEl.disabled = true;
    refreshBtnEl.classList.add('loading');
    const originalText = refreshBtnEl.innerHTML;
    refreshBtnEl.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 4v6h-6M1 20v-6h6"/>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
      </svg>
      Refreshing...
    `;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'REFRESH_FEED' });

      if (response.success) {
        console.log('[SubstackFront] Refresh complete:', response);
        // Force reload posts instead of relying on storage listener
        await loadPosts();
        showToast('Feed refreshed successfully', 'success');
      } else {
        console.error('[SubstackFront] Refresh failed:', response.error);
        showToast('Refresh failed: ' + response.error, 'error');
      }
    } catch (error) {
      console.error('[SubstackFront] Refresh error:', error);
      showToast('Refresh failed: ' + error.message, 'error');
    } finally {
      // Restore button
      refreshBtnEl.disabled = false;
      refreshBtnEl.classList.remove('loading');
      refreshBtnEl.innerHTML = originalText;
    }
  }

  // Event Listeners
  publicationFilterEl.addEventListener('change', (e) => {
    currentFilter = e.target.value;
    filterPosts();
  });

  refreshBtnEl.addEventListener('click', handleRefresh);

  // Toggle scroll mode
  scrollToggleEl.addEventListener('change', () => {
    scrollMode = scrollToggleEl.checked;
    localStorage.setItem('scrollMode', scrollMode);
    console.log(`[SubstackFront] Scroll toggle changed: scrollMode=${scrollMode}`);
    applyScrollMode();
    filterPosts();
  });

  // Toggle mode (New Tab / Popup Only)
  modeToggleEl.addEventListener('change', () => {
    const popupOnlyMode = modeToggleEl.checked;
    chrome.storage.local.set({ popupOnlyMode: popupOnlyMode });
    console.log('[SubstackFront] Mode changed:', popupOnlyMode ? 'Popup Only' : 'New Tab');
  });

  // Re-render on window resize (only in fit mode)
  let resizeTimeout;
  window.addEventListener('resize', () => {
    if (!scrollMode) {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(filterPosts, 150);
    }
  });

  // Listen for storage changes (real-time updates)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.posts) {
      allPosts = changes.posts.newValue || [];
      updatePublicationFilter(allPosts);
      updateStats(allPosts);
      filterPosts();
    }
  });

  // Initialize mode toggle state
  chrome.storage.local.get(['popupOnlyMode'], (result) => {
    modeToggleEl.checked = result.popupOnlyMode === true;
  });

  // Initialize
  applyScrollMode();
  loadPosts();

})();
