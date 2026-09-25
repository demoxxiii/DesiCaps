"""CI helper (Windows): fetch fribidi-0.dll so Pillow can shape Devanagari (raqm) in rendered videos.
usage: python scripts/get_fribidi.py <bin dir>

Pillow's Windows wheels ship raqm but load FriBiDi at runtime. We pull the DLL from the
conda-forge 'fribidi' package (LGPL-2.1) into bin/, which engine.py adds to the DLL path.
"""
import io
import json
import os
import sys
import tarfile
import urllib.request
import zipfile

BIN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin")


def have():
    return os.path.exists(os.path.join(BIN, "fribidi-0.dll"))


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "DesiCaps"}), timeout=60) as r:
        return r.read()


def extract_dll(blob, name):
    """Return {filename: bytes} of DLLs inside a conda .tar.bz2 or .conda package."""
    found = {}
    if name.endswith(".tar.bz2"):
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:bz2") as t:
            for m in t.getmembers():
                if m.name.lower().endswith(".dll"):
                    found[os.path.basename(m.name)] = t.extractfile(m).read()
    else:  # .conda = zip containing pkg-*.tar.zst
        import zstandard
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            for n in z.namelist():
                if n.startswith("pkg-") and n.endswith(".tar.zst"):
                    raw = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(z.read(n)))
                    with tarfile.open(fileobj=raw, mode="r|") as t:
                        for m in t:
                            if m.name.lower().endswith(".dll"):
                                found[os.path.basename(m.name)] = t.extractfile(m).read()
    return found


def main():
    if not sys.platform.startswith("win"):
        print("   fribidi: not needed on this OS")
        return 0
    if have():
        print("   fribidi: already installed")
        return 0
    os.makedirs(BIN, exist_ok=True)
    try:
        files = json.loads(fetch("https://api.anaconda.org/package/conda-forge/fribidi/files"))
        wins = [f for f in files if f.get("attrs", {}).get("subdir") == "win-64"]
        wins.sort(key=lambda f: (f.get("version", ""), f.get("upload_time", "")), reverse=True)
        for f in wins:
            url = f["download_url"]
            url = "https:" + url if url.startswith("//") else url
            dlls = extract_dll(fetch(url), f["basename"])
            if any(k.lower().startswith("fribidi") for k in dlls):
                for k, v in dlls.items():
                    open(os.path.join(BIN, k), "wb").write(v)
                if not have():  # normalise the name Pillow looks for
                    src = next(k for k in dlls if k.lower().startswith("fribidi"))
                    open(os.path.join(BIN, "fribidi-0.dll"), "wb").write(dlls[src])
                print("   fribidi: installed from", f["basename"])
                return 0
    except Exception as e:
        print("   fribidi: download failed (Devanagari in MP4 renders may look broken):", e)
        return 1
    print("   fribidi: no Windows build found")
    return 1


if __name__ == "__main__":
    sys.exit(main())
