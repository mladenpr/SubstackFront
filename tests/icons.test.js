'use strict';

// Every icon comes from icons/appicon-source.png via scripts/make-icons.py, and
// the generated sets are committed. Nothing at build time re-derives them, so
// these are the only checks between a bad regeneration and a shipped extension
// with a blank toolbar icon or an App Store rejection.
//
// The two sets have opposite requirements: toolbar icons need transparent
// corners so they sit on browser chrome, app icons must be fully opaque.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { REPO_ROOT } = require('./helpers/extension-stub.js');
const { readPng } = require('./helpers/png.js');

const SOURCE = path.join(REPO_ROOT, 'icons', 'appicon-source.png');
const ICONSET = path.join(REPO_ROOT, 'safari', 'appicon', 'AppIcon.appiconset');
const TOOLBAR_SIZES = [16, 48, 128];

const contents = JSON.parse(fs.readFileSync(path.join(ICONSET, 'Contents.json'), 'utf8'));

// The artwork's two colours.
const isOrange = ([r, g, b, a]) => a > 200 && r > 200 && g > 50 && g < 170 && b < 90;
const isWhite = ([r, g, b, a]) => a > 200 && r > 230 && g > 230 && b > 230;

test('the icon source is square and large enough for the App Store', () => {
  const png = readPng(SOURCE);
  assert.equal(png.width, png.height, 'source must be square');
  assert.ok(png.width >= 1024, `source must be at least 1024px, got ${png.width}`);
});

// --- Toolbar icons -------------------------------------------------------

for (const size of TOOLBAR_SIZES) {
  const file = path.join(REPO_ROOT, 'icons', `icon${size}.png`);

  test(`toolbar icon${size} is ${size}px with a rounded, transparent-cornered silhouette`, () => {
    const png = readPng(file);
    assert.equal(png.width, size);
    assert.equal(png.height, size);
    assert.ok(png.hasAlpha, `icon${size}.png needs an alpha channel to sit on browser chrome`);

    const [, , , cornerAlpha] = png.at(0, 0);
    assert.ok(cornerAlpha < 128, `icon${size}.png corner is opaque (alpha ${cornerAlpha}) - not rounded`);

    const [, , , centreAlpha] = png.at(size >> 1, size >> 1);
    assert.equal(centreAlpha, 255, `icon${size}.png centre should be opaque`);
  });

  test(`toolbar icon${size} carries the brand artwork`, () => {
    // Guards a real failure mode: a generator bug once repainted the orange
    // background white, leaving a blank icon that still had the right
    // dimensions, alpha channel and file type. Only the pixels give it away.
    const pixels = readPng(file).all();
    const orange = pixels.filter(isOrange).length;
    const white = pixels.filter(isWhite).length;

    assert.ok(orange > pixels.length * 0.15,
      `icon${size}.png is only ${Math.round(orange / pixels.length * 100)}% orange - artwork lost`);
    assert.ok(white > pixels.length * 0.05,
      `icon${size}.png is only ${Math.round(white / pixels.length * 100)}% white - mark lost`);
  });

}

test('toolbar icons stay small enough to ship', () => {
  for (const size of TOOLBAR_SIZES) {
    const bytes = fs.statSync(path.join(REPO_ROOT, 'icons', `icon${size}.png`)).size;
    assert.ok(bytes < 64 * 1024, `icon${size}.png is ${bytes} bytes - too large for a toolbar icon`);
  }
});

// --- App icon ------------------------------------------------------------

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

  test(`app icon ${image.filename} is ${expected}px and fully opaque`, () => {
    const file = path.join(ICONSET, image.filename);
    assert.ok(fs.existsSync(file), `${image.filename} is referenced but missing`);

    const png = readPng(file);
    assert.equal(png.width, expected);
    assert.equal(png.height, expected);

    // App Store submissions are rejected outright for an alpha channel.
    assert.ok(!png.hasAlpha,
      `${image.filename} is ${png.colorTypeName}; App Store icons must be fully opaque`);
  });
}

test('the app icon set has no files Contents.json does not reference', () => {
  const referenced = new Set(contents.images.map(image => image.filename));
  const onDisk = fs.readdirSync(ICONSET).filter(name => name.endsWith('.png'));
  assert.deepEqual(onDisk.filter(name => !referenced.has(name)), [],
    'stale icons left in the set');
});

test('build.sh installs the app icon set into the generated project', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'safari', 'build.sh'), 'utf8');
  assert.match(script, /AppIcon\.appiconset/,
    'build.sh must copy the icon set over the converter placeholder');
});

test('the generator is the single source for both sets', () => {
  const generator = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'make-icons.py'), 'utf8');
  assert.match(generator, /icons.*icon\{?16/s, 'make-icons.py should write the toolbar icons');
  assert.match(generator, /AppIcon\.appiconset/, 'make-icons.py should write the app icon set');
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'safari', 'make-appicon.py')),
    'safari/make-appicon.py was replaced by scripts/make-icons.py');
});
