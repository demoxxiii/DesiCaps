"""CI helper: put the full Twemoji 72x72 PNG set (CC-BY 4.0) into assets/emoji so emoji work offline."""
import io
import os
import sys
import urllib.request
import zipfile

URL = "https://github.com/jdecked/twemoji/archive/refs/heads/main.zip"
dst = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "assets", "emoji")
os.makedirs(dst, exist_ok=True)
data = urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": "DesiCaps"}), timeout=300).read()
n = 0
with zipfile.ZipFile(io.BytesIO(data)) as z:
    for name in z.namelist():
        if "/assets/72x72/" in name and name.endswith(".png"):
            with open(os.path.join(dst, os.path.basename(name)), "wb") as f:
                f.write(z.read(name))
            n += 1
print("twemoji:", n, "png files ->", dst)
