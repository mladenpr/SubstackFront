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
  const statsEl = document.getElementById('stats');

  // State
  let allPosts = [];
  let currentFilter = '';
  let scrollMode = localStorage.getItem('scrollMode') === 'true';

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
   * Calculate max posts that fit the viewport grid
   */
  function getMaxVisiblePosts() {
    const width = window.innerWidth;
    if (width >= 1400) return 18; // 6 cols × 3 rows
    if (width >= 1100) return 15; // 5 cols × 3 rows
    if (width >= 900) return 12;  // 4 cols × 3 rows
    if (width >= 700) return 9;   // 3 cols × 3 rows
    if (width >= 500) return 8;   // 2 cols × 4 rows
    return 5;                      // 1 col × 5 rows
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
      } else {
        console.error('[SubstackFront] Refresh failed:', response.error);
        alert('Refresh failed: ' + response.error);
      }
    } catch (error) {
      console.error('[SubstackFront] Refresh error:', error);
      alert('Refresh failed: ' + error.message);
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

  // Initialize
  applyScrollMode();
  loadPosts();

})();
