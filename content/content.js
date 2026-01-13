// SubstackFront - Content Script
// Extracts post data from Substack inbox and sends to background worker

(function() {
  'use strict';

  // Only run on substack.com
  if (!window.location.hostname.includes('substack.com')) {
    return;
  }

  console.log('[SubstackFront] Content script loaded on:', window.location.href);

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

    // Try parsing as "Mon DD" format (e.g., "Jan 10")
    const currentYear = now.getFullYear();
    const parsed = new Date(`${dateStr.trim()}, ${currentYear}`);
    if (!isNaN(parsed.getTime())) {
      // If the date is in the future, it's probably from last year
      if (parsed > now) {
        parsed.setFullYear(currentYear - 1);
      }
      return parsed.toISOString();
    }

    return null;
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
   * Extract post data from a reader2-inbox-post element
   */
  function extractPostFromElement(postLink) {
    try {
      // The post link itself contains the URL
      const url = postLink.href;
      if (!isValidArticleUrl(url)) return null;

      // Title: .reader2-post-title
      const titleElement = postLink.querySelector('.reader2-post-title');
      const title = titleElement?.textContent?.trim();
      // Skip if no title or title is too short (likely not an article)
      if (!title || title.length < 5) return null;
      // Skip if title is a comment count (e.g., "4 Comments")
      if (/^\d+\s+Comments?$/i.test(title)) return null;

      // Subtitle/preview: .reader2-paragraph.reader2-secondary
      const subtitleElement = postLink.querySelector('.reader2-paragraph.reader2-secondary, .reader2-clamp-lines:not(.reader2-post-title)');
      let subtitle = subtitleElement?.textContent?.trim() || '';
      // Clean up subtitle if it matches title
      if (subtitle === title) subtitle = '';

      // Publication name: .pub-name a
      const pubNameElement = postLink.querySelector('.pub-name a, .pub-name');
      const publication = pubNameElement?.textContent?.trim() || 'Unknown';
      // Skip if publication is Unknown (likely not a proper article)
      if (publication === 'Unknown') return null;

      // Publication logo: img in the header area (small 20x20 image)
      const logoElement = postLink.querySelector('.reader2-post-head img');
      const publicationLogo = logoElement?.src || null;

      // Cover image - try multiple selectors, support lazy-loaded images
      let coverImage = null;
      const coverSelectors = [
        '.reader2-post-picture-container img',
        '.reader2-post-picture img',
        'img.reader2-post-picture',
        '.reader2-post-body img'
      ];
      for (const selector of coverSelectors) {
        const img = postLink.querySelector(selector);
        if (img) {
          // Check src, data-src, or srcset for lazy-loaded images
          const imgSrc = img.src || img.dataset?.src || img.getAttribute('data-src');
          if (imgSrc && imgSrc.startsWith('http')) {
            coverImage = imgSrc;
            break;
          }
        }
      }

      // Date: .inbox-item-timestamp
      const dateElement = postLink.querySelector('.inbox-item-timestamp');
      const dateText = dateElement?.textContent?.trim();
      const publishedAt = parseRelativeDate(dateText);

      // Author from meta: .reader2-item-meta (contains "Author • X min read")
      const metaElement = postLink.querySelector('.reader2-item-meta');
      let author = '';
      if (metaElement) {
        const metaText = metaElement.textContent;
        // Extract author name (before the bullet point)
        const parts = metaText.split('∙');
        if (parts.length > 0) {
          author = parts[0].trim();
        }
      }

      // Check if unread (has unread dot)
      const unreadDot = postLink.querySelector('.reader2-unread-dot, .unreadDot-O7Wu_7');
      const isRead = !unreadDot;

      // Generate unique ID from URL
      const id = url.replace(/[^a-zA-Z0-9]/g, '_');

      return {
        id,
        title,
        subtitle,
        publication,
        publicationLogo,
        author,
        coverImage,
        url,
        publishedAt,
        isRead,
        extractedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('[SubstackFront] Error extracting post:', error);
      return null;
    }
  }

  /**
   * Check if an element is a valid post container (not a thread notification)
   */
  function isValidPostElement(link) {
    // Skip elements inside tables (thread/comment notifications)
    if (link.closest('table, td, tr')) return false;

    // Skip thread-head-cta links (comment thread links)
    if (link.classList.contains('thread-head-cta')) return false;

    const linkText = link.textContent || '';
    const trimmedText = linkText.trim();

    // Skip navigation links
    if (trimmedText === 'Read →' || trimmedText === 'Read') return false;

    // Skip comment/thread notifications (combined pattern)
    if (/(\d+\s+comments?|new\s+comments?|replied\s+to)/i.test(linkText)) return false;

    return true;
  }

  /**
   * Find and extract all posts from the current page
   */
  function extractAllPosts() {
    const posts = [];
    const seenUrls = new Set();

    // Primary selector: a.reader2-inbox-post (the main post links in inbox)
    // Be specific to avoid picking up non-article links
    const postLinks = document.querySelectorAll('a.reader2-inbox-post, a[class*="reader2-inbox-post"]');

    console.log(`[SubstackFront] Found ${postLinks.length} post links with reader2-inbox-post selector`);

    postLinks.forEach(link => {
      // Skip non-post elements (thread notifications, etc.)
      if (!isValidPostElement(link)) return;

      const post = extractPostFromElement(link);
      if (post && !seenUrls.has(post.url)) {
        seenUrls.add(post.url);
        posts.push(post);
      }
    });

    return posts;
  }

  /**
   * Send extracted posts to background worker
   */
  function sendPostsToBackground(posts) {
    if (posts.length === 0) {
      console.log('[SubstackFront] No posts to send');
      return;
    }

    console.log(`[SubstackFront] Sending ${posts.length} posts to background`);

    chrome.runtime.sendMessage({
      type: 'POSTS_EXTRACTED',
      posts: posts
    }, response => {
      if (chrome.runtime.lastError) {
        console.error('[SubstackFront] Error sending message:', chrome.runtime.lastError);
      } else {
        console.log('[SubstackFront] Background response:', response);
      }
    });
  }

  /**
   * Main extraction function
   */
  function runExtraction() {
    console.log('[SubstackFront] Running extraction...');
    const posts = extractAllPosts();
    console.log(`[SubstackFront] Extracted ${posts.length} posts`);

    if (posts.length > 0) {
      console.log('[SubstackFront] Sample post:', posts[0]);
    }

    sendPostsToBackground(posts);
  }

  // Debounce helper
  let extractionTimeout;
  function scheduleExtraction(delay = 500) {
    clearTimeout(extractionTimeout);
    extractionTimeout = setTimeout(runExtraction, delay);
  }

  // Run extraction after page loads
  if (document.readyState === 'complete') {
    scheduleExtraction(500);
  } else {
    window.addEventListener('load', () => scheduleExtraction(500));
  }

  // Re-run when user scrolls (for infinite scroll)
  window.addEventListener('scroll', () => scheduleExtraction(1000), { passive: true });

  // Observe DOM changes for dynamically loaded content
  const observer = new MutationObserver((mutations) => {
    const hasNewPosts = mutations.some(m =>
      Array.from(m.addedNodes).some(node =>
        node.nodeType === 1 && (
          node.matches?.('a.reader2-inbox-post, a[class*="reader2-inbox-post"]') ||
          node.querySelector?.('a.reader2-inbox-post, a[class*="reader2-inbox-post"]')
        )
      )
    );

    if (hasNewPosts) {
      console.log('[SubstackFront] New posts detected in DOM');
      scheduleExtraction(1000);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Listen for messages from background script (e.g., refresh trigger)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TRIGGER_EXTRACTION') {
      console.log('[SubstackFront] Received extraction trigger from background');
      runExtraction();
      sendResponse({ success: true });
    }
    return true;
  });

})();
