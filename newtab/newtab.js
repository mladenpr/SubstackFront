// SubstackFront - New Tab Page Script

(function() {
  'use strict';

  const { buildPostCard } = globalThis.SubstackShared;

  // DOM Elements
  const loadingEl = document.getElementById('loading');
  const emptyStateEl = document.getElementById('empty-state');
  const noResultsEl = document.getElementById('no-results');
  const postGridEl = document.getElementById('post-grid');
  const publicationFilterEl = document.getElementById('publication-filter');
  const sortSelectEl = document.getElementById('sort-select');
  const searchInputEl = document.getElementById('search-input');
  const unreadOnlyEl = document.getElementById('unread-only');
  const refreshBtnEl = document.getElementById('refresh-btn');
  const statsEl = document.getElementById('stats');
  const toastEl = document.getElementById('toast');
  const toastMessageEl = toastEl.querySelector('.toast-message');

  // State
  let allPosts = [];
  let currentFilter = '';
  let currentSort = 'newest';
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
   * Render posts to grid
   */
  function renderPosts(posts) {
    postGridEl.innerHTML = '';

    if (posts.length === 0) {
      postGridEl.classList.add('hidden');
      // Distinguish "nothing collected yet" from "filters match nothing"
      if (allPosts.length === 0) {
        emptyStateEl.classList.remove('hidden');
        noResultsEl.classList.add('hidden');
      } else {
        noResultsEl.classList.remove('hidden');
        emptyStateEl.classList.add('hidden');
      }
      return;
    }

    emptyStateEl.classList.add('hidden');
    noResultsEl.classList.add('hidden');
    postGridEl.classList.remove('hidden');

    posts.forEach((post) => {
      const card = buildPostCard(post, {
        onOpen: (p) => markAsRead(p.url)
      });
      postGridEl.appendChild(card);
    });
  }

  /**
   * Enable the "Most liked" option only when we actually have like counts;
   * Substack's inbox doesn't always render them
   */
  function updateSortOptions(posts) {
    const likesOption = sortSelectEl.querySelector('option[value="likes"]');
    const hasLikes = posts.some(p => typeof p.likes === 'number');
    likesOption.disabled = !hasLikes;
    likesOption.title = hasLikes ? '' : 'No like counts collected yet';
    if (!hasLikes && currentSort === 'likes') {
      currentSort = 'newest';
      sortSelectEl.value = 'newest';
    }
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

    // Keep the current selection if it still exists
    if (currentFilter && publications.includes(currentFilter)) {
      publicationFilterEl.value = currentFilter;
    } else {
      currentFilter = '';
      publicationFilterEl.value = '';
    }
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
   * Sort a copy of the posts by the current sort mode.
   * Posts without the relevant data go last; ties fall back to newest first.
   */
  function sortPosts(posts) {
    const dateValue = (p) => {
      const time = new Date(p.publishedAt || p.extractedAt || 0).getTime();
      return isNaN(time) ? 0 : time;
    };
    const sorted = [...posts];

    switch (currentSort) {
      case 'oldest':
        sorted.sort((a, b) => dateValue(a) - dateValue(b));
        break;
      case 'likes':
        sorted.sort((a, b) =>
          ((typeof b.likes === 'number' ? b.likes : -1) - (typeof a.likes === 'number' ? a.likes : -1)) ||
          (dateValue(b) - dateValue(a))
        );
        break;
      case 'publication':
        sorted.sort((a, b) =>
          (a.publication || '').localeCompare(b.publication || '') ||
          (dateValue(b) - dateValue(a))
        );
        break;
      default: // newest
        sorted.sort((a, b) => dateValue(b) - dateValue(a));
    }

    return sorted;
  }

  /**
   * Apply publication filter, unread toggle, search query, and sort
   */
  function filterPosts() {
    let filtered = allPosts;

    if (currentFilter) {
      filtered = filtered.filter(p => p.publication === currentFilter);
    }

    if (unreadOnly) {
      filtered = filtered.filter(p => !p.isRead);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p =>
        (p.title || '').toLowerCase().includes(query) ||
        (p.subtitle || '').toLowerCase().includes(query) ||
        (p.publication || '').toLowerCase().includes(query) ||
        (p.author || '').toLowerCase().includes(query)
      );
    }

    renderPosts(sortPosts(filtered));
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
        updateSortOptions(allPosts);
        updateStats(allPosts);
        filterPosts();
      } else {
        throw new Error(response.error || 'Failed to load posts');
      }
    } catch (error) {
      console.error('[SubstackFront] Error loading posts:', error);
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

  sortSelectEl.addEventListener('change', (e) => {
    currentSort = e.target.value;
    filterPosts();
  });

  searchInputEl.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    filterPosts();
  });

  unreadOnlyEl.addEventListener('change', (e) => {
    unreadOnly = e.target.checked;
    filterPosts();
  });

  refreshBtnEl.addEventListener('click', handleRefresh);

  // Listen for storage changes (real-time updates)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.posts) {
      allPosts = changes.posts.newValue || [];
      updatePublicationFilter(allPosts);
      updateSortOptions(allPosts);
      updateStats(allPosts);
      filterPosts();
    }
  });

  // Initialize
  loadPosts();

})();
