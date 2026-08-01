'use strict';

// Both stores get their package from scripts/shipping-files.txt. These tests
// guard the two ways that goes wrong: shipping a file that should have stayed
// in the repo, and building an archive Chrome will reject on upload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { REPO_ROOT } = require('./helpers/extension-stub.js');

const LIST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'list-shipping-files.sh');
const CHROME_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-chrome.sh');
const SAFARI_SCRIPT = path.join(REPO_ROOT, 'safari', 'build.sh');

const run = (script, args = []) =>
  execFileSync('bash', [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });

const shippingFiles = run(LIST_SCRIPT).trim().split('\n').filter(Boolean);

/** Build the Chrome zip once into a temp dir and list its entries. */
let zipEntries = null;
function chromeZipEntries() {
  if (zipEntries === null) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'substack-chrome-'));
    run(CHROME_SCRIPT, ['--output-dir', out]);
    const zip = fs.readdirSync(out).find(name => name.endsWith('.zip'));
    assert.ok(zip, 'build-chrome.sh produced no zip');

    const listing = execFileSync('unzip', ['-Z1', path.join(out, zip)], { encoding: 'utf8' });
    zipEntries = { name: zip, entries: listing.trim().split('\n').filter(Boolean).sort() };
    fs.rmSync(out, { recursive: true, force: true });
  }
  return zipEntries;
}

test('every shipping pattern resolves to a real file', () => {
  assert.ok(shippingFiles.length >= 12, `only ${shippingFiles.length} files resolved`);
  for (const relative of shippingFiles) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, relative)), `${relative} does not exist`);
  }
});

test('everything the manifest references is shipped', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap(script => script.js),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ];

  for (const relative of new Set(referenced)) {
    assert.ok(shippingFiles.includes(relative), `${relative} is referenced but not shipped`);
  }
});

test('repo-only files stay out of the package', () => {
  // Everything here would either bloat the upload or leak development detail.
  const forbidden = [/^tests\//, /^safari\//, /^\.github\//, /^scripts\//,
                     /^CLAUDE\.md$/, /^PRIVACY\.md$/, /^\.gitignore$/];

  for (const relative of shippingFiles) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(relative), `${relative} must not ship`);
    }
  }
});

test('App Store artwork does not ship inside the extension', () => {
  // icons/ holds appicon-source.png for the Mac wrapper app. A directory-level
  // glob here put ~1MB of dead weight into every build.
  assert.ok(!shippingFiles.some(file => file.includes('appicon-source')),
    'appicon-source.png is App Store artwork and must not ship in the extension');

  for (const relative of shippingFiles.filter(file => file.startsWith('icons/'))) {
    const bytes = fs.statSync(path.join(REPO_ROOT, relative)).size;
    assert.ok(bytes < 100 * 1024, `${relative} is ${bytes} bytes - too large for a toolbar icon`);
  }
});

test('the Chrome zip has manifest.json at its top level', () => {
  // The Web Store rejects an archive whose manifest is nested in a directory,
  // which is what zipping the containing folder produces.
  const { entries } = chromeZipEntries();
  assert.ok(entries.includes('manifest.json'),
    `manifest.json is not at the archive root: ${entries.slice(0, 3).join(', ')}...`);
});

test('the Chrome zip contains exactly the shipping files', () => {
  const { entries } = chromeZipEntries();
  assert.deepEqual(entries, [...shippingFiles].sort());
});

test('the zip is named for the manifest version', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  assert.match(chromeZipEntries().name, new RegExp(`${manifest.version.replace(/\./g, '\\.')}\\.zip$`));
});

test('Chrome and Safari ship the same files', () => {
  run(SAFARI_SCRIPT, ['--no-convert']);
  const payload = path.join(REPO_ROOT, 'safari', 'build', 'extension');

  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? walk(path.join(dir, entry.name))
      : [path.relative(payload, path.join(dir, entry.name))]);

  assert.deepEqual(walk(payload).sort(), chromeZipEntries().entries,
    'the two packagers disagree about what ships');
});
