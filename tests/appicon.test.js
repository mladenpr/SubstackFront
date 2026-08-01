'use strict';

// The app icon set is generated once by safari/make-appicon.py and committed,
// so nothing validates it at build time. A wrong size or a stray alpha channel
// does not fail the Xcode build - it fails App Store submission, days later.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { REPO_ROOT } = require('./helpers/extension-stub.js');

const SOURCE = path.join(REPO_ROOT, 'icons', 'appicon-source.png');
const ICONSET = path.join(REPO_ROOT, 'safari', 'appicon', 'AppIcon.appiconset');
const CONTENTS = path.join(ICONSET, 'Contents.json');

const COLOR_TYPE = { 0: 'grayscale', 2: 'rgb', 3: 'palette', 4: 'grayscale+alpha', 6: 'rgba' };

/** Read a PNG's IHDR without pulling in an image library. */
function readPng(file) {
  const data = fs.readFileSync(file);
  assert.ok(
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    `${path.basename(file)} is not a PNG`
  );
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    colorType: data[25],
    bytes: data.length
  };
}

const contents = JSON.parse(fs.readFileSync(CONTENTS, 'utf8'));

test('the icon source is square and large enough for the App Store', () => {
  const png = readPng(SOURCE);
  assert.equal(png.width, png.height, 'source must be square');
  assert.ok(png.width >= 1024, `source must be at least 1024px, got ${png.width}`);
});

test('Contents.json covers every macOS size Xcode expects', () => {
  const mac = contents.images
    .filter(image => image.idiom === 'mac')
    .map(image => `${image.size}@${image.scale}`)
    .sort();

  assert.deepEqual(mac, [
    '128x128@1x', '128x128@2x',
    '16x16@1x', '16x16@2x',
    '256x256@1x', '256x256@2x',
    '32x32@1x', '32x32@2x',
    '512x512@1x', '512x512@2x'
  ].sort());
});

test('Contents.json includes the 1024 icon iOS needs', () => {
  const ios = contents.images.find(image => image.platform === 'ios');
  assert.ok(ios, 'no iOS entry');
  assert.equal(ios.size, '1024x1024');
});

for (const image of contents.images) {
  const expected = Number(image.size.split('x')[0]) * Number((image.scale || '1x').replace('x', ''));

  test(`${image.filename} is ${expected}x${expected} and opaque`, () => {
    const file = path.join(ICONSET, image.filename);
    assert.ok(fs.existsSync(file), `${image.filename} is referenced but missing`);

    const png = readPng(file);
    assert.equal(png.width, expected, `${image.filename} should be ${expected}px wide`);
    assert.equal(png.height, expected, `${image.filename} should be ${expected}px tall`);

    // App Store submissions are rejected outright for an alpha channel.
    assert.ok(
      png.colorType === 0 || png.colorType === 2 || png.colorType === 3,
      `${image.filename} has an alpha channel (${COLOR_TYPE[png.colorType]}); ` +
      'App Store icons must be fully opaque'
    );
  });
}

test('the icon set has no files Contents.json does not reference', () => {
  const referenced = new Set(contents.images.map(image => image.filename));
  const onDisk = fs.readdirSync(ICONSET).filter(name => name.endsWith('.png'));
  const orphans = onDisk.filter(name => !referenced.has(name));
  assert.deepEqual(orphans, [], 'stale icons left in the set');
});

test('build.sh installs the icon set into the generated project', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'safari', 'build.sh'), 'utf8');
  assert.match(script, /AppIcon\.appiconset/,
    'build.sh must copy the icon set over the converter placeholder');
});
