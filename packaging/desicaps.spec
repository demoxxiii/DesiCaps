# PyInstaller spec for DesiCaps Studio (Windows + macOS).  Build:  pyinstaller packaging/desicaps.spec
# Expects (filled by CI or scripts/fetch_deps.py):
#   bin/     whisper-cli[-gpu][.exe], ffmpeg[.exe], ffprobe[.exe], (Windows) fribidi-0.dll
#   models/  ggml-hinglish-apex-q5_0.bin
#   assets/  fonts/, emoji/
import os
import sys

from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform.startswith("win")
VERSION = os.environ.get("APP_VERSION", "1.0.0")


def tree(src, dst):
    out = []
    base = os.path.join(ROOT, src)
    for root, _, files in os.walk(base):
        for f in files:
            if f.startswith(".") or f.endswith((".pyc", ".part")):
                continue
            rel = os.path.relpath(root, base)
            out.append((os.path.join(root, f), os.path.normpath(os.path.join(dst, rel))))
    return out


datas = []
datas += tree("app/static", "app/static")
datas += [(os.path.join(ROOT, "app", "presets.json"), "app")]
datas += tree("assets", "assets")
datas += tree("models", "models")
binaries = [(p, "bin") for p, _ in tree("bin", "bin")]

hidden = []
hidden += collect_submodules("uvicorn")
hidden += ["server", "engine", "render", "transcribe", "ae_export", "enhance", "social", "paths"]
if not IS_WIN:
    try:
        import imageio_ffmpeg  # noqa
        from PyInstaller.utils.hooks import collect_data_files
        datas += collect_data_files("imageio_ffmpeg")
        hidden += ["imageio_ffmpeg"]
    except Exception:
        pass

a = Analysis(
    [os.path.join(ROOT, "app", "desktop.py")],
    pathex=[os.path.join(ROOT, "app")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    excludes=["tkinter", "matplotlib", "torch", "transformers", "IPython", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

icon = os.path.join(ROOT, "packaging", "icon.icns" if IS_MAC else "icon.ico")

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="DesiCaps",
    console=False,
    icon=icon,
    target_arch="arm64" if IS_MAC else None,
    codesign_identity=None,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="DesiCaps", upx=False)

if IS_MAC:
    app = BUNDLE(
        coll,
        name="DesiCaps.app",
        icon=icon,
        bundle_identifier="app.desicaps.studio",
        version=VERSION,
        info_plist={
            "CFBundleName": "DesiCaps",
            "CFBundleDisplayName": "DesiCaps Studio",
            "CFBundleShortVersionString": VERSION,
            "CFBundleVersion": VERSION,
            "LSMinimumSystemVersion": "12.0",
            "NSHighResolutionCapable": True,
            "LSApplicationCategoryType": "public.app-category.video",
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        },
    )
