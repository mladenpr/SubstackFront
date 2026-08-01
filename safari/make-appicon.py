#!/usr/bin/env python3
"""Generate the app icon set for the Safari wrapper app.

Reads icons/appicon-source.png and writes safari/appicon/AppIcon.appiconset/,
which safari/build.sh copies into the generated Xcode project.

The output is committed, so this only needs re-running when the source artwork
changes. It is the one script here that needs a third-party package:

    pip install Pillow
    python3 safari/make-appicon.py

App Store icons must be fully opaque - a submission with an alpha channel is
rejected - so every image is flattened to RGB on the way out.
"""

import json
import pathlib
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('error: Pillow is required. Install it with: pip install Pillow')

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = REPO_ROOT / 'icons' / 'appicon-source.png'
OUTPUT = REPO_ROOT / 'safari' / 'appicon' / 'AppIcon.appiconset'

# (filename, pixel size, idiom, size string, scale)
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

# iOS uses a single 1024 icon and applies its own mask.
IOS_ICON = ('icon_1024.png', 1024)


def main():
    if not SOURCE.exists():
        sys.exit(f'error: {SOURCE.relative_to(REPO_ROOT)} not found')

    source = Image.open(SOURCE)
    if source.width != source.height:
        sys.exit(f'error: source must be square, got {source.width}x{source.height}')

    # Flatten onto white so any transparency becomes opaque rather than black.
    if source.mode in ('RGBA', 'LA', 'P'):
        source = source.convert('RGBA')
        flattened = Image.new('RGB', source.size, (255, 255, 255))
        flattened.paste(source, mask=source.split()[-1])
        source = flattened
    else:
        source = source.convert('RGB')

    OUTPUT.mkdir(parents=True, exist_ok=True)
    for stale in OUTPUT.glob('*.png'):
        stale.unlink()

    written = {}
    for filename, pixels in [(name, size) for name, size, *_ in MAC_ICONS] + [IOS_ICON]:
        if filename in written:
            continue
        if pixels > source.width:
            sys.exit(f'error: source is {source.width}px, too small for {pixels}px {filename}')
        resized = source.resize((pixels, pixels), Image.LANCZOS)
        resized.save(OUTPUT / filename, 'PNG', optimize=True)
        written[filename] = pixels

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

    contents = {'images': images, 'info': {'author': 'xcode', 'version': 1}}
    (OUTPUT / 'Contents.json').write_text(json.dumps(contents, indent=2) + '\n')

    print(f'Wrote {len(written)} icons to {OUTPUT.relative_to(REPO_ROOT)}')
    for filename, pixels in sorted(written.items(), key=lambda item: item[1]):
        print(f'  {filename:<22} {pixels}x{pixels}')


if __name__ == '__main__':
    main()
