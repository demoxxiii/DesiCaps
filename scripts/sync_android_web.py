"""Copy the shared caption engine, presets, fonts, emoji and logo into the Android app's web assets.
Run before building the Android app (CI does this automatically)."""
import glob
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WWW = os.path.join(ROOT, "android", "app", "src", "main", "assets", "www")


def main():
    os.makedirs(os.path.join(WWW, "fonts"), exist_ok=True)
    os.makedirs(os.path.join(WWW, "emoji"), exist_ok=True)
    shutil.copy(os.path.join(ROOT, "app", "static", "engine.js"), WWW)
    shutil.copy(os.path.join(ROOT, "app", "presets.json"), WWW)
    shutil.copy(os.path.join(ROOT, "packaging", "icon.png"), os.path.join(WWW, "icon.png"))
    n = 0
    for f in glob.glob(os.path.join(ROOT, "assets", "fonts", "*.ttf")):
        shutil.copy(f, os.path.join(WWW, "fonts")); n += 1
    for f in glob.glob(os.path.join(ROOT, "assets", "emoji", "*.png")):
        shutil.copy(f, os.path.join(WWW, "emoji")); n += 1
    print("synced", n, "fonts/emoji into", WWW)


if __name__ == "__main__":
    main()
