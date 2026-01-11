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
   * Parse relative date string like "Jan 10" or "Dec 25" to ISO date
   */
  function parseRelativeDate(dateStr) {
    if (!dateStr) return null;

    const cleaned = dateStr.trim();
    const currentYear = new Date().getFullYear();

    // Try parsing as "Mon DD" format
    const parsed = new Date(`${cleaned}, ${currentYear}`);
    if (!isNaN(parsed.getTime())) {
      // If the date is in the future, it's probably from last year
      if (parsed > new Date()) {
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
    // Exclude comments - these have /comments or /comment/ in the URL
    if (url.includes('/comments') || url.includes('/comment/')) return false;
    // Exclude other non-article patterns
    if (url.includes('/subscribe') || url.includes('/about') || url.includes('/archive')) return false;
    // Exclude URLs with query params that indicate non-article views
    if (url.includes('?action=') || url.includes('&action=')) return false;
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

      // Cover image - try multiple selectors
      let coverImage = null;
      const coverSelectors = [
        '.reader2-post-picture-container img',
        '.reader2-post-picture img',
        '.reader2-post-body img[src*="substackcdn"]',
        'img.reader2-post-picture',
        'img[src*="substackcdn"][width="400"]'
      ];
      for (const selector of coverSelectors) {
        const img = postLink.querySelector(selector);
        if (img?.src && img.src.includes('substackcdn')) {
          coverImage = img.src;
          break;
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
      const post = extractPostFromElement(link);
      if (post && !seenUrls.has(post.url)) {
        seenUrls.add(post.url);
        posts.push(post);
      }
    });

    // Fallback: look for any links to /p/ posts if primary selector fails
    if (posts.length === 0) {
      console.log('[SubstackFront] Primary selector failed, trying fallback...');
      const allPostLinks = document.querySelectorAll('a[href*="/p/"]');

      allPostLinks.forEach(link => {
        if (seenUrls.has(link.href)) return;

        // Try to find title nearby
        const container = link.closest('div, article');
        const titleEl = container?.querySelector('[class*="title"], h2, h3, strong');
        const title = titleEl?.textContent?.trim() || link.textContent?.trim();

        if (title && title.length > 5) {
          seenUrls.add(link.href);
          posts.push({
            id: link.href.replace(/[^a-zA-Z0-9]/g, '_'),
            title,
            subtitle: '',
            publication: 'Unknown',
            publicationLogo: null,
            author: '',
            coverImage: null,
            url: link.href,
            publishedAt: null,
            isRead: false,
            extractedAt: new Date().toISOString()
          });
        }
      });
    }

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
  function scheduleExtraction(delay = 1500) {
    clearTimeout(extractionTimeout);
    extractionTimeout = setTimeout(runExtraction, delay);
  }

  // Run extraction after page loads
  if (document.readyState === 'complete') {
    scheduleExtraction(1500);
  } else {
    window.addEventListener('load', () => scheduleExtraction(1500));
  }

  // Re-run when user scrolls (for infinite scroll)
  window.addEventListener('scroll', () => scheduleExtraction(2000), { passive: true });

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

  // Also expose a manual trigger for debugging
  window.__substackFrontExtract = runExtraction;
  console.log('[SubstackFront] Manual extraction available: window.__substackFrontExtract()');

})();
