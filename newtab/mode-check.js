// Check popup-only mode and redirect if enabled
// This script runs before the page renders
// The HTML element has class="loading-mode" which hides the body via CSS

(function() {
  'use strict';

  chrome.storage.local.get(['popupOnlyMode'], function(result) {
    if (result.popupOnlyMode === true) {
      // Try to show Chrome's default new tab page
      // Use the background script to handle navigation
      chrome.runtime.sendMessage({ type: 'OPEN_DEFAULT_NEWTAB' });
    } else {
      // Show the page by removing the loading-mode class
      document.documentElement.classList.remove('loading-mode');
    }
  });
})();
