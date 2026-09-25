"""Where things live, for both the dev checkout and the packaged (PyInstaller) desktop app."""
import os
import shutil
import sys

FROZEN = getattr(sys, "frozen", False)
# read-only resources: the repo root in dev, the unpacked bundle when frozen
RES = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_DIR = os.path.join(RES, "app")
STATIC_DIR = os.path.join(APP_DIR, "static")
PRESETS_FILE = os.path.join(APP_DIR, "presets.json")
FONT_DIR = os.path.join(RES, "assets", "fonts")
EMOJI_DIR = os.path.join(RES, "assets", "emoji")
BIN_DIR = os.path.join(RES, "bin")
BUNDLED_MODELS = os.path.join(RES, "models")

IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"
EXE = ".exe" if IS_WIN else ""


def _user_data():
    if IS_WIN:
        base = os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
    elif IS_MAC:
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(base, "DesiCaps")


def _videos():
    home = os.path.expanduser("~")
    for name in ("Movies", "Videos") if IS_MAC else ("Videos", "Movies"):
        if os.path.isdir(os.path.join(home, name)):
            return os.path.join(home, name, "DesiCaps")
    return os.path.join(home, "DesiCaps")


# in dev mode keep everything inside the repo so it's easy to inspect
DATA = _user_data() if FROZEN else os.path.join(RES, ".userdata")
PROJECTS = os.path.join(DATA, "projects")
LOGS = os.path.join(DATA, "logs")
USER_MODELS = os.path.join(DATA, "models")
EMOJI_CACHE = os.path.join(DATA, "emoji")
CONFIG = os.path.join(DATA, "config.json")
EXPORTS = _videos() if FROZEN else os.path.join(RES, "exports")

for _d in (DATA, PROJECTS, LOGS, USER_MODELS, EMOJI_CACHE):
    os.makedirs(_d, exist_ok=True)


def tool(name):
    """Full path of a bundled tool (ffmpeg, ffprobe, whisper-cli...) or None."""
    p = os.path.join(BIN_DIR, name + EXE)
    if os.path.isfile(p):
        return p
    return shutil.which(name)


def ffmpeg():
    p = tool("ffmpeg")
    if p:
        return p
    try:  # pip wheel fallback (dev / Mac)
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise RuntimeError("FFmpeg not found")


def ffprobe():
    return tool("ffprobe")


def model_path(filename):
    for d in (USER_MODELS, BUNDLED_MODELS):
        p = os.path.join(d, filename)
        if os.path.isfile(p):
            return p
    return None


def hidden_console():
    """subprocess kwargs so no black console windows flash up on Windows."""
    if IS_WIN:
        import subprocess
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        return {"startupinfo": si, "creationflags": 0x08000000}  # CREATE_NO_WINDOW
    return {}
