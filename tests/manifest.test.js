'use strict';

// Validates the Chrome manifest, the Safari build script, and the manifest it
// generates. Catches drift between the two builds and dangling file references
// that a browser would only surface at load time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { REPO_ROOT } = require('./helpers/extension-stub.js');

const CHROME_MANIFEST_PATH = path.join(REPO_ROOT, 'manifest.json');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'safari', 'build.sh');
const PAYLOAD_DIR = path.join(REPO_ROOT, 'safari', 'build', 'extension');
const SAFARI_MANIFEST_PATH = path.join(PAYLOAD_DIR, 'manifest.json');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Assemble the Safari payload. Memoized so tests can run in any order, or one
 * at a time, without depending on a previous test having built it.
 */
let buildOutput = null;
function ensurePayload() {
  if (buildOutput === null) {
    buildOutput = execFileSync('bash', [BUILD_SCRIPT, '--no-convert'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    });
  }
  return buildOutput;
}

/** Every extension-relative file path a manifest points at. */
function referencedPaths(manifest) {
  const paths = [];
  const background = manifest.background || {};

  if (background.service_worker) paths.push(background.service_worker);
  if (Array.isArray(background.scripts)) paths.push(...background.scripts);

  for (const script of manifest.content_scripts || []) {
    paths.push(...(script.js || []), ...(script.css || []));
  }

  if (manifest.action && manifest.action.default_popup) {
    paths.push(manifest.action.default_popup);
  }
  paths.push(...Object.values((manifest.action || {}).default_icon || {}));
  paths.push(...Object.values(manifest.icons || {}));

  return [...new Set(paths)];
}

/** Local src=/href= references inside an HTML file. */
function htmlReferences(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => match[1])
    .filter(ref => !/^(https?:|data:|#|\/\/)/.test(ref));
}

function assertReferencesResolve(manifest, rootDir, label) {
  for (const relative of referencedPaths(manifest)) {
    const target = path.join(rootDir, relative);
    assert.ok(fs.existsSync(target), `${label}: manifest references missing file ${relative}`);

    if (relative.endsWith('.html')) {
      for (const ref of htmlReferences(target)) {
        const resolved = path.resolve(path.dirname(target), ref);
        assert.ok(fs.existsSync(resolved), `${label}: ${relative} references missing file ${ref}`);
      }
    }
  }
}

test('Chrome manifest is a valid MV3 service-worker extension', () => {
  const manifest = readJson(CHROME_MANIFEST_PATH);

  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.version && manifest.description);
  assert.equal(typeof manifest.background.service_worker, 'string');
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.host_permissions.some(p => p.includes('substack.com')));
  assertReferencesResolve(manifest, REPO_ROOT, 'chrome');
});

test('safari/build.sh assembles a payload without Xcode', () => {
  assert.match(ensurePayload(), /Payload ready/);
  assert.ok(fs.existsSync(SAFARI_MANIFEST_PATH), 'expected a generated Safari manifest');
});

test('Safari manifest uses a non-persistent background page', () => {
  ensurePayload();
  const manifest = readJson(SAFARI_MANIFEST_PATH);

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background.scripts, ['background/background.js']);
  assert.equal(manifest.background.persistent, false);
  assert.equal(manifest.background.service_worker, undefined,
    'Safari must not get a background service worker - host_permissions are not applied to one');
});

test('Safari manifest does not drift from the Chrome manifest', () => {
  ensurePayload();
  const chrome = readJson(CHROME_MANIFEST_PATH);
  const safari = readJson(SAFARI_MANIFEST_PATH);

  // Everything except `background` is generated straight from the Chrome
  // manifest, so any difference here means the two builds have diverged.
  for (const key of ['name', 'version', 'description', 'permissions',
                     'host_permissions', 'action', 'content_scripts', 'icons']) {
    assert.deepEqual(safari[key], chrome[key], `Safari manifest diverged on "${key}"`);
  }

  const overridden = Object.keys(chrome).filter(
    key => JSON.stringify(chrome[key]) !== JSON.stringify(safari[key])
  );
  assert.deepEqual(overridden, ['background'],
    'only `background` should differ between the two manifests');
});

test('generated Safari manifest has no comment keys and resolves every path', () => {
  ensurePayload();
  const manifest = readJson(SAFARI_MANIFEST_PATH);

  const commentKeys = Object.keys(manifest).filter(key => key.startsWith('_'));
  assert.deepEqual(commentKeys, [], 'underscore-prefixed keys must be stripped');

  assertReferencesResolve(manifest, PAYLOAD_DIR, 'safari');
});

test('Safari payload ships no stray files', () => {
  ensurePayload();
  const entries = fs.readdirSync(PAYLOAD_DIR).sort();
  assert.deepEqual(entries,
    ['background', 'content', 'icons', 'manifest.json', 'newtab', 'popup']);
});
