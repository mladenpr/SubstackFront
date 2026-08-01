'use strict';

// The popup and the tab view each carry their own copy of isIOS(), matching how
// this codebase already duplicates escapeHtml/formatRelativeDate/getInitial
// rather than introducing a shared module. Duplication is only safe if it
// cannot drift, so pin the two copies together and check the logic itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { REPO_ROOT } = require('./helpers/extension-stub.js');

const COPIES = ['popup/popup.js', 'newtab/newtab.js'];

/** Pull the source of isIOS() out of a UI script. */
function extractIsIOS(relativePath) {
  const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  const match = source.match(/ {2}function isIOS\(\) \{\n(?:.*\n)*? {2}\}\n/);
  assert.ok(match, `${relativePath} has no isIOS() function`);
  return match[0];
}

/** Run a copy of isIOS() against a fake navigator. */
function runIsIOS(functionSource, navigator) {
  const context = vm.createContext({ navigator });
  vm.runInContext(`${functionSource}\nvar result = isIOS();`, context);
  return context.result;
}

test('both UI scripts define isIOS()', () => {
  for (const file of COPIES) assert.ok(extractIsIOS(file).length > 0);
});

test('the two copies of isIOS() have not drifted', () => {
  const [popup, newtab] = COPIES.map(extractIsIOS);
  assert.equal(popup, newtab,
    'popup/popup.js and newtab/newtab.js must carry an identical isIOS()');
});

const CASES = [
  // [label, userAgent, maxTouchPoints, expected]
  ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1', 5, true],
  ['iPad (legacy UA)', 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1', 5, true],
  ['iPod touch', 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', 5, true],
  ['iPadOS 13+ desktop UA', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 5, true],
  ['macOS Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 0, false],
  ['macOS Chrome', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 0, false],
  ['Windows Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 0, false],
  ['Linux Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 0, false],
  ['Windows touchscreen Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 10, false]
];

for (const [label, userAgent, maxTouchPoints, expected] of CASES) {
  test(`isIOS() returns ${expected} for ${label}`, () => {
    const source = extractIsIOS(COPIES[0]);
    assert.equal(runIsIOS(source, { userAgent, maxTouchPoints }), expected);
  });
}

test('the refresh button is only wired up off iOS', () => {
  // Guards against re-adding an unconditional listener next to the iOS branch.
  for (const file of COPIES) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    assert.match(source, /if \(isIOS\(\)\) \{\n\s+replaceRefreshWithInboxLink\(\);\n\s+\} else \{\n\s+refreshBtnEl\.addEventListener\('click', handleRefresh\);\n\s+\}/,
      `${file} must only attach the refresh handler on the non-iOS branch`);
  }
});
