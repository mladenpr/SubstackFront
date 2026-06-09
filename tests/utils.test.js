// Unit tests for the pure functions in shared/utils.js
// Run with: node --test

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeArticleUrl,
  isValidArticleUrl,
  parseRelativeDate,
  formatRelativeDate,
  getInitial
} = require('../shared/utils.js');

// Allow small clock drift between "now" inside the function and the assertion
const TOLERANCE_MS = 5000;

function assertCloseTo(isoString, expectedMs, message) {
  const actualMs = new Date(isoString).getTime();
  assert.ok(Math.abs(actualMs - expectedMs) < TOLERANCE_MS,
    `${message}: expected ~${new Date(expectedMs).toISOString()}, got ${isoString}`);
}

test('normalizeArticleUrl strips query params and hash', () => {
  assert.strictEqual(
    normalizeArticleUrl('https://example.substack.com/p/my-post?utm_source=x&utm_medium=email#hash'),
    'https://example.substack.com/p/my-post'
  );
});

test('normalizeArticleUrl leaves clean URLs unchanged', () => {
  assert.strictEqual(
    normalizeArticleUrl('https://example.substack.com/p/my-post'),
    'https://example.substack.com/p/my-post'
  );
});

test('normalizeArticleUrl returns invalid input as-is', () => {
  assert.strictEqual(normalizeArticleUrl('not a url'), 'not a url');
  assert.strictEqual(normalizeArticleUrl(null), null);
});

test('isValidArticleUrl accepts post URLs', () => {
  assert.strictEqual(isValidArticleUrl('https://example.substack.com/p/my-post'), true);
});

test('isValidArticleUrl rejects non-articles', () => {
  assert.strictEqual(isValidArticleUrl(null), false);
  assert.strictEqual(isValidArticleUrl('https://example.substack.com/about'), false);
  assert.strictEqual(isValidArticleUrl('https://example.substack.com/p/my-post/comments'), false);
  assert.strictEqual(isValidArticleUrl('https://example.substack.com/p/my-post/comment/123'), false);
  assert.strictEqual(isValidArticleUrl('https://example.substack.com/p/my-post?action=share'), false);
  assert.strictEqual(isValidArticleUrl('https://example.substack.com/p/my-post/discussion'), false);
});

test('parseRelativeDate handles short relative times', () => {
  assertCloseTo(parseRelativeDate('2h ago'), Date.now() - 2 * 3600000, '2h ago');
  assertCloseTo(parseRelativeDate('5m ago'), Date.now() - 5 * 60000, '5m ago');
  assertCloseTo(parseRelativeDate('30s ago'), Date.now() - 30000, '30s ago');
});

test('parseRelativeDate handles long relative times', () => {
  assertCloseTo(parseRelativeDate('3 days ago'), Date.now() - 3 * 86400000, '3 days ago');
  assertCloseTo(parseRelativeDate('10 minutes ago'), Date.now() - 10 * 60000, '10 minutes ago');
});

test('parseRelativeDate handles yesterday and today', () => {
  assertCloseTo(parseRelativeDate('yesterday'), Date.now() - 86400000, 'yesterday');
  assertCloseTo(parseRelativeDate('today'), Date.now(), 'today');
});

test('parseRelativeDate handles time-only format as today', () => {
  const result = parseRelativeDate('11:37 PM');
  assert.ok(result, 'should parse');
  const date = new Date(result);
  assert.strictEqual(date.getHours(), 23);
  assert.strictEqual(date.getMinutes(), 37);

  const morning = new Date(parseRelativeDate('12:05 AM'));
  assert.strictEqual(morning.getHours(), 0);
  assert.strictEqual(morning.getMinutes(), 5);
});

test('parseRelativeDate handles "Mon DD" and assumes past dates', () => {
  const result = parseRelativeDate('Jan 10');
  assert.ok(result, 'should parse');
  const date = new Date(result);
  assert.strictEqual(date.getMonth(), 0);
  assert.strictEqual(date.getDate(), 10);
  assert.ok(date <= new Date(), 'should never be in the future');
});

test('parseRelativeDate returns null for unparseable input', () => {
  assert.strictEqual(parseRelativeDate(''), null);
  assert.strictEqual(parseRelativeDate(null), null);
  assert.strictEqual(parseRelativeDate('complete nonsense'), null);
});

test('formatRelativeDate formats recent times', () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
  assert.strictEqual(formatRelativeDate(fiveMinAgo), '5m ago');
  assert.strictEqual(formatRelativeDate(fiveMinAgo, true), '5m');

  const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
  assert.strictEqual(formatRelativeDate(twoHoursAgo), '2h ago');
  assert.strictEqual(formatRelativeDate(twoHoursAgo, true), '2h');

  assert.strictEqual(formatRelativeDate(new Date().toISOString()), 'Just now');
  assert.strictEqual(formatRelativeDate(null), '');
});

test('getInitial returns uppercase first letter with fallback', () => {
  assert.strictEqual(getInitial('astral codex ten'), 'A');
  assert.strictEqual(getInitial(''), 'S');
  assert.strictEqual(getInitial(null), 'S');
});
