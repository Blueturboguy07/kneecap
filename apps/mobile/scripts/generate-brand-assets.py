#!/usr/bin/env python3
"""Make every kneecap icon and splash image from ONE file: apps/mobile/brand/icon.svg.

To change the icon: edit or replace brand/icon.svg, run this script, commit the result.
Needs: rsvg-convert (brew install librsvg) and Pillow (pip install pillow).

    python3 apps/mobile/scripts/generate-brand-assets.py

Writes:
  iOS      ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png  1024 x 1024, no alpha (App Store rule)
           ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732*.png  black, the icon in the middle
  Android  res/mipmap-*/ic_launcher.png, ic_launcher_round.png               legacy icons
           res/mipmap-*/ic_launcher_foreground.png                           adaptive icon: the mark only
           res/values/ic_launcher_background.xml                             adaptive icon: the background colour
           res/drawable*/splash.png                                          black, the icon in the middle

brand/icon.svg must keep a full-size <rect id="background"> with a solid fill, and the mark in <g id="mark">.
"""
import io
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

MOBILE = Path(__file__).resolve().parent.parent
SOURCE = MOBILE / "brand" / "icon.svg"
IOS_ASSETS = MOBILE / "ios" / "App" / "App" / "Assets.xcassets"
ANDROID_RES = MOBILE / "android" / "app" / "src" / "main" / "res"
SPLASH_BACKGROUND = (0, 0, 0)  # the app's own background (app-root.css), so the splash hands over without a flash
ADAPTIVE_MARK_SCALE = 0.72  # keeps the mark inside the adaptive icon's 66 dp safe circle

DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}
ANDROID_SPLASH = {  # the sizes Capacitor's template uses
    "drawable": (480, 320),
    "drawable-port-mdpi": (320, 480), "drawable-port-hdpi": (480, 800), "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600), "drawable-port-xxxhdpi": (1280, 1920),
    "drawable-land-mdpi": (480, 320), "drawable-land-hdpi": (800, 480), "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960), "drawable-land-xxxhdpi": (1920, 1280),
}


def render(svg: str, size: int) -> Image.Image:
    png = subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), "-f", "png"],
        input=svg.encode(), capture_output=True, check=True,
    ).stdout
    return Image.open(io.BytesIO(png)).convert("RGBA")


def without_background(svg: str, scale: float = 1.0) -> str:
    svg = re.sub(r'<rect id="background"[^>]*/>', "", svg)
    if scale != 1.0:
        svg = svg.replace('<g id="mark"', f'<g transform="translate(512 512) scale({scale}) translate(-512 -512)"><g id="mark"', 1)
        svg = svg.replace("</svg>", "</g></svg>")
    return svg


def masked(img: Image.Image, shape: str) -> Image.Image:
    size = img.size[0]
    mask = Image.new("L", (size * 4, size * 4), 0)
    draw = ImageDraw.Draw(mask)
    if shape == "circle":
        draw.ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    else:  # rounded square, close to the iOS icon shape
        draw.rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=int(size * 4 * 0.2237), fill=255)
    out = img.copy()
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def splash(icon: Image.Image, width: int, height: int, icon_size: int) -> Image.Image:
    canvas = Image.new("RGB", (width, height), SPLASH_BACKGROUND)
    tile = masked(icon.resize((icon_size, icon_size), Image.LANCZOS), "rounded")
    canvas.paste(tile, ((width - icon_size) // 2, (height - icon_size) // 2), tile)
    return canvas


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"wrote {path.relative_to(MOBILE)} ({img.size[0]}x{img.size[1]}, {img.mode})")


def main() -> None:
    svg = re.sub(r"<!--.*?-->", "", SOURCE.read_text(), flags=re.S)  # the notes in the file are not part of the picture
    color = re.search(r'<rect id="background"[^>]*fill="(#[0-9A-Fa-f]{6})"', svg)
    if not color or '<g id="mark"' not in svg:
        raise SystemExit('brand/icon.svg needs <rect id="background" ... fill="#RRGGBB"/> and <g id="mark">.')

    master = render(svg, 1024)
    # iOS: one 1024 icon; Xcode makes the other sizes. RGB: the App Store refuses an icon with alpha.
    save(master.convert("RGB"), IOS_ASSETS / "AppIcon.appiconset" / "AppIcon-512@2x.png")
    ios_splash = splash(master, 2732, 2732, 400)
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        save(ios_splash, IOS_ASSETS / "Splash.imageset" / name)

    foreground_svg = without_background(svg, ADAPTIVE_MARK_SCALE)
    for density, factor in DENSITIES.items():
        legacy = round(48 * factor)
        save(masked(render(svg, legacy), "rounded"), ANDROID_RES / f"mipmap-{density}" / "ic_launcher.png")
        save(masked(render(svg, legacy), "circle"), ANDROID_RES / f"mipmap-{density}" / "ic_launcher_round.png")
        save(render(foreground_svg, round(108 * factor)), ANDROID_RES / f"mipmap-{density}" / "ic_launcher_foreground.png")
    (ANDROID_RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- Generated by apps/mobile/scripts/generate-brand-assets.py from brand/icon.svg. -->\n"
        "<resources>\n"
        f'    <color name="ic_launcher_background">{color.group(1).upper()}</color>\n'
        "</resources>\n"
    )
    print("wrote android/app/src/main/res/values/ic_launcher_background.xml")
    for folder, (width, height) in ANDROID_SPLASH.items():
        save(splash(master, width, height, round(min(width, height) * 0.3)), ANDROID_RES / folder / "splash.png")


if __name__ == "__main__":
    main()
