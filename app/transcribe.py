"""Offline transcription with whisper.cpp (GPU via Vulkan on Windows / Metal on Mac, CPU fallback).

Default engine: Oriserve/Whisper-Hindi2Hinglish-Apex (Apache-2.0) converted to ggml - it writes
Hindi speech directly in Roman script (Hinglish).
"""
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.request

import paths

HC = paths.hidden_console()

ENGINES = {
    "hinglish": {"file": "ggml-hinglish-apex-q5_0.bin", "language": "en",
                 "label": "Hinglish (Roman)", "size_mb": 575, "url": None},  # bundled with the app
    "devanagari": {"file": "ggml-large-v3-turbo-q5_0.bin", "language": "hi",
                   "label": "Hindi (Devanagari)", "size_mb": 574,
                   "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"},
    "english": {"file": "ggml-large-v3-turbo-q5_0.bin", "language": "en",
                "label": "English", "size_mb": 574,
                "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"},
}

_lock = threading.Lock()
_working_cli = None  # remembered after the first successful run


def engine_status():
    out = {}
    for k, e in ENGINES.items():
        out[k] = {"label": e["label"], "ready": bool(paths.model_path(e["file"])),
                  "downloadable": bool(e["url"]), "size_mb": e["size_mb"]}
    return out


def download_model(engine, progress=None):
    e = ENGINES[engine]
    if paths.model_path(e["file"]):
        return paths.model_path(e["file"])
    if not e["url"]:
        raise RuntimeError("This model ships with the app - please reinstall DesiCaps.")
    dst = os.path.join(paths.USER_MODELS, e["file"])
    tmp = dst + ".part"
    req = urllib.request.Request(e["url"], headers={"User-Agent": "DesiCaps"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
            got += len(b)
            if progress and total:
                progress(got / total, f"Downloading model {got >> 20} / {total >> 20} MB")
    os.replace(tmp, dst)
    return dst


def cli_candidates():
    """GPU build first, then CPU build."""
    names = ["whisper-cli-gpu", "whisper-cli"]
    return [p for p in (paths.tool(n) for n in names) if p]


def extract_wav(video, wav):
    subprocess.run([paths.ffmpeg(), "-nostdin", "-y", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", wav], check=True, capture_output=True, **HC)


def audio_seconds(wav):
    return max(0.0, (os.path.getsize(wav) - 44) / 32000.0)


def _run_cli(cli, model, wav, lang, outbase, progress, dur, use_gpu=True, dtw=True):
    cmd = [cli, "-m", model, "-f", wav, "-l", lang, "-ojf", "-of", outbase, "-pp",
           "-t", str(max(2, min(8, (os.cpu_count() or 4)))), "-sns"]
    if dtw:  # DTW token timing needs flash-attention off
        cmd += ["--dtw", "large.v3.turbo", "-nfa"]
    if not use_gpu:
        cmd += ["-ng"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="ignore", **HC)
    log = []
    for line in p.stdout:
        log.append(line)
        m = re.search(r"progress\s*=\s*(\d+)%", line)
        if m and progress:
            progress(0.1 + 0.85 * min(100, int(m.group(1))) / 100, "Transcribing")
    rc = p.wait()
    return rc, "".join(log[-40:])


def transcribe(video_path, engine="hinglish", progress=None, vocab=""):
    """-> list of {text, start, end} word dicts (seconds)."""
    global _working_cli
    e = ENGINES[engine]
    progress = progress or (lambda f, msg="": None)
    model = paths.model_path(e["file"])
    if not model:
        progress(0.01, "Downloading model (one time)")
        model = download_model(engine, lambda f, m: progress(0.01 + 0.05 * f, m))
    clis = cli_candidates()
    if not clis:
        raise RuntimeError("whisper-cli not found in the app's bin folder")
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "audio.wav")
        progress(0.05, "Extracting audio")
        extract_wav(video_path, wav)
        dur = audio_seconds(wav)
        outbase = os.path.join(td, "out")
        attempts = []
        order = [_working_cli] if _working_cli else []
        for cli in clis:
            order += [(cli, True, True), (cli, True, False), (cli, False, True), (cli, False, False)]
        seen, last = set(), ""
        with _lock:
            for att in order:
                if not att or att in seen:
                    continue
                seen.add(att)
                cli, gpu, dtw = att
                t0 = time.time()
                rc, last = _run_cli(cli, model, wav, e["language"], outbase, progress, dur, gpu, dtw)
                attempts.append((os.path.basename(cli), gpu, dtw, rc, round(time.time() - t0, 1)))
                if rc == 0 and os.path.exists(outbase + ".json"):
                    _working_cli = att
                    break
            else:
                raise RuntimeError(f"Transcription failed {attempts}: {last[-600:]}")
        print("[transcribe]", attempts)
        with open(outbase + ".json", encoding="utf-8", errors="ignore") as f:
            data = json.load(f)
    words = words_from_whisper_json(data)
    words = collapse_loops(words)
    if vocab:
        words = apply_vocab(words, vocab)
    progress(0.98, "Tidying timings")
    return fix_timings(words, dur)


# ---------------------------------------------------------------- parsing whisper.cpp -ojf output
_SPECIAL = re.compile(r"^\[_|^<\||^\[\w+\]$")


def words_from_whisper_json(data):
    """Build words from token-level timestamps (prefers DTW times when present)."""
    words = []
    cur = None
    for seg in data.get("transcription", []):
        for tok in seg.get("tokens", []):
            txt = tok.get("text", "")
            if not txt or _SPECIAL.match(txt.strip()):
                continue
            off = tok.get("offsets")
            prev_end = cur["end"] if cur else (words[-1]["end"] if words else seg.get("offsets", {}).get("from", 0) / 1000.0)
            if off:
                t0, t1 = off.get("from", 0) / 1000.0, off.get("to", 0) / 1000.0
            else:
                t0 = t1 = prev_end
            dtw = tok.get("t_dtw", -1)
            if isinstance(dtw, (int, float)) and dtw >= 0:
                t0 = dtw / 100.0
            if txt.startswith(" ") or cur is None:
                if cur and cur["text"].strip():
                    words.append(cur)
                cur = {"text": txt.strip(), "start": t0, "end": max(t1, t0)}
            else:
                cur["text"] += txt
                cur["end"] = max(cur["end"], t1)
        # segment boundary also ends a word
        if cur and cur["text"].strip():
            words.append(cur)
        cur = None
    # DTW times mark word onsets - end each word where the next one starts (if close)
    for a, b in zip(words, words[1:]):
        if 0 < b["start"] - a["start"] < 2.0:
            a["end"] = min(max(a["end"], a["start"] + 0.08), b["start"])
    return [w for w in words if w["text"]]


def fix_timings(words, total):
    """Monotonic, non-overlapping, minimum-length word timings."""
    import math
    out = []
    for w in words:
        s, e = float(w["start"]), float(w["end"])
        if not w["text"].strip() or math.isnan(s) or (total and s >= total - 0.02):
            continue
        if math.isnan(e) or e < s:
            e = s + 0.25
        s = max(0.0, s)
        if out and s < out[-1]["start"] + 0.04:
            s = out[-1]["start"] + 0.04
        e = max(e, s + 0.08)
        if out and out[-1]["end"] > s:
            out[-1]["end"] = s
        out.append({"text": w["text"], "start": round(s, 3), "end": round(min(e, total) if total else e, 3)})
    return out


def collapse_loops(words, max_repeat=3):
    """Whisper sometimes loops on one word ('kya kya kya ...') - keep at most max_repeat."""
    out = []
    for w in words:
        k = len(out)
        if k >= max_repeat and all(o["text"].lower() == w["text"].lower() for o in out[k - max_repeat:]):
            out[-1]["end"] = max(out[-1]["end"], w["end"])
            continue
        out.append(w)
    return out


def _norm(t):
    return re.sub(r"[^\w]", "", t.lower())


def apply_vocab(words, vocab):
    """Fix near-miss spellings of names you listed: 'GTS 6' -> 'GTA 6' when vocab has 'GTA 6'."""
    import difflib
    terms = [t.strip() for t in re.split(r"[,\n;]", vocab) if t.strip()]
    for term in terms:
        tw = term.split()
        n, target = len(tw), _norm("".join(tw))
        if len(target) < 3:
            continue
        for i in range(len(words) - n + 1):
            window = words[i:i + n]
            cand = _norm("".join(w["text"] for w in window))
            if not cand or cand == target or cand[0] != target[0]:
                continue
            if difflib.SequenceMatcher(None, cand, target).ratio() >= 0.66:
                for w, new in zip(window, tw):
                    trail = re.search(r"[.,!?।]+$", w["text"])
                    w["text"] = new + (trail.group(0) if trail else "")
    return words


if __name__ == "__main__":  # CLI test:  python app/transcribe.py video.mp4 [hinglish|devanagari|english]
    import sys
    ws = transcribe(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "hinglish",
                    progress=lambda f, m="": print(f"{f*100:5.1f}%  {m}"))
    print(" ".join(w["text"] for w in ws))
