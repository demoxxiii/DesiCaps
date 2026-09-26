"""DesiCaps Studio - local API + UI server (used by the desktop app, or run directly for development)."""
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import paths
import ae_export
import engine
import render as R

VERSION = "1.0.0"
PROJ = paths.PROJECTS
EXPORTS = paths.EXPORTS
PRESETS = json.load(open(paths.PRESETS_FILE, encoding="utf-8"))
CONFIG_PATH = paths.CONFIG
CONFIG = {"ollama_url": "http://127.0.0.1:11434", "ollama_model": "", "port": 7870}
if os.path.exists(CONFIG_PATH):
    try:
        CONFIG.update(json.load(open(CONFIG_PATH, encoding="utf-8")))
    except Exception:
        pass


def save_config():
    json.dump(CONFIG, open(CONFIG_PATH, "w", encoding="utf-8"), indent=1)


def ensure_dir(d):
    os.makedirs(d, exist_ok=True)
    return d

app = FastAPI(title="DesiCaps Studio")
JOBS = {}


# ---------------------------------------------------------------- helpers
def slug(s):
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", s).strip("_")
    return s[:40] or "video"


def pdir(pid):
    d = os.path.join(PROJ, os.path.basename(pid))
    if not os.path.isdir(d):
        raise HTTPException(404, "project not found")
    return d


def load(pid):
    return json.load(open(os.path.join(pdir(pid), "project.json"), encoding="utf-8"))


