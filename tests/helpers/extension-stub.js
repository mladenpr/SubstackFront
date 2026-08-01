'use strict';

// Loads background/background.js into an isolated VM context backed by a stub
// WebExtensions API, so the cross-browser behaviour can be exercised without a
// real browser.
//
// The stub defaults to the *Safari* shape - promise-returning APIs and no
// storage.local.getBytesInUse - because that is the surface most likely to
// regress. Pass { getBytesInUse: true } for the Chrome shape.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BACKGROUND_PATH = path.join(REPO_ROOT, 'background', 'background.js');

const VERBOSE = process.env.SUBSTACK_TEST_VERBOSE === '1';

function makeConsole() {
  if (VERBOSE) return console;
  const noop = () => {};
  return { log: noop, warn: noop, error: noop, info: noop, debug: noop };
}

/**
 * Rewrite the refresh timing constants so timeout behaviour can be tested in
 * milliseconds rather than half a minute. Throws if a constant has been
 * renamed, so this never silently stops applying.
 */
function rewriteTimings(source, timings) {
  let out = source;

  for (const [name, value] of Object.entries(timings)) {
    const pattern = new RegExp(`^const ${name} = [^;]+;$`, 'm');
    if (!pattern.test(out)) {
      throw new Error(
        `background.js has no top-level constant "${name}". ` +
        'Update tests/helpers/extension-stub.js to match.'
      );
    }
    out = out.replace(pattern, `const ${name} = ${JSON.stringify(value)};`);
  }

  return out;
}

/**
 * Build a stub chrome/browser API.
 */
function createChromeStub(options = {}) {
  const {
    getBytesInUse = false,
    failGetAll = false,
    initialStore = {},
    onTabMessage = null
  } = options;

  const store = { ...initialStore };
  const calls = { tabsCreated: [], tabsRemoved: [], tabMessages: [] };
  const listeners = { message: [], installed: [], tabUpdated: [] };
  let nextTabId = 100;

  const local = {
    async get(keys) {
      if (keys === null || keys === undefined) {
        if (failGetAll) throw new Error('storage read failed');
        return { ...store };
      }
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        wanted.filter(key => key in store).map(key => [key, store[key]])
      );
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }
  };

  // Safari does not implement this; only add it for the Chrome-shaped stub.
  if (getBytesInUse) {
    local.getBytesInUse = async () => Buffer.byteLength(JSON.stringify(store));
  }

  const chrome = {
    storage: {
      local,
      onChanged: { addListener() {}, removeListener() {} }
    },
    runtime: {
      onMessage: {
        addListener(fn) { listeners.message.push(fn); },
        removeListener() {}
      },
      onInstalled: {
        addListener(fn) { listeners.installed.push(fn); },
        removeListener() {}
      },
      getURL: relative => `stub-extension://test/${relative}`
    },
    tabs: {
      async create(createProperties) {
        const tab = { id: nextTabId++, ...createProperties };
        calls.tabsCreated.push(tab);
        return tab;
      },
      async remove(tabId) {
        calls.tabsRemoved.push(tabId);
      },
      async sendMessage(tabId, message) {
        calls.tabMessages.push({ tabId, message });
        if (!onTabMessage) throw new Error('Could not establish connection');
        return onTabMessage(message, tabId);
      },
      onUpdated: {
        addListener(fn) { listeners.tabUpdated.push(fn); },
        removeListener(fn) {
          const index = listeners.tabUpdated.indexOf(fn);
          if (index !== -1) listeners.tabUpdated.splice(index, 1);
        }
      }
    }
  };

  return { chrome, store, calls, listeners };
}

/**
 * Load background.js against a stub API.
 *
 * @param {object} options
 * @param {boolean} options.getBytesInUse - expose storage.local.getBytesInUse (Chrome shape)
 * @param {boolean} options.failGetAll    - make storage.local.get(null) throw
 * @param {object}  options.initialStore   - seed chrome.storage.local
 * @param {Function} options.onTabMessage  - handle tabs.sendMessage; throws by default
 * @param {object}  options.timings        - override refresh timing constants
 * @param {string}  options.namespace      - 'chrome' (default) or 'browser' to
 *                                           test the Safari alias guard
 */
function loadBackground(options = {}) {
  const { timings = null, namespace = 'chrome' } = options;
  const stub = createChromeStub(options);

  let source = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  if (timings) source = rewriteTimings(source, timings);

  const sandbox = {
    console: makeConsole(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder
  };
  sandbox[namespace] = stub.chrome;

  const context = vm.createContext(sandbox);
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'background.js' });

  if (stub.listeners.message.length === 0) {
    throw new Error('background.js did not register a runtime.onMessage listener');
  }

  return {
    ...stub,
    context,

    /** Send a message as the popup, tab view, or a content script. */
    sendMessage(message, sender = {}) {
      return new Promise((resolve, reject) => {
        try {
          stub.listeners.message[0](message, sender, resolve);
        } catch (error) {
          reject(error);
        }
      });
    },

    /** Fire runtime.onInstalled. */
    async fireInstalled(details = { reason: 'install' }) {
      for (const listener of stub.listeners.installed) await listener(details);
    },

    /** Fire tabs.onUpdated. */
    fireTabUpdated(tabId, changeInfo) {
      for (const listener of [...stub.listeners.tabUpdated]) listener(tabId, changeInfo);
    }
  };
}

/** Build a plausible extracted post. */
function makePost(n, overrides = {}) {
  return {
    id: `post_${n}`,
    title: `Post number ${n}`,
    subtitle: 'A subtitle',
    publication: `Publication ${n % 3}`,
    publicationLogo: null,
    author: 'Someone',
    coverImage: null,
    url: `https://example.substack.com/p/post-${n}`,
    publishedAt: new Date(Date.UTC(2026, 0, 1 + (n % 28))).toISOString(),
    isRead: false,
    extractedAt: new Date(Date.UTC(2026, 0, 1 + (n % 28))).toISOString(),
    ...overrides
  };
}

/** Wait for pending timers/microtasks to flush. */
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Re-anchor a value to this realm's intrinsics. Objects and arrays created
 * inside the VM context have their own Array/Object prototypes, which
 * deepStrictEqual rejects.
 */
const plain = value => JSON.parse(JSON.stringify(value));

module.exports = { loadBackground, makePost, tick, plain, REPO_ROOT, BACKGROUND_PATH };
