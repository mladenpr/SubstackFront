// SubstackFront - Shared utilities
// Loaded by the content script (via manifest), the background worker (via
// importScripts), and the UI pages (via <script> tag). Also exported for
// Node's test runner.

(function (global) {
  'use strict';

  /**
   * Strip query string and hash so the same article scraped with different
   * tracking params (utm_*, etc.) deduplicates to one post.
   */
  function normalizeArticleUrl(url) {
    if (!url) return url;
    try {
      const parsed = new URL(url);
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch (e) {
      return url;
    }
  }

  /**
   * Check if a URL is a valid article URL (not a comment or other non-article)
   */
  function isValidArticleUrl(url) {
    if (!url) return false;
    // Must contain /p/ for posts
    if (!url.includes('/p/')) return false;
    // Exclude comments - check various patterns
    if (url.includes('/comments')) return false;
    if (url.includes('/comment/')) return false;
    if (url.includes('/comment?')) return false;
    if (url.endsWith('/comment')) return false;
    // Exclude other non-article patterns
    if (url.includes('/subscribe') || url.includes('/about') || url.includes('/archive')) return false;
    // Exclude URLs with query params that indicate non-article views
    if (url.includes('?action=') || url.includes('&action=')) return false;
    // Exclude discussion/thread URLs
    if (url.includes('/discussion')) return false;
    return true;
  }

  /**
   * Parse date string - handles relative times and absolute dates
   */
  function parseRelativeDate(dateStr) {
    if (!dateStr) return null;

    const cleaned = dateStr.trim().toLowerCase();
    const now = new Date();

    // Handle relative times: "2h ago", "5m ago", "30s ago"
    const relativeMatch = cleaned.match(/^(\d+)\s*(s|m|h|d)\s*ago$/i);
    if (relativeMatch) {
      const value = parseInt(relativeMatch[1], 10);
      const unit = relativeMatch[2].toLowerCase();
      const date = new Date(now);
      if (unit === 's') date.setSeconds(date.getSeconds() - value);
      else if (unit === 'm') date.setMinutes(date.getMinutes() - value);
      else if (unit === 'h') date.setHours(date.getHours() - value);
      else if (unit === 'd') date.setDate(date.getDate() - value);
      return date.toISOString();
    }

    // Handle "yesterday"
    if (cleaned === 'yesterday') {
      const date = new Date(now);
      date.setDate(date.getDate() - 1);
      return date.toISOString();
    }

    // Handle "today"
    if (cleaned === 'today') {
      return now.toISOString();
    }

    // Handle time-only format like "11:37 PM" or "3:45 AM" (means today)
    const timeMatch = dateStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const period = timeMatch[3].toUpperCase();

      // Convert to 24-hour format
      if (period === 'PM' && hours !== 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;

      const date = new Date(now);
      date.setHours(hours, minutes, 0, 0);
      return date.toISOString();
    }

    // Handle "X hours ago", "X minutes ago", "X days ago"
    const longRelativeMatch = cleaned.match(/^(\d+)\s*(second|minute|hour|day)s?\s*ago$/i);
    if (longRelativeMatch) {
      const value = parseInt(longRelativeMatch[1], 10);
      const unit = longRelativeMatch[2].toLowerCase();
      const date = new Date(now);
      if (unit === 'second') date.setSeconds(date.getSeconds() - value);
      else if (unit === 'minute') date.setMinutes(date.getMinutes() - value);
      else if (unit === 'hour') date.setHours(date.getHours() - value);
      else if (unit === 'day') date.setDate(date.getDate() - value);
      return date.toISOString();
    }

    // Handle "Mon DD" or "Mon DD, YYYY" (e.g., "Jan 10"). Match the shape
    // first - V8's lenient Date parser would otherwise turn arbitrary text
    // containing a number into a bogus date.
    const monthDayMatch = dateStr.trim().match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
    if (monthDayMatch) {
      const currentYear = now.getFullYear();
      const year = monthDayMatch[3] || currentYear;
      const parsed = new Date(`${monthDayMatch[1]} ${monthDayMatch[2]}, ${year}`);
      if (!isNaN(parsed.getTime())) {
        // Without an explicit year, a future date is probably from last year
        if (!monthDayMatch[3] && parsed > now) {
          parsed.setFullYear(currentYear - 1);
        }
        return parsed.toISOString();
      }
    }

    return null;
  }

  /**
   * Format a stored ISO date as relative time for display.
   * Compact mode ("5m", "2h") is used in the popup.
   */
  function formatRelativeDate(dateString, compact = false) {
    if (!dateString) return '';

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return compact ? `${diffMins}m` : `${diffMins}m ago`;
    if (diffHours < 24) return compact ? `${diffHours}h` : `${diffHours}h ago`;
    if (diffDays < 7) return compact ? `${diffDays}d` : `${diffDays}d ago`;

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
   * Parse a UI count like "24", "1,204" or "1.2K" into a number.
   * Returns null for anything that isn't purely a count.
   */
  function parseCount(text) {
    if (text === null || text === undefined) return null;
    const match = String(text).trim().match(/^([\d,]+(?:\.\d+)?)\s*([kKmM])?$/);
    if (!match) return null;
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (isNaN(num)) return null;
    const multiplier = match[2]
      ? (match[2].toLowerCase() === 'k' ? 1000 : 1000000)
      : 1;
    return Math.round(num * multiplier);
  }

  /**
   * Format a count for display: 1234 -> "1.2K"
   */
  function formatCount(count) {
    if (typeof count !== 'number' || isNaN(count)) return '';
    if (count >= 1000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(count);
  }

  /**
   * Build a post card as a real link (keyboard focusable, middle-click works).
   * Built with DOM APIs so post data never goes through innerHTML.
   *
   * options.compact - popup layout: no subtitle, short date format
   * options.onOpen  - called when the user opens the post (mark-as-read hook)
   */
  function buildPostCard(post, options = {}) {
    const { compact = false, onOpen } = options;

    const card = document.createElement('a');
    card.className = `post-card${post.isRead ? ' read' : ''}`;
    card.href = post.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.dataset.url = post.url;

    if (post.coverImage) {
      const img = document.createElement('img');
      img.className = 'post-image';
      img.src = post.coverImage;
      img.alt = '';
      img.loading = 'lazy';
      card.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'post-image-placeholder';
      placeholder.textContent = getInitial(post.publication);
      card.appendChild(placeholder);
    }

    const content = document.createElement('div');
    content.className = 'post-content';

    const publication = document.createElement('div');
    publication.className = 'post-publication';
    if (post.publicationLogo) {
      const logo = document.createElement('img');
      logo.className = 'publication-logo';
      logo.src = post.publicationLogo;
      logo.alt = '';
      publication.appendChild(logo);
    }
    const publicationName = document.createElement('span');
    publicationName.className = 'publication-name';
    publicationName.textContent = post.publication;
    publication.appendChild(publicationName);
    content.appendChild(publication);

    const title = document.createElement('h2');
    title.className = 'post-title';
    title.textContent = post.title;
    content.appendChild(title);

    if (!compact && post.subtitle) {
      const subtitle = document.createElement('p');
      subtitle.className = 'post-subtitle';
      subtitle.textContent = post.subtitle;
      content.appendChild(subtitle);
    }

    const meta = document.createElement('div');
    meta.className = 'post-meta';
    const date = document.createElement('span');
    date.className = 'post-date';
    date.textContent = formatRelativeDate(post.publishedAt, compact);
    meta.appendChild(date);
    if (typeof post.likes === 'number') {
      const likes = document.createElement('span');
      likes.className = 'post-likes';
      likes.title = `${post.likes} likes`;
      likes.textContent = `♥ ${formatCount(post.likes)}`;
      meta.appendChild(likes);
    }
    if (!post.isRead) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.title = 'Unread';
      meta.appendChild(dot);
    }
    content.appendChild(meta);
    card.appendChild(content);

    if (onOpen) {
      card.addEventListener('click', () => onOpen(post));
      // Middle-click navigates without firing 'click'
      card.addEventListener('auxclick', (event) => {
        if (event.button === 1) onOpen(post);
      });
    }

    return card;
  }

  const SubstackShared = {
    normalizeArticleUrl,
    isValidArticleUrl,
    parseRelativeDate,
    formatRelativeDate,
    getInitial,
    parseCount,
    formatCount,
    buildPostCard
  };

  global.SubstackShared = SubstackShared;

  // Allow Node's test runner to import the pure functions
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SubstackShared;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
