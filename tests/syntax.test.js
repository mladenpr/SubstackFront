'use strict';

// Parses every shipped script. The extension has no build step, so a syntax
// error would otherwise only surface when a browser refuses to load it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { REPO_ROOT } = require('./helpers/extension-stub.js');

const SOURCE_DIRS = ['background', 'content', 'newtab', 'popup'];

const scripts = SOURCE_DIRS.flatMap(dir =>
  fs.readdirSync(path.join(REPO_ROOT, dir))
    .filter(file => file.endsWith('.js'))
    .map(file => path.join(dir, file))
);

test('there are scripts to check', () => {
  assert.ok(scripts.length >= 4, `expected at least 4 scripts, found ${scripts.length}`);
});

for (const script of scripts) {
  test(`${script} parses`, () => {
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['--check', script], { cwd: REPO_ROOT, stdio: 'pipe' });
    });
  });
}

test('entry scripts guard the chrome/browser namespace', () => {
  // Safari and Firefox alias `chrome`, but the guard is what makes that
  // assumption safe to rely on. Losing it from a file would fail silently
  // until someone ran that build.
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(REPO_ROOT, script), 'utf8');
    assert.match(source, /globalThis\.chrome\s*=\s*globalThis\.browser/,
      `${script} is missing the chrome/browser namespace guard`);
  }
});
