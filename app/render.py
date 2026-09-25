"""Burn captions onto the video: Python draws caption frames, FFmpeg overlays + encodes (NVENC)."""
import json
import os
import subprocess
import sys

import engine
import paths

HC = paths.hidden_console()


def probe(path):
    """Width/height (after rotation), fps, duration of a video."""
    fp = paths.ffprobe()
    if fp:
        try:
            return _probe_ffprobe(fp, path)
        except Exception:
            pass
    return _probe_ffmpeg(path)


def _probe_ffprobe(fp, path):
    out = subprocess.run(
        [fp, "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate,avg_frame_rate:stream_side_data=rotation:stream_tags=rotate:format=duration",
         "-of", "json", path], capture_output=True, text=True, check=True, **HC).stdout
    j = json.loads(out)
    s = j["streams"][0]
    w, h = int(s["width"]), int(s["height"])
    rot = 0
    for sd in s.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    rot = rot or int(s.get("tags", {}).get("rotate", 0) or 0)
    if abs(rot) % 180 == 90:
        w, h = h, w
    num, den = (s.get("avg_frame_rate") or s.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    if not (1 <= fps <= 240):
        num, den = s.get("r_frame_rate", "30/1").split("/")
        fps = float(num) / float(den)
    return {"width": w, "height": h, "fps": round(fps, 3), "duration": float(j["format"]["duration"])}


def _probe_ffmpeg(path):
    """No ffprobe available: parse `ffmpeg -i` banner."""
    import re
    err = subprocess.run([paths.ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True,
                         errors="ignore", **HC).stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0
    v = re.search(r"Stream #.*Video: .*?(\d{2,5})x(\d{2,5})", err)
    w, h = (int(v.group(1)), int(v.group(2))) if v else (1080, 1920)
    f = re.search(r"([\d.]+) fps", err) or re.search(r"([\d.]+) tbr", err)
    fps = float(f.group(1)) if f else 30.0
    r = re.search(r"rotate\s*:\s*(-?\d+)", err) or re.search(r"rotation of (-?[\d.]+)", err)
    if r and abs(int(float(r.group(1)))) % 180 == 90:
        w, h = h, w
    return {"width": w, "height": h, "fps": round(fps, 3), "duration": dur}


_ENC = {}


def has_encoder(name):
    if name not in _ENC:
        try:
            r = subprocess.run([paths.ffmpeg(), "-hide_banner", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1",
                                "-c:v", name, "-f", "null", "-"], capture_output=True, timeout=20, **HC)
            _ENC[name] = r.returncode == 0
        except Exception:
            _ENC[name] = False
    return _ENC[name]


def pick_encoder():
    for name in (["h264_videotoolbox"] if paths.IS_MAC else ["h264_nvenc", "h264_amf", "h264_qsv"]):
        if has_encoder(name):
            return name
    return "libx264"


ENC_ARGS = {
    "h264_nvenc": ["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0"],
    "h264_amf": ["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20"],
    "h264_qsv": ["-preset", "slow", "-global_quality", "20"],
    "h264_videotoolbox": ["-q:v", "70", "-allow_sw", "1"],
    "libx264": ["-preset", "medium", "-crf", "18"],
}


def render(project, out_path, progress=None, encoder=None):
    """Render project -> MP4. progress(fraction) is called periodically."""
    info = probe(project["video"])
    W, H, fps, dur = info["width"], info["height"], info["fps"], info["duration"]
    oy, bh = engine.compute_band(project, W, H)
    pgs = engine.pages(project["words"])
    nframes = int(dur * fps)
    encoder = encoder or pick_encoder()
    venc = ["-c:v", encoder] + ENC_ARGS.get(encoder, [])
    cmd = [paths.ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
           "-i", project["video"],
           "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{bh}", "-r", str(fps), "-i", "-",
           "-filter_complex", f"[0:v][1:v]overlay=0:{oy}:eof_action=pass:format=auto,format=yuv420p[v]",
           "-map", "[v]", "-map", "0:a?", *venc, "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", out_path]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, **HC)
    blank = bytes(W * bh * 4)
    last_key, last_bytes = None, blank
    try:
        for n in range(nframes):
            t = n / fps
            key = engine.frame_state(project, t, pgs)
            if key is None:
                buf = blank
            elif key == last_key:
                buf = last_bytes
            else:
                im = engine.draw_frame(project, t, W, H, pgs, oy=oy, bh=bh)
                buf = im.tobytes() if im is not None else blank
            last_key, last_bytes = key, buf
            proc.stdin.write(buf)
            if progress and n % 15 == 0:
                progress(n / max(1, nframes))
        proc.stdin.close()
    except BrokenPipeError:
        pass
    err = proc.stderr.read().decode(errors="ignore")
    rc = proc.wait()
    if rc != 0:
        if encoder != "libx264":  # hardware encoder failed mid-way: retry on CPU
            return render(project, out_path, progress, encoder="libx264")
        raise RuntimeError("ffmpeg failed: " + err[-1500:])
    if progress:
        progress(1.0)
    return out_path


def still(project, t, out_png):
    """Composite one frame of video + captions to a PNG (for thumbnails / QA)."""
    info = probe(project["video"])
    W, H = info["width"], info["height"]
    subprocess.run([paths.ffmpeg(), "-y", "-loglevel", "error", "-ss", str(t), "-i", project["video"],
                    "-frames:v", "1", out_png], check=True, **HC)
    from PIL import Image
    bg = Image.open(out_png).convert("RGBA").resize((W, H))
    cap = engine.draw_frame(project, t, W, H)
    if cap is not None:
        bg.alpha_composite(cap)
    bg.convert("RGB").save(out_png)
    return out_png


def to_srt(project):
    def ts(x):
        ms = int(round(x * 1000))
        return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"
    words, style = project["words"], dict(project["style"], uppercase=False)
    lines = []
    for n, p in enumerate(engine.pages(words), 1):
        text = " ".join(engine.display_text(words[i], style) for i in range(p["i0"], p["i1"] + 1))
        lines.append(f"{n}\n{ts(p['start'])} --> {ts(p['end'])}\n{text}\n")
    return "\n".join(lines)


if __name__ == "__main__":
    proj = json.load(open(sys.argv[1], encoding="utf-8"))
    render(proj, sys.argv[2], progress=lambda f: print(f"\r{f*100:5.1f}%", end="", flush=True))
    print("\ndone", sys.argv[2])
