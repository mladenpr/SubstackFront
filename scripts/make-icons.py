#!/usr/bin/env python3
"""Generate every icon in the repo from icons/appicon-source.png.

Two sets with different rules, because they live in different places:

  icons/icon{16,48,128}.png             Toolbar icons. Rounded with transparent
                                        corners so they sit on browser chrome
                                        rather than reading as a coloured tile.

  safari/appicon/AppIcon.appiconset/    The Mac wrapper app's icon. Full-bleed
                                        and fully opaque - the App Store rejects
                                        a submission whose icon has an alpha
                                        channel, and macOS 26 applies its own
                                        mask.

Both sets are committed, so no build needs an image library. Re-run this only
when the source artwork changes. It is the one script here wanting a
third-party package:

    pip install Pillow
    python3 scripts/make-icons.py

The artwork is drawn to survive downscaling, so every size is a straight
resize of the same source. An earlier revision had a dark inner arrow that
turned to mud below ~16px and needed a simplified small variant; if detail like
that ever comes back, that workaround is in the history.
"""

import json
import pathlib
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit('error: Pillow is required. Install it with: pip install Pillow')

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = REPO_ROOT / 'icons' / 'appicon-source.png'
TOOLBAR_DIR = REPO_ROOT / 'icons'
APPICON_DIR = REPO_ROOT / 'safari' / 'appicon' / 'AppIcon.appiconset'

# Rounded-rect radius as a fraction of the icon's width. Measured off the
# original toolbar icons so the silhouette in the browser chrome is unchanged.
CORNER_RADIUS = 17 / 128

TOOLBAR_SIZES = (16, 48, 128)
WORKING_SIZE = 512

# (filename, pixel size, size string, scale) for the macOS app icon.
MAC_ICONS = [
    ('icon_16x16.png', 16, '16x16', '1x'),
    ('icon_16x16@2x.png', 32, '16x16', '2x'),
    ('icon_32x32.png', 32, '32x32', '1x'),
    ('icon_32x32@2x.png', 64, '32x32', '2x'),
    ('icon_128x128.png', 128, '128x128', '1x'),
    ('icon_128x128@2x.png', 256, '128x128', '2x'),
    ('icon_256x256.png', 256, '256x256', '1x'),
    ('icon_256x256@2x.png', 512, '256x256', '2x'),
    ('icon_512x512.png', 512, '512x512', '1x'),
    ('icon_512x512@2x.png', 1024, '512x512', '2x'),
]
IOS_ICON = ('icon_1024.png', 1024)


def load_source():
    if not SOURCE.exists():
        sys.exit(f'error: {SOURCE.relative_to(REPO_ROOT)} not found')

    image = Image.open(SOURCE)
    if image.width != image.height:
        sys.exit(f'error: source must be square, got {image.width}x{image.height}')

    # Flatten onto white so any transparency becomes opaque rather than black.
    if image.mode in ('RGBA', 'LA', 'P'):
        image = image.convert('RGBA')
        flattened = Image.new('RGB', image.size, (255, 255, 255))
        flattened.paste(image, mask=image.split()[-1])
        return flattened
    return image.convert('RGB')


def round_corners(image):
    side = image.width
    mask = Image.new('L', (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, side - 1, side - 1], radius=round(side * CORNER_RADIUS), fill=255)
    out = image.convert('RGBA')
    out.putalpha(mask)
    return out


def write_toolbar_icons(source):
    art = round_corners(source.resize((WORKING_SIZE,) * 2, Image.LANCZOS))

    for size in TOOLBAR_SIZES:
        path = TOOLBAR_DIR / f'icon{size}.png'
        art.resize((size,) * 2, Image.LANCZOS).save(path, 'PNG', optimize=True)
        print(f'  {path.relative_to(REPO_ROOT)}  {size}x{size}')


def write_app_icon(source):
    APPICON_DIR.mkdir(parents=True, exist_ok=True)
    for stale in APPICON_DIR.glob('*.png'):
        stale.unlink()

    written = set()
    for filename, pixels in [(name, size) for name, size, *_ in MAC_ICONS] + [IOS_ICON]:
        if filename in written:
            continue
        if pixels > source.width:
            sys.exit(f'error: source is {source.width}px, too small for {pixels}px {filename}')
        # No alpha here: an App Store icon must be fully opaque.
        source.resize((pixels,) * 2, Image.LANCZOS).save(
            APPICON_DIR / filename, 'PNG', optimize=True)
        written.add(filename)

    images = [
        {'filename': filename, 'idiom': 'mac', 'scale': scale, 'size': size}
        for filename, _, size, scale in MAC_ICONS
    ]
    images.append({
        'filename': IOS_ICON[0],
        'idiom': 'universal',
        'platform': 'ios',
        'size': '1024x1024',
    })
    (APPICON_DIR / 'Contents.json').write_text(
        json.dumps({'images': images, 'info': {'author': 'xcode', 'version': 1}}, indent=2) + '\n')

    print(f'  {APPICON_DIR.relative_to(REPO_ROOT)}  {len(written)} icons + Contents.json')


def main():
    source = load_source()
    print(f'Source: {SOURCE.relative_to(REPO_ROOT)} ({source.width}x{source.height})')
    print('Toolbar icons:')
    write_toolbar_icons(source)
    print('App icon:')
    write_app_icon(source)


if __name__ == '__main__':
    main()