def save(p):
    path = os.path.join(pdir(p["id"]), "project.json")
    tmp = path + ".tmp"
    json.dump(p, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def default_style(preset="hormozi"):
    st = dict(PRESETS["base"])
    for p in PRESETS["presets"]:
        if p["id"] == preset:
            st.update(p["style"])
    return st


def new_project(video_path, name):
    info = R.probe(video_path)
    pid = time.strftime("%Y%m%d-%H%M%S-") + slug(name)
    os.makedirs(os.path.join(PROJ, pid), exist_ok=True)
    p = {"id": pid, "name": name, "video": os.path.abspath(video_path), **info,
         "style": default_style(), "preset": "hormozi", "words": [], "engine": "hinglish",
         "created": time.time()}
    save(p)
    return p


def start_job(kind, fn):
    jid = uuid.uuid4().hex[:10]
    JOBS[jid] = {"id": jid, "kind": kind, "progress": 0.0, "msg": "Starting", "done": False, "error": None,
                 "result": None}

    def prog(f, msg=None):
        JOBS[jid]["progress"] = round(float(f), 4)
        if msg:
            JOBS[jid]["msg"] = msg

    def run():
        try:
            JOBS[jid]["result"] = fn(prog)
        except Exception as e:
            traceback.print_exc()
            JOBS[jid]["error"] = str(e)
        JOBS[jid]["done"] = True

    threading.Thread(target=run, daemon=True).start()
    return JOBS[jid]


# ---------------------------------------------------------------- project API
@app.get("/api/presets")
def presets():
    return PRESETS


@app.get("/api/health")
def health():
    return {"raqm": engine.HAS_RAQM, "platform": sys.platform, "version": VERSION, "exports": EXPORTS,
            "frozen": paths.FROZEN}


@app.get("/api/engines")
def engines():
    import transcribe
    return transcribe.engine_status()


@app.post("/api/engines/{name}/download")
def download_engine(name: str):
    def work(prog):
        import transcribe
        transcribe.download_model(name, prog)
        return {"ok": True}
    return start_job("model", work)


@app.get("/api/projects")
def projects():
    out = []
    for d in sorted(os.listdir(PROJ), reverse=True):
        f = os.path.join(PROJ, d, "project.json")
        if os.path.exists(f):
            try:
                p = json.load(open(f, encoding="utf-8"))
                out.append({"id": p["id"], "name": p["name"], "words": len(p["words"]),
                            "duration": p.get("duration")})
            except Exception:
                pass
    return out


@app.post("/api/upload")
async def upload(file: UploadFile):
    name = os.path.splitext(os.path.basename(file.filename or "video"))[0]
    tmpdir = os.path.join(PROJ, "_incoming")
    os.makedirs(tmpdir, exist_ok=True)
    ext = os.path.splitext(file.filename or ".mp4")[1] or ".mp4"
    tmp = os.path.join(tmpdir, uuid.uuid4().hex + ext)
    with open(tmp, "wb") as f:
        while chunk := await file.read(8 << 20):
            f.write(chunk)
    p = new_project(tmp, name)
    dst = os.path.join(pdir(p["id"]), "source" + ext)
    shutil.move(tmp, dst)
    p["video"] = dst
    save(p)
    return p


@app.post("/api/open_path")
async def open_path(req: Request):
    """Use a video already on disk (no copy) - best for big files."""
    body = await req.json()
    path = body.get("path", "").strip().strip('"')
    if not os.path.isfile(path):
        raise HTTPException(400, "File not found: " + path)
    return new_project(path, os.path.splitext(os.path.basename(path))[0])


@app.get("/api/project/{pid}")
def get_project(pid: str):
    return load(pid)


@app.post("/api/project/{pid}")
async def put_project(pid: str, req: Request):
    body = await req.json()
    p = load(pid)
    for k in ("words", "style", "preset", "name", "engine", "vocab"):
        if k in body:
            p[k] = body[k]
    save(p)
    return {"ok": True}


@app.post("/api/project/{pid}/regroup")
async def regroup(pid: str, req: Request):
    body = await req.json()
    p = load(pid)
    p["words"] = engine.regroup(body.get("words", p["words"]), body.get("style", p["style"]))
    save(p)
    return {"words": p["words"]}


@app.post("/api/project/{pid}/proxy")
def make_proxy(pid: str):
    """Browser can't decode this codec (HEVC/ProRes/...) -> make a small H.264 preview copy."""
    p = load(pid)
    out = os.path.join(pdir(pid), "preview_proxy.mp4")
    if not os.path.exists(out):
        import subprocess
        base = [paths.ffmpeg(), "-y", "-v", "error", "-i", p["video"], "-vf", "scale=-2:'min(960,ih)'",
                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
        encn = R.pick_encoder()
        enc = ["-c:v", encn] + (["-crf", "28", "-preset", "veryfast"] if encn == "libx264" else [])
        subprocess.run(base + enc + [out], check=True, **paths.hidden_console())
    p["proxy"] = out
    save(p)
    return {"ok": True}


@app.get("/media/{pid}")
def media(pid: str, request: Request):
    """Video with HTTP range support so the browser can seek."""
    pj = load(pid)
    path = pj.get("proxy") if pj.get("proxy") and os.path.exists(pj["proxy"]) else pj["video"]
    size = os.path.getsize(path)
    ctype = "video/mp4" if not path.lower().endswith((".mov", ".webm", ".mkv")) else \
        {"mov": "video/quicktime", "webm": "video/webm", "mkv": "video/x-matroska"}[path.lower().rsplit(".", 1)[1]]
    rng = request.headers.get("range")
    if not rng:
        return FileResponse(path, media_type=ctype, headers={"Accept-Ranges": "bytes"})
    m = re.match(r"bytes=(\d*)-(\d*)", rng)
    start = int(m.group(1) or 0)
    end = int(m.group(2)) if m.group(2) else min(size - 1, start + (4 << 20))
    end = min(end, size - 1)

    def it():
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                b = f.read(min(1 << 20, left))
                if not b:
                    break
                left -= len(b)
                yield b

    return StreamingResponse(it(), status_code=206, media_type=ctype, headers={
        "Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1)})


# ---------------------------------------------------------------- jobs
@app.post("/api/project/{pid}/transcribe")
async def do_transcribe(pid: str, req: Request):
    body = await req.json()
    eng = body.get("engine", "hinglish")
    vocab = body.get("vocab", "")

    def work(prog):
        import transcribe
        words = transcribe.transcribe(load(pid)["video"], eng, progress=prog, vocab=vocab)
        p = load(pid)
        p["words"] = engine.regroup(words, p["style"])
        p["engine"] = eng
        p["vocab"] = vocab
        save(p)
        return {"words": len(words)}

    return start_job("transcribe", work)


@app.post("/api/project/{pid}/render")
async def do_render(pid: str):
    def work(prog):
        p = load(pid)
        out = os.path.join(ensure_dir(EXPORTS), f"{slug(p['name'])}_captioned_{time.strftime('%H%M%S')}.mp4")
        R.render(p, out, progress=lambda f: prog(f, "Rendering"))
        return {"path": out, "url": "/exports/" + os.path.basename(out)}

    return start_job("render", work)


@app.get("/api/job/{jid}")
def job(jid: str):
    if jid not in JOBS:
        raise HTTPException(404)
    return JOBS[jid]


@app.get("/exports/{name}")
def get_export(name: str):
    return FileResponse(os.path.join(EXPORTS, os.path.basename(name)))


@app.post("/api/project/{pid}/ae")
def do_ae(pid: str):
    p = load(pid)
    out = os.path.join(ensure_dir(EXPORTS), f"{slug(p['name'])}_AE_captions.jsx")
    ae_export.write_jsx(p, out, emoji_dir=engine.EMOJI_DIR)
    return {"path": out, "url": "/exports/" + os.path.basename(out)}


@app.get("/api/project/{pid}/srt")
def do_srt(pid: str):
    p = load(pid)
    out = os.path.join(ensure_dir(EXPORTS), f"{slug(p['name'])}.srt")
    open(out, "w", encoding="utf-8").write(R.to_srt(p))
    return {"path": out, "url": "/exports/" + os.path.basename(out)}


# ---------------------------------------------------------------- Premiere Pro panel
PREMIERE_OUT = os.path.join(EXPORTS, "Premiere")
UI_PENDING = {"open": None}


@app.post("/api/premiere/open")
async def premiere_open(req: Request):
    """Project for a media file on disk; reuses the newest project of the same file (keeps edits)."""
    body = await req.json()
    path = os.path.normpath(body.get("path", "").strip().strip('"'))
    if not os.path.isfile(path):
        raise HTTPException(400, "File not found: " + path)
    best = None
    if os.path.isdir(PROJ):
        for d in os.listdir(PROJ):
            f = os.path.join(PROJ, d, "project.json")
            try:
                p = json.load(open(f, encoding="utf-8"))
            except Exception:
                continue
            if os.path.normcase(os.path.normpath(p.get("video", ""))) == os.path.normcase(path):
                if best is None or p.get("created", 0) > best.get("created", 0):
                    best = p
    return best or new_project(path, os.path.splitext(os.path.basename(path))[0])


@app.post("/api/project/{pid}/premiere_overlay")
async def premiere_overlay(pid: str, req: Request):
    body = await req.json()
    W, H = int(body.get("width", 1080)), int(body.get("height", 1920))
    W, H = W - W % 2, H - H % 2
    fps = float(body.get("fps", 30) or 30)
    t0, t1 = float(body.get("t0", 0)), float(body.get("t1", 0))

    def work(prog):
        p = load(pid)
        if not p["words"]:
            raise RuntimeError("Transcribe the clip first.")
        end = t1 if t1 > t0 else max(w["end"] for w in p["words"]) + 1.0
        out = os.path.join(ensure_dir(PREMIERE_OUT),
                           f"{slug(p['name'])}_captions_{time.strftime('%H%M%S')}.mov")
        if engine.is_diff(p["style"]):   # negative text: white text layer for a Difference blend in Premiere
            dout = out[:-4] + "_NEGATIVE.mov"
            R.render_overlay(p, dout, W, H, fps, t0, end, layer="diff",
                             progress=lambda f: prog(f * 0.8, "Rendering negative text layer"))
            has_normal = any(w.get("emoji") for w in p["words"]) or p["style"].get("pageBg")
            if has_normal:
                R.render_overlay(p, out, W, H, fps, t0, end, progress=lambda f: prog(0.8 + f * 0.2, "Rendering emoji layer"))
            return {"path": out if has_normal else None, "diffPath": dout}
        R.render_overlay(p, out, W, H, fps, t0, end, progress=lambda f: prog(f, "Rendering caption layer"))
        return {"path": out}

    return start_job("premiere_overlay", work)


@app.post("/api/project/{pid}/premiere_srt")
async def premiere_srt(pid: str, req: Request):
    body = await req.json()
    p = load(pid)
    t0, t1 = float(body.get("t0", 0)), float(body.get("t1", 0)) or 1e9
    out = os.path.join(ensure_dir(PREMIERE_OUT), f"{slug(p['name'])}_{time.strftime('%H%M%S')}.srt")
    open(out, "w", encoding="utf-8").write(R.to_srt_range(p, t0, t1))
    return {"path": out}


@app.post("/api/ui/open")
async def ui_open(req: Request):
    """Ask the DesiCaps window to open a project (used by the Premiere panel's 'Edit words' button)."""
    UI_PENDING["open"] = (await req.json()).get("pid")
    return {"ok": True}


@app.get("/api/ui/pending")
def ui_pending():
    pid, UI_PENDING["open"] = UI_PENDING["open"], None
    return {"open": pid}


@app.post("/api/reveal")
async def reveal(req: Request):
    """Open the exports folder in Explorer/Finder."""
    body = await req.json()
    path = body.get("path") or ensure_dir(EXPORTS)
    import subprocess
    try:
        if paths.IS_WIN:
            subprocess.Popen(["explorer", "/select,", path] if os.path.isfile(path) else ["explorer", path])
        elif paths.IS_MAC:
            subprocess.Popen(["open", "-R", path] if os.path.isfile(path) else ["open", path])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(path) if os.path.isfile(path) else path])
    except Exception:
        pass
    return {"ok": True}


@app.post("/api/open_url")
async def open_url(req: Request):
    url = (await req.json()).get("url", "")
    if url.startswith("https://"):
        import webbrowser
        webbrowser.open(url)
    return {"ok": True}


@app.post("/api/install_fonts")
def install_fonts():
    """Install the caption fonts for this user so After Effects can use them."""
    done = []
    fonts = [f for f in os.listdir(paths.FONT_DIR) if f.lower().endswith(".ttf")]
    if paths.IS_WIN:
        import winreg
        dst = ensure_dir(os.path.join(os.environ["LOCALAPPDATA"], "Microsoft", "Windows", "Fonts"))
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows NT\CurrentVersion\Fonts")
        for f in fonts:
            target = os.path.join(dst, f)
            if not os.path.exists(target):
                shutil.copy2(os.path.join(paths.FONT_DIR, f), target)
            winreg.SetValueEx(key, os.path.splitext(f)[0] + " (TrueType)", 0, winreg.REG_SZ, target)
            done.append(f)
        try:  # tell running apps fonts changed
            import ctypes
            ctypes.windll.user32.SendMessageTimeoutW(0xFFFF, 0x001D, 0, 0, 0, 1000, None)
        except Exception:
            pass
    elif paths.IS_MAC:
        dst = ensure_dir(os.path.expanduser("~/Library/Fonts"))
        for f in fonts:
            shutil.copy2(os.path.join(paths.FONT_DIR, f), os.path.join(dst, f))
            done.append(f)
    return {"installed": done}


@app.post("/api/install_premiere")
def install_premiere():
    """Install the DesiCaps panel into Premiere Pro (CEP extension, current user)."""
    src = os.path.join(paths.RES, "premiere", "DesiCaps")
    if not os.path.isdir(src):
        raise HTTPException(500, "Panel files missing from this build")
    if paths.IS_WIN:
        base = os.path.join(os.environ["APPDATA"], "Adobe", "CEP", "extensions")
    else:
        base = os.path.expanduser("~/Library/Application Support/Adobe/CEP/extensions")
    dst = os.path.join(base, "DesiCaps")
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)
    # the panel isn't signed by Adobe's paid program: allow unsigned panels for this user
    for v in range(9, 14):
        try:
            if paths.IS_WIN:
                import winreg
                k = winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Adobe\CSXS.{v}")
                winreg.SetValueEx(k, "PlayerDebugMode", 0, winreg.REG_SZ, "1")
            else:
                import subprocess
                subprocess.run(["defaults", "write", f"com.adobe.CSXS.{v}", "PlayerDebugMode", "1"], check=False)
        except Exception:
            pass
    return {"path": dst}


# ---------------------------------------------------------------- AI enhance (local Ollama)
@app.get("/api/ollama/models")
def ollama_models():
    ensure_ollama()
    try:
        with urllib.request.urlopen(CONFIG["ollama_url"] + "/api/tags", timeout=3) as r:
            names = [m["name"] for m in json.load(r).get("models", [])]
    except Exception:
        return []
    pref = CONFIG.get("ollama_model")  # preferred model first
    names = [n for n in names if not any(k in n for k in ("embed", "whisper"))]
    return sorted(names, key=lambda n: (n != pref, n))


def _ollama_up():
    try:
        with urllib.request.urlopen(CONFIG["ollama_url"] + "/api/version", timeout=2):
            return True
    except Exception:
        return False


def ensure_ollama():
    """If Ollama is installed but not running, start it quietly (waits up to ~8 s)."""
    if _ollama_up():
        return True
    import subprocess
    try:
        if paths.IS_WIN:
            exe = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Ollama", "ollama.exe")
            exe = exe if os.path.isfile(exe) else shutil.which("ollama")
            if not exe:
                return False
            subprocess.Popen([exe, "serve"], **paths.hidden_console())
        elif paths.IS_MAC:
            if os.path.isdir("/Applications/Ollama.app"):
                subprocess.Popen(["open", "-g", "-a", "Ollama"])
            elif shutil.which("ollama"):
                subprocess.Popen([shutil.which("ollama"), "serve"])
            else:
                return False
        else:
            if not shutil.which("ollama"):
                return False
            subprocess.Popen(["ollama", "serve"])
    except Exception:
        return False
    for _ in range(16):
        time.sleep(0.5)
        if _ollama_up():
            return True
    return False


@app.get("/api/ollama/status")
def ollama_status():
    ensure_ollama()
    try:
        with urllib.request.urlopen(CONFIG["ollama_url"] + "/api/version", timeout=2) as r:
            ver = json.load(r).get("version")
        return {"running": True, "version": ver, "models": ollama_models(), "recommended": "gemma3:12b"}
    except Exception:
        return {"running": False, "models": [], "recommended": "gemma3:12b"}


@app.post("/api/ollama/pull")
async def ollama_pull(req: Request):
    model = (await req.json()).get("model") or "gemma3:12b"

    def work(prog):
        r = urllib.request.Request(CONFIG["ollama_url"] + "/api/pull", data=json.dumps({"model": model}).encode(),
                                   headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=3600) as resp:
            for line in resp:
                try:
                    j = json.loads(line)
                except Exception:
                    continue
                if j.get("error"):
                    raise RuntimeError(j["error"])
                tot, done = j.get("total") or 0, j.get("completed") or 0
                prog(done / tot if tot else 0.0, f"{j.get('status', '')} {done >> 20}/{tot >> 20} MB" if tot else j.get("status", ""))
        CONFIG["ollama_model"] = model
        save_config()
        return {"ok": True}

    return start_job("pull", work)


@app.post("/api/project/{pid}/enhance")
async def enhance(pid: str, req: Request):
    body = await req.json()
    model = body.get("model") or CONFIG["ollama_model"]

    def work(prog):
        import enhance as E
        p = load(pid)
        p["words"] = E.enhance(p["words"], CONFIG["ollama_url"], model, progress=prog,
                               fix_spelling=body.get("fix", False))
        save(p)
        return {"ok": True}

    return start_job("enhance", work)


@app.post("/api/project/{pid}/postkit")
async def postkit(pid: str, req: Request):
    body = await req.json()
    model = body.get("model") or CONFIG["ollama_model"]

    def work(prog):
        import social
        p = load(pid)
        kit = social.make_kit(p["words"], CONFIG["ollama_url"], model, progress=prog)
        p["postkit"] = kit
        save(p)
        out = os.path.join(ensure_dir(EXPORTS), f"{slug(p['name'])}_post_kit.txt")
        open(out, "w", encoding="utf-8").write(social.kit_to_text(kit))
        return {"kit": kit, "path": out}

    return start_job("postkit", work)


# ---------------------------------------------------------------- static
app.mount("/fonts", StaticFiles(directory=paths.FONT_DIR), name="fonts")


POPULAR_EMOJI = ['1f1ee-1f1f3', '1f381', '1f389', '1f3a5', '1f3af', '1f3b5', '1f3c6', '1f3e0', '1f440', '1f447', '1f449', '1f44d', '1f44f', '1f451', '1f480', '1f48e', '1f494', '1f4a1', '1f4a5', '1f4aa', '1f4af', '1f4b0', '1f4b5', '1f4b8', '1f4bb', '1f4c5', '1f4c8', '1f4c9', '1f4dd', '1f4e2', '1f4f1', '1f511', '1f512', '1f525', '1f602', '1f605', '1f609', '1f60a', '1f60d', '1f60e', '1f621', '1f62d', '1f631', '1f64c', '1f64f', '1f680', '1f697', '1f6a8', '1f6d1', '1f914', '1f91d', '1f923', '1f929', '1f92b', '1f92f', '1f973', '1f9e0', '23f0', '26a0', '26a1', '2705', '2708', '2728', '274c', '2753', '2757', '2764', '2b50']


@app.get("/api/emoji")
def emoji_list():
    return [c for c in POPULAR_EMOJI if engine.emoji_file(c)]


@app.get("/emoji/{code}.png")
def emoji(code: str):
    p = engine.emoji_file(code)
    if not p:
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "max-age=86400"})


app.mount("/", StaticFiles(directory=paths.STATIC_DIR, html=True), name="static")


def serve(port=None, host="127.0.0.1"):
    uvicorn.run(app, host=host, port=port or int(CONFIG.get("port", 7870)), log_level="warning", log_config=None)


if __name__ == "__main__":  # development:  python app/server.py  ->  http://127.0.0.1:7870
    import warnings
    warnings.filterwarnings("ignore")
    print(f"\n  DesiCaps Studio (dev) ->  http://127.0.0.1:{CONFIG.get('port', 7870)}\n")
    serve()
